import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, startTurn, eventually } from './helpers.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { hash } from '../src/shared.js';

const create = (content = 'export const add = (a,b) => a+b;') => ({ operationId: randomUUID(), path: 'math.js', expectedHash: 'absent', content });
const code = (expected: string) => (error: unknown) => (error as { code: string }).code === expected;

test('direct edits: SHA concurrency, durable replay, backup, exact replacement and delete', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const input = create(); const first = await f.bridge.mutate(input);
  assert.equal((await f.bridge.mutate(input)).sha256, first.sha256);
  await assert.rejects(f.bridge.mutate({ ...input, content: 'other' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.bridge.mutate(create('stale')), code('FILE_CHANGED'));
  const edited = await f.bridge.mutate({ operationId: randomUUID(), path: 'math.js', expectedHash: first.sha256, edits: [{ oldText: 'a+b', newText: 'Number(a)+Number(b)' }] });
  assert.equal(await fs.readFile(path.join(f.store.directory, 'backups', edited.backup!), 'utf8'), input.content);
  await assert.rejects(f.bridge.mutate({ operationId: randomUUID(), path: 'math.js', expectedHash: edited.sha256, edits: [{ oldText: 'absent', newText: '' }] }), code('EDIT_AMBIGUOUS'));
  await f.bridge.mutate({ operationId: randomUUID(), path: 'math.js', expectedHash: edited.sha256, delete: true });
  assert.equal((await f.workspace.current('math.js')).sha256, 'absent');
});

test('workspace boundary rejects traversal, secret files, links, binary and instruction writes', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const file of ['../outside', '.env', '.git/config', '.codex/config.toml', 'secrets/key.pem']) await assert.rejects(f.workspace.read(file));
  await assert.rejects(f.bridge.mutate({ ...create(), path: 'AGENTS.md' }), code('PROTECTED_PATH'));
  await fs.writeFile(path.join(f.directory, 'outside'), 'secret');
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.directory, 'outside'), path.join(f.root, 'link'));
    await assert.rejects(f.workspace.read('link'), code('SYMLINK'));
  }
  await fs.link(path.join(f.directory, 'outside'), path.join(f.root, 'hardlink'));
  await assert.rejects(f.workspace.read('hardlink'), code('HARDLINK'));
  await fs.writeFile(path.join(f.root, 'invalid'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.workspace.read('invalid'), code('ENCODING'));
  await fs.writeFile(path.join(f.root, 'binary'), Buffer.from([0, 1]));
  await assert.rejects(f.workspace.read('binary'), code('BINARY'));
});

test('native goal -> Web edit -> finish -> seal -> local evidence; never completes native goal', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const { turn } = await startTurn(f.bridge); const lease = turn.token;
  await assert.rejects(f.bridge.mutate(create()), code('LEASE_REQUIRED'));
  await assert.rejects(f.bridge.requestCommand('echo not-allowed'), code('GOAL_EXECUTION'));
  await f.bridge.workerContext(lease);
  assert.equal(f.bridge.turnView(turn).progress.work, 'working');
  await f.bridge.mutate({ ...create(), turnToken: lease });
  await f.bridge.workerFinish(lease, 'Implemented addition.');
  await assert.rejects(f.bridge.mutate({ ...create(), turnToken: lease }), code('LEASE_REQUIRED'));
  await assert.rejects(f.bridge.seal(), code('TURN_NOT_ANSWERED'));
  await f.bridge.browserEvent({ type: 'answer', turnId: turn.id, response: 'Done' });
  const sealed = await f.bridge.seal();
  await assert.rejects(f.bridge.checkpoint({ revision: sealed.revision, verdict: 'pass', summary: 'No checks', checks: [] }), code('CHECKS_REQUIRED'));
  await f.bridge.checkpoint({ revision: sealed.revision, verdict: 'pass', summary: 'Addition checked', checks: [{ command: 'node math.test.js', exitCode: 0, summary: '2+3=5' }] });
  assert.equal(f.bridge.turn?.status, 'checked'); assert.equal(f.native.thread.goal?.status, 'active');
  const progress = f.bridge.turnView(turn).progress;
  assert.equal(progress.delivery, 'answered'); assert.equal(progress.work, 'worker_finished');
  assert.equal(progress.validation, 'locally_validated'); assert.equal(progress.appliedFiles, 1);
  assert.ok(!JSON.stringify(f.bridge.view()).includes(lease));
});

test('Plan is read-only and accepts a non-executing review checkpoint', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const { turn } = await startTurn(f.bridge, 'plan');
  await assert.rejects(f.bridge.mutate({ ...create(), turnToken: turn.token }), code('LEASE_REQUIRED'));
  await assert.rejects(f.bridge.requestCommand('echo x'), code('GOAL_EXECUTION'));
  await f.bridge.workerFinish(turn.token, 'Plan drafted');
  await f.bridge.browserEvent({ type: 'answer', turnId: turn.id, response: 'Plan' });
  const seal = await f.bridge.seal();
  await f.bridge.checkpoint({ revision: seal.revision, verdict: 'pass', summary: 'Reviewed', checks: [] });
});

