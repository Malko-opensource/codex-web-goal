import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { SocketDelegationHost } from '../src/delegation-host.js';
import type { HostBinding } from '../src/execution-contract.js';

test('host adapter validates private socket, exact binding and protocol capabilities', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp('/tmp/wg-host-'); const socketPath = path.join(directory, 'host.sock');
  let wrongBinding = false;
  const server = createServer(async (request, response) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const input = JSON.parse(bytes);
    const result = request.url?.endsWith('/capabilities') ? { protocol: 1, externalWait: true, durableWakeReceipts: true, userInputInvalidation: true } : { ...input, turnId: wrongBinding ? 'different' : input.turnId, leaseId: 'lease', state: 'waiting_external', expiresAt: Date.now() + 60_000 };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.chmod(socketPath, 0o600);
  const adapter = new SocketDelegationHost(socketPath);
  assert.equal((await adapter.capabilities()).externalWait, true);
  const binding: HostBinding = { sessionId: 's', turnId: 't', threadId: 'native', goalFingerprint: 'g', contextVersion: 1, policyVersion: 1 };
  assert.equal((await adapter.park(binding)).state, 'waiting_external');
  const ordinary: HostBinding = { ...binding, goalFingerprint: undefined, origin: { requestId: 'request', inputVersion: 2 } };
  assert.deepEqual((await adapter.park(ordinary)).origin, ordinary.origin);
  wrongBinding = true; await assert.rejects(adapter.park(binding), (error: unknown) => (error as { code: string }).code === 'HOST_BINDING');
  await fs.chmod(socketPath, 0o666); await assert.rejects(adapter.capabilities(), (error: unknown) => (error as { code: string }).code === 'HOST_SOCKET');
});
