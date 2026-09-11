import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { fixture, eventually } from './helpers.js';
import { FakeHost } from './execution-helpers.js';
import { Bridge } from '../src/bridge.js';
import { executionPolicySchema, type ContextDetails } from '../src/execution-contract.js';
import { DelegationResources } from '../src/delegation-resources.js';
import { serve } from '../src/http.js';
import { mcpServer, controlTools } from '../src/tools.js';
import { Store } from '../src/store.js';

const code = (expected: string) => (e: unknown) => (e as { code: string }).code === expected;
const policy = (kind: 'answer' | 'files' = 'answer') => executionPolicySchema.parse({ mode: 'web-controlled', network: 'public-internet', resultKind: kind, expectedFiles: kind === 'files' ? ['result.md'] : [] });
async function setup(kind: 'answer' | 'files' = 'answer', resources = new DelegationResources(), details?: Partial<ContextDetails>) {
  const f = await fixture(); await f.bridge.shutdown(); f.native.thread.goal = null;
  const host = new FakeHost(), bridge = new Bridge(f.store, f.workspace, f.native, { host, resources }); await bridge.recover();
  await bridge.bind('https://chatgpt.com/c/fixture-chat', 1);
  const sent: unknown[] = []; bridge.conversation = { surface: 'chrome-extension', send: m => sent.push(m), close() {} };
  await bridge.open('task', f.native.thread.id, policy(kind), { requestId: 'original-request', inputVersion: 1, objective: 'Analyze this request without creating a Goal' });
  await bridge.dispatch({ requestId: 'delegation-one', task: 'Return a useful result', context: 'Selected history only', criteria: 'Preserve requested scope', contextDetails: details as ContextDetails });
  await eventually(() => bridge.turn!.status === 'dispatching');
  const turn = bridge.turn!, token = turn.token, versions = { contextVersion: turn.contextEnvelope!.version, policyVersion: 1 };
  await bridge.workerContext(token, turn.contextEnvelope!.digest);
  return { ...f, bridge, host, turn, token, versions, sent, cleanup: async () => { await bridge.shutdown(); await f.cleanup(); } };
}

test('ordinary answer delegation needs no Goal, no files and no runner; returns to exact original request', async t => {
  const f = await setup(); t.after(f.cleanup);
  assert.equal(f.native.thread.goal, null); assert.equal(f.host.lease!.goalFingerprint, undefined);
  assert.deepEqual(f.host.lease!.origin, { requestId: 'original-request', inputVersion: 1 });
  await assert.rejects(f.bridge.mutate({ operationId: randomUUID(), path: 'result.md', expectedHash: 'absent', content: 'bad', turnToken: f.token, ...f.versions }), code('READ_ONLY_RESULT'));
  await assert.rejects(f.bridge.execution.request({ kind: 'exec', requestId: 'exec', argv: ['true'], turnToken: f.token, ...f.versions }), code('EXECUTION_NOT_GRANTED'));
  await f.bridge.pump(); assert.equal(f.host.modelRequests, 0);
  await f.bridge.workerFinish(f.token, 'Analysis with limitations', { ...f.versions, evidence: ['Selected source reviewed'], unresolved: ['A user decision remains'] });
  assert.equal(f.turn.result!.kind, 'answer'); assert.equal(f.turn.verifiedRunId, undefined);
  assert.equal(f.bridge.turnView(f.turn).progress.validation, 'result_captured');
  await f.bridge.pump(); await f.bridge.pump(); assert.equal(f.host.modelRequests, 1);
  const event = Object.values(f.store.state.wakeEvents)[0]!;
  assert.deepEqual(event.result!.unresolved, ['A user decision remains']); assert.equal(event.binding.threadId, f.native.thread.id);
  assert.equal(f.native.thread.goal, null); assert.equal(f.sent.filter((m: any) => m.type === 'dispatch').length, 1);
  await fs.writeFile(path.join(f.root, 'later.md'), 'changed after the wake');
  const reread = await controlTools(f.bridge).find(t => t.name === 'delegation_result')!.execute({ turn_id: f.turn.id }) as { stale: boolean };
  assert.equal(reread.stale, true);
});

test('ordinary requests fail closed on old hosts and reject a superseded input generation', async t => {
  const f = await setup(); t.after(f.cleanup);
  f.host.lease!.origin!.inputVersion = 2;
  await assert.rejects(f.bridge.workerFinish(f.token, 'late', f.versions), code('HOST_LEASE_REVOKED'));
  await f.bridge.pump(); assert.equal(f.bridge.session!.status, 'paused'); assert.equal(f.host.modelRequests, 0);
  await f.bridge.control('close');
  f.host.capabilities = async () => ({ protocol: 1, externalWait: true, durableWakeReceipts: true, userInputInvalidation: true, ordinaryRequests: false, localAssistance: false });
  await assert.rejects(f.bridge.open('task', undefined, policy(), { requestId: 'two', inputVersion: 2, objective: 'new' }), code('HOST_REQUEST_UNSUPPORTED'));
});

