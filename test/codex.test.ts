import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexClient } from '../src/codex.js';

test('sidecar reads native goal with current JSON-RPC and reconnects without changing goals', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const methods: string[] = [];
  const workspace = path.resolve('fixture');
  server.on('connection', ws => ws.on('message', bytes => {
    const request = JSON.parse(String(bytes)); methods.push(request.method);
    if (request.id === undefined) return;
    const result = request.method === 'initialize' ? { userAgent: 'fixture' } : request.method === 'thread/loaded/list' ? { data: ['thread-1'], nextCursor: null } :
      request.method === 'thread/read' ? { thread: { id: 'thread-1', cwd: workspace, status: { type: 'active' } } } :
      { goal: { threadId: 'thread-1', objective: 'Finish', status: 'active', createdAt: 1 } };
    ws.send(JSON.stringify({ id: request.id, result }));
  }));
  const client = new CodexClient(`ws://127.0.0.1:${address.port}`);
  t.after(async () => { client.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal((await client.candidates(workspace))[0]?.goal?.objective, 'Finish');
  assert.deepEqual(await client.candidates(path.resolve('other-fixture')), []);
  const socket = [...server.clients][0]!; const closed = once(socket, 'close'); socket.close(); await closed;
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await client.inspect('thread-1')).loaded, true);
  assert.ok(methods.every(method => ['initialize', 'initialized', 'thread/read', 'thread/goal/get', 'thread/loaded/list'].includes(method)));
  assert.equal(methods.filter(method => method === 'initialize').length, 2);
});
