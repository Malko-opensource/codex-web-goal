import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture } from './helpers.js';
import { serve } from '../src/http.js';

test('real MCP transport initializes, exposes only workspace tools and protects local control', async t => {
  const f = await fixture();
  const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const publicUrl = `http://127.0.0.1:${servers.mcpPort}`, privateUrl = `http://127.0.0.1:${servers.controlPort}`;
  const client = new Client({ name: 'fixture', version: '1' });
  t.after(async () => { await client.close(); await servers.close(); await f.cleanup(); });
  assert.deepEqual(await (await fetch(publicUrl + '/health')).json(), { ok: true, version: '0.1.1' });
  assert.equal((await fetch(publicUrl + '/api/status')).status, 404);
  assert.equal((await fetch(privateUrl + '/api/status')).status, 401);
  assert.equal((await fetch(privateUrl + '/api/status', { headers: { authorization: `Bearer ${f.store.state.controlToken}`, origin: 'https://evil.example' } })).status, 403);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp/${f.store.state.mcpToken}`)));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('workspace_edit')); assert.ok(!names.includes('web_goal_dispatch'));
  const result = await client.callTool({ name: 'workspace_write', arguments: { operation_id: randomUUID(), path: 'hello.txt', expected_sha256: 'absent', content: 'hello' } });
  assert.ok(!result.isError); assert.equal((await f.workspace.read('hello.txt')).content, 'hello');
  const denied = await client.callTool({ name: 'workspace_read', arguments: { path: '../secret.txt' } }); assert.equal(denied.isError, true);
  assert.equal((await fetch(`${publicUrl}/mcp/${f.store.state.mcpToken}`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).status, 403);
});

test('extension requires one-time pairing and authenticated WebSocket before binding', async t => {
  const f = await fixture();
  const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const base = `http://127.0.0.1:${servers.controlPort}`, origin = `chrome-extension://${'a'.repeat(32)}`;
  let ws: WebSocket | undefined;
  t.after(async () => { ws?.terminate(); await servers.close(); await f.cleanup(); });
  const { code } = await f.bridge.pairCode();
  const pair = (code: string) => fetch(base + '/api/pair', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  assert.equal((await pair('wrong')).status, 401);
  const response = await pair(code); assert.equal(response.status, 200); const data = await response.json() as { token: string };
  assert.equal((await pair(code)).status, 401);
  ws = new WebSocket(base.replace('http:', 'ws:') + '/extension', { origin }); await once(ws, 'open');
  const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'auth', token: data.token })); assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
  const bound = once(ws, 'message'); ws.send(JSON.stringify({ type: 'bind', url: 'https://chatgpt.com/c/test-chat', tabId: 1 }));
  assert.equal(JSON.parse(String((await bound)[0])).type, 'bound'); assert.equal(f.bridge.state.chat?.url, 'https://chatgpt.com/c/test-chat');
});