test('file-only delegation requires all expected files but does not invent execution validation', async t => {
  const f = await setup('files'); t.after(f.cleanup);
  await assert.rejects(f.bridge.workerFinish(f.token, 'missing files', f.versions));
  await f.bridge.mutate({ operationId: randomUUID(), path: 'result.md', expectedHash: 'absent', content: 'Useful document', turnToken: f.token, ...f.versions });
  await f.bridge.workerFinish(f.token, 'Document ready', f.versions);
  assert.equal(f.turn.result!.artifacts[0]!.sha256, (await f.workspace.read('result.md')).sha256);
  assert.equal(f.turn.checkpoint!.checks.length, 0); assert.equal(f.turn.result!.kind, 'files');
  assert.equal(executionPolicySchema.safeParse({ mode: 'web-controlled', network: 'public-internet' }).success, false);
});

test('local assistance suspends Web, wakes once and requires a fresh context to resume', async t => {
  const f = await setup(); t.after(f.cleanup);
  const request = await f.bridge.delegation.requestLocal(f.token, f.versions, 'help-one', 'Use a host-only feature', 'Unavailable to Web');
  const same = await f.bridge.delegation.requestLocal(f.token, f.versions, 'help-one', 'Use a host-only feature', 'Unavailable to Web');
  assert.equal(same.id, request.id);
  await assert.rejects(f.bridge.workerFinish(f.token, 'cannot finish during handoff', f.versions), code('EXECUTION_REVOKED'));
  await f.bridge.pump(); await f.bridge.pump(); assert.equal(f.host.modelRequests, 1);
  const result = await f.bridge.delegation.resolveLocal(request.id, 'resolved', 'Host feature produced the selected evidence');
  assert.equal(result.status, 'resolved'); assert.equal(f.turn.token, ''); assert.equal(f.bridge.session!.status, 'paused');
  await f.bridge.control('resume');
  await f.bridge.dispatch({ requestId: 'delegation-two', task: 'Continue using host evidence', context: result.summary!, criteria: 'Same original scope' });
  await eventually(() => f.bridge.turn!.status === 'dispatching');
  assert.equal(f.bridge.turn!.contextEnvelope!.version, 2);
  await assert.rejects(f.bridge.workerContext(f.token), code('LEASE_REVOKED'));
  assert.equal(f.native.thread.goal, null);
});

test('user cancellation invalidates a pending local handoff and its late return', async t => {
  const f = await setup(); t.after(f.cleanup);
  const request = await f.bridge.delegation.requestLocal(f.token, f.versions, 'help', 'Need local judgment', 'Scope question');
  await f.bridge.control('pause'); await f.bridge.pump();
  await assert.rejects(f.bridge.delegation.resolveLocal(request.id, 'resolved', 'late'), code('ASSISTANCE_STALE'));
  assert.equal(f.host.modelRequests, 0); assert.equal(request.status, 'revoked');
});

