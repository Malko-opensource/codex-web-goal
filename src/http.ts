import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Bridge, type BrowserEvent } from './bridge.js';
import { controlTools, remoteTools, mcpServer } from './tools.js';
import { BridgeError, VERSION, requireThat, equalSecret, errorInfo } from './shared.js';

function send(res: ServerResponse, code: number, value: unknown) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; requireThat(bytes <= 3 * 1024 * 1024, 'BODY_LIMIT', 'Request body too large.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new BridgeError('JSON', 'Invalid JSON.', 400); }
}
function bearer(req: IncomingMessage) { return req.headers.authorization?.replace(/^Bearer /, '') ?? ''; }
const browserEvent = z.object({ type: z.enum(['submitted', 'answer', 'uncertain', 'not_submitted', 'blocked']), turnId: z.string().uuid(), response: z.string().max(150_000).optional(), reason: z.string().max(2000).optional(), generation: z.string().uuid().optional() }).strict();
const listen = (server: Server, port: number) => new Promise<number>((resolve, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', () => { const address = server.address(); resolve(typeof address === 'object' && address ? address.port : port); });
});

export async function serve(bridge: Bridge, options: { mcpPort: number; controlPort: number; uiDirectory: string }) {
  const tools = controlTools(bridge);
  const publicServer = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/health') { send(res, 200, { ok: true, version: VERSION }); return; }
      requireThat(!req.headers.origin || req.headers.origin === 'https://chatgpt.com', 'ORIGIN', 'Origin not allowed.', 403);
      const match = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(pathname);
      requireThat(match && equalSecret(match[1]!, bridge.state.mcpToken), 'NOT_FOUND', 'Not found.', 404);
      requireThat(req.method === 'POST', 'METHOD', 'Use Streamable HTTP POST.', 405);
      const parsed = await body(req);
      const server = mcpServer(remoteTools(bridge), 'codex-web-goal-workspace');
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport); await transport.handleRequest(req, res, parsed);
    } catch (error) { send(res, error instanceof BridgeError ? error.http : 400, { error: errorInfo(error) }); }
  });
  let controlPort = options.controlPort;
  const pairAttempts: number[] = [];
  const privateServer = createServer(async (req, res) => {
    try {
      const expectedOrigin = `http://127.0.0.1:${controlPort}`;
      requireThat(req.headers.host === `127.0.0.1:${controlPort}` || req.headers.host === `localhost:${controlPort}`, 'HOST', 'Invalid local Host.', 403);
      const pathname = new URL(req.url ?? '/', expectedOrigin).pathname;
      const origin = req.headers.origin;
      if (pathname === '/api/pair' && req.method === 'POST') {
        requireThat(origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin), 'ORIGIN', 'Pair from the Chrome extension.', 403);
        while (pairAttempts[0] && pairAttempts[0] < Date.now() - 60_000) pairAttempts.shift();
        requireThat(pairAttempts.length < 10, 'RATE_LIMIT', 'Wait a minute before retrying pairing.', 429); pairAttempts.push(Date.now());
        const input = z.object({ code: z.string().max(100) }).strict().parse(await body(req));
        send(res, 200, await bridge.pair(input.code, origin.replace('chrome-extension://', ''))); return;
      }
      if (pathname.startsWith('/api/')) {
        requireThat(!origin || origin === expectedOrigin || origin === `http://localhost:${controlPort}`, 'ORIGIN', 'Local dashboard only.', 403);
        requireThat(equalSecret(bearer(req), bridge.state.controlToken), 'AUTH', 'Open the dashboard URL printed by the CLI.', 401);
        if (pathname === '/api/status' && req.method === 'GET') { send(res, 200, bridge.view()); return; }
        requireThat(req.method === 'POST', 'METHOD', 'POST required.', 405);
        const input = await body(req);
        if (pathname === '/api/pair-code') { send(res, 200, await bridge.pairCode()); return; }
        if (pathname === '/api/connector') { send(res, 200, { path: `/mcp/${bridge.state.mcpToken}` }); return; }
        if (pathname === '/api/command') {
          const parsed = z.object({ id: z.string().uuid(), allow: z.boolean() }).strict().parse(input);
          send(res, 200, await bridge.approveCommand(parsed.id, parsed.allow)); return;
        }
        if (pathname === '/api/capability') {
          const parsed = z.object({ id: z.string().uuid(), allow: z.boolean() }).strict().parse(input);
          send(res, 200, await bridge.delegation.decideCapability(parsed.id, parsed.allow)); return;
        }
        if (pathname === '/api/command-stop') {
          const parsed = z.object({ id: z.string().uuid() }).strict().parse(input); bridge.kill(parsed.id); send(res, 200, { ok: true }); return;
        }
        const spec = tools.find(t => pathname === `/api/tools/${t.name}`);
        requireThat(spec, 'NOT_FOUND', 'Unknown control tool.', 404);
        send(res, 200, await spec.execute(input)); return;
      }
      const resources: Record<string, { file: string; mime: string }> = {
        '/': { file: 'index.html', mime: 'text/html' }, '/app.js': { file: 'app.js', mime: 'text/javascript' }, '/style.css': { file: 'style.css', mime: 'text/css' }
      };
      const resource = resources[pathname]; requireThat(resource && req.method === 'GET', 'NOT_FOUND', 'Not found.', 404);
      res.writeHead(200, { 'content-type': resource.mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(await fs.readFile(path.join(options.uiDirectory, resource.file)));
    } catch (error) { send(res, error instanceof BridgeError ? error.http : 400, { error: errorInfo(error) }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  privateServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (req.url !== '/extension' || req.headers.host !== `127.0.0.1:${controlPort}` || origin !== `chrome-extension://${bridge.state.extension?.id}`) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    let authenticated = false;
    const authTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    socket.on('error', () => {});
    const connection = { surface: 'chrome-extension' as const, send: (data: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }, close: () => socket.close() };
    socket.on('message', async bytes => {
      try {
        const message: unknown = JSON.parse(bytes.toString());
        if (!authenticated) {
          const auth = z.object({ type: z.literal('auth'), token: z.string() }).strict().parse(message);
          requireThat(bridge.state.extension && equalSecret(auth.token, bridge.state.extension.secret), 'AUTH', 'Invalid extension token.');
          authenticated = true; clearTimeout(authTimeout); bridge.conversation?.close(); bridge.conversation = connection;
          connection.send({ type: 'ready', chat: bridge.state.chat }); await bridge.pump(true); return;
        }
        requireThat(bridge.conversation === connection, 'STALE_CONNECTION', 'This extension connection was replaced.');
        const kind = (message as { type?: string }).type;
        if (kind === 'heartbeat') { connection.send({ type: 'heartbeat' }); return; }
        if (kind === 'bind') {
          const bind = z.object({ type: z.literal('bind'), url: z.string().max(2000), tabId: z.number().int() }).strict().parse(message);
          await bridge.bind(bind.url, bind.tabId); connection.send({ type: 'bound', chat: bridge.state.chat }); await bridge.pump(true); return;
        }
        await bridge.browserEvent(browserEvent.parse(message) as BrowserEvent);
      } catch (error) { connection.send({ type: 'error', ...errorInfo(error) }); if (!authenticated) socket.close(1008); }
    });
    socket.on('close', () => { clearTimeout(authTimeout); if (bridge.conversation === connection) bridge.conversation = undefined; });
  });
  const mcpPort = await listen(publicServer, options.mcpPort);
  try { controlPort = await listen(privateServer, options.controlPort); }
  catch (error) { publicServer.close(); throw error; }
  return { mcpPort, controlPort, async close() {
    for (const client of wss.clients) client.terminate(); wss.close();
    publicServer.closeAllConnections(); privateServer.closeAllConnections();
    await Promise.all([new Promise<void>(r => publicServer.close(() => r())), new Promise<void>(r => privateServer.close(() => r()))]);
  } };
}