test('dispatch is idempotent and concurrent requests cannot create two active turns', async t => {
  const f = await fixture(); t.after(f.cleanup); await startTurn(f.bridge);
  const same = { requestId: 'task-1', task: 'Implement add(a,b)', context: '', criteria: 'add(2,3) is 5' };
  assert.equal((await f.bridge.dispatch(same)).id, f.bridge.turn!.id);
  await assert.rejects(f.bridge.dispatch({ ...same, task: 'Different task' }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.bridge.dispatch({ ...same, requestId: 'task-2' }), code('TURN_ACTIVE'));
  assert.equal(f.bridge.session!.turnIds.length, 1);
});

test('native pause/replacement revokes remote editing; late answers cannot revive cancelled turns', async t => {
  const f = await fixture(); t.after(f.cleanup); const { turn } = await startTurn(f.bridge); const lease = turn.token;
  f.native.thread.goal!.status = 'paused'; await f.bridge.pump();
  assert.equal(f.bridge.session?.status, 'paused'); assert.equal(turn.status, 'cancelled');
  await assert.rejects(f.bridge.mutate({ ...create(), turnToken: lease }), code('LEASE_REVOKED'));
  await f.bridge.browserEvent({ type: 'answer', turnId: turn.id, response: 'late' }); assert.equal(turn.status, 'cancelled');
  f.native.thread.goal!.status = 'active'; f.native.thread.goal!.createdAt = 2;
  await assert.rejects(f.bridge.control('resume'), code('NATIVE_GOAL'));
});

test('source drift invalidates local evidence until a new seal and recheck', async t => {
  const f = await fixture(); t.after(f.cleanup); const { turn } = await startTurn(f.bridge);
  await f.bridge.workerFinish(turn.token, 'Done'); await f.bridge.browserEvent({ type: 'answer', turnId: turn.id, response: 'Done' });
  const seal = await f.bridge.seal(); await fs.writeFile(path.join(f.root, 'new.js'), 'changed');
  await assert.rejects(f.bridge.checkpoint({ revision: seal.revision, verdict: 'fail', summary: 'Stale', checks: [] }), code('WORKSPACE_DRIFT'));
  assert.equal(f.bridge.turnView(f.bridge.turn!).progress.validation, 'stale');
  assert.notEqual((await f.bridge.seal()).revision, seal.revision);
  assert.equal(f.bridge.turnView(f.bridge.turn!).progress.validation, 'sealed');
});

test('restart reconciles prepared writes and never dispatches uncertain browser submissions', async t => {
  const f = await fixture(); t.after(f.cleanup); await startTurn(f.bridge);
  f.bridge.turn!.status = 'uncertain';
  f.store.state.operations.x = { id: 'x', path: 'applied.txt', before: 'absent', after: hash('written'), status: 'prepared', requestHash: 'x', at: 1 };
  f.store.state.operations.y = { id: 'y', path: 'missing.txt', before: 'absent', after: hash('written'), status: 'prepared', requestHash: 'y', at: 1 };
  await fs.writeFile(path.join(f.root, 'applied.txt'), 'written'); await f.store.save(); f.bridge.close();
  const store = new Store(f.store.directory); await store.open(f.root);
  const recovered = new Bridge(store, f.workspace, f.native); t.after(() => recovered.close()); await recovered.recover();
  const sent: { type: string }[] = []; recovered.conversation = { surface: 'chrome-extension', send: value => sent.push(value as { type: string }), close() {} };
  await recovered.pump(); assert.equal(sent.length, 0);
  await recovered.pump(true); assert.deepEqual(sent.map(x => x.type), ['reconcile']);
  assert.equal(store.state.operations.x!.status, 'applied'); assert.equal(store.state.operations.y!.status, 'uncertain');
});

test('ordinary Web commands require human approval and finish with local output', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const requested = await f.bridge.requestCommand('node -e "console.log(6*7)"');
  assert.equal(f.bridge.state.jobs[requested.id]!.status, 'pending');
  await f.bridge.approveCommand(requested.id, true);
  await eventually(() => f.bridge.state.jobs[requested.id]!.status === 'done');
  assert.equal(f.bridge.state.jobs[requested.id]!.exitCode, 0); assert.match(f.bridge.state.jobs[requested.id]!.output, /42/);
});

test('late worker_finish can close an answered turn but never reopen file writes', async t => {
  const f = await fixture(); t.after(f.cleanup); const { turn } = await startTurn(f.bridge); const lease = turn.token;
  await f.bridge.browserEvent({ type: 'answer', turnId: turn.id, response: 'Forgot handshake' });
  await assert.rejects(f.bridge.seal(), code('WORKER_NOT_FINISHED'));
  await assert.rejects(f.bridge.mutate({ ...create(), turnToken: lease }), code('LEASE_REQUIRED'));
  await f.bridge.workerFinish(lease, 'Now closed'); await f.bridge.seal();
  assert.equal(turn.status, 'sealed');
});

test('bridge reports a UI-neutral conversation surface without changing delivery ownership', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.bridge.conversation = { surface: 'codex-inapp', send() {}, close() {} };
  const state = f.bridge.view();
  assert.equal(state.conversationConnected, true); assert.equal(state.conversationSurface, 'codex-inapp');
  assert.equal(state.browserConnected, true); // compatibility field for existing dashboard/API clients
});