test('selected skill/image resources use pinned hashes, bounded reads and actual MCP image content', async t => {
  const assetFixture = await fixture(); t.after(assetFixture.cleanup);
  const root = await fs.realpath(assetFixture.directory), skill = path.join(root, 'skill'); await fs.mkdir(skill);
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'Read references, not an execution grant.');
  await fs.writeFile(path.join(skill, 'ref.md'), 'selected reference');
  const image = path.join(root, 'image.png');
  await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9kAAAAASUVORK5CYII=', 'base64'));
  const resources = await DelegationResources.create({ resources: [{ id: 'skill', kind: 'skill', root: skill, files: ['SKILL.md', 'ref.md'], description: 'selected skill' }, { id: 'picture', kind: 'image', path: image, description: 'synthetic pixel' }], capabilities: [] });
  const f = await setup('answer', resources, { resourceIds: ['skill', 'picture'] }); t.after(f.cleanup);
  const read = await f.bridge.delegation.readResource(f.token, f.versions, 'skill', undefined, 0, 4); assert.equal('text' in read && read.text, 'Read');
  await assert.rejects(f.bridge.delegation.readResource(f.token, f.versions, 'not-selected'), code('RESOURCE_NOT_GRANTED'));
  await assert.rejects(f.bridge.delegation.readResource(f.token, f.versions, 'skill', '../outside'), code('RESOURCE_FILE'));
  const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
  const client = new Client({ name: 'image-consumer-fixture', version: '1' }); t.after(async () => { await client.close(); await servers.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${servers.mcpPort}/mcp/${f.store.state.mcpToken}`)));
  const response = await client.callTool({ name: 'worker_resource_read', arguments: { turn_token: f.token, context_version: 1, policy_version: 1, resource_id: 'picture' } });
  assert.equal(response.isError, undefined);
  const content = response.content as { type: string; mimeType?: string }[];
  assert.equal(content[1]!.type, 'image'); assert.equal(content[1]!.mimeType, 'image/png');
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'changed');
  await assert.rejects(f.bridge.delegation.readResource(f.token, f.versions, 'skill'), code('RESOURCE_STALE'));
});

test('approved MCP relay executes only the configured tool once; remote callers cannot approve', async t => {
  let effects = 0;
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let bytes = ''; for await (const chunk of req) bytes += chunk;
    const server = mcpServer([{ name: 'selected', description: 'synthetic service', schema: z.object({ value: z.string() }), readOnly: false, execute: async args => { effects++; return args; } }], 'fixture-service');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close(); void transport.close(); });
    await server.connect(transport); await transport.handleRequest(req, res, JSON.parse(bytes));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const resources = await DelegationResources.create({ resources: [], capabilities: [{ id: 'chosen', tool: 'selected', description: 'explicit upstream tool', url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`, headerEnv: {} }] });
  const f = await setup('answer', resources, { capabilityIds: ['chosen'] }); t.after(f.cleanup);
  const call = await f.bridge.delegation.requestCapability(f.token, f.versions, 'call-one', 'chosen', { value: 'approved payload' });
  assert.equal(effects, 0); assert.equal(call.status, 'pending');
  const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') }); t.after(servers.close);
  assert.equal((await fetch(`http://127.0.0.1:${servers.controlPort}/api/capability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: call.id, allow: true }) })).status, 401);
  assert.ok(!controlTools(f.bridge).some(tool => /approve|decide/.test(tool.name)));
  const approval = await fetch(`http://127.0.0.1:${servers.controlPort}/api/capability`, { method: 'POST', headers: { authorization: `Bearer ${f.store.state.controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: call.id, allow: true }) });
  assert.equal(approval.status, 200);
  await eventually(() => f.store.state.capabilityCalls[call.id]!.status === 'done');
  assert.equal(effects, 1); assert.match(f.store.state.capabilityCalls[call.id]!.output!, /approved payload/);
  assert.equal((await f.bridge.delegation.requestCapability(f.token, f.versions, 'call-one', 'chosen', { value: 'approved payload' })).id, call.id);
  assert.equal(effects, 1); assert.equal(f.host.modelRequests, 0);
  await assert.rejects(f.bridge.delegation.requestCapability(f.token, f.versions, 'call-two', 'unknown-tool', {}), code('CAPABILITY_NOT_GRANTED'));
});

test('version 2 migration preserves existing execution state and backs up before adding shared records', async t => {
  const f = await fixture(); t.after(f.cleanup); await f.bridge.shutdown();
  const old = { ...f.store.state, version: 2, localAssists: undefined, capabilityCalls: undefined };
  await fs.writeFile(path.join(f.store.directory, 'state.json'), JSON.stringify(old));
  const store = new Store(f.store.directory); await store.open(f.root);
  assert.equal(store.state.version, 3); assert.deepEqual(store.state.runs, old.runs);
  const backup = (await fs.readdir(f.store.directory)).find(name => name.startsWith('state-v2-'))!;
  assert.ok(backup); assert.equal(JSON.parse(await fs.readFile(path.join(f.store.directory, backup), 'utf8')).version, 2);
  assert.equal(store.state.activeSession, undefined);
});

test('MCP lost outcome remains uncertain and can be escalated without replay', async t => {
  const resources = await DelegationResources.create({ resources: [], capabilities: [{ id: 'unavailable', tool: 'effect', description: 'synthetic unavailable transport', url: 'http://127.0.0.1:1/mcp', headerEnv: {} }] });
  const f = await setup('answer', resources, { capabilityIds: ['unavailable'] }); t.after(f.cleanup);
  const request = await f.bridge.delegation.requestCapability(f.token, f.versions, 'same-call', 'unavailable', {});
  await f.bridge.delegation.decideCapability(request.id, true);
  await eventually(() => f.store.state.capabilityCalls[request.id]!.status === 'uncertain');
  assert.equal((await f.bridge.delegation.requestCapability(f.token, f.versions, 'same-call', 'unavailable', {})).status, 'uncertain');
  await assert.rejects(f.bridge.workerFinish(f.token, 'not complete', f.versions), code('EFFECT_PENDING'));
  await f.bridge.workerFinish(f.token, 'Reconcile the configured service; do not retry', { ...f.versions, outcome: 'blocked' });
  await f.bridge.pump(); assert.equal(f.host.modelRequests, 1); assert.equal(f.turn.result, undefined);
  assert.equal(Object.values(f.store.state.wakeEvents)[0]!.kind, 'needs_attention');
});

test('resource registration rejects linked files and changes never silently renew a grant', async t => {
  const f = await fixture(); t.after(f.cleanup); const root = await fs.realpath(f.directory);
  const target = path.join(root, 'source'); await fs.writeFile(target, 'a skill');
  const linked = path.join(root, 'SKILL.md'); await fs.symlink(target, linked);
  await assert.rejects(DelegationResources.create({ resources: [{ id: 'unsafe', kind: 'skill', root, files: ['SKILL.md'], description: 'linked' }], capabilities: [] }), code('RESOURCE_PATH'));
});
