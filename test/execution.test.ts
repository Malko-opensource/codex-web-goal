import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, eventually } from './helpers.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';
import { hash } from '../src/shared.js';
import { executionPolicySchema, type ExecutionPolicy } from '../src/execution-contract.js';
import { FakeHost, FakeRunner } from './execution-helpers.js';

const code = (expected: string) => (e: unknown) => (e as { code: string }).code === expected;
async function setup(overrides: Partial<ExecutionPolicy> = {}) {
  const f = await fixture(); f.bridge.close();
  await fs.writeFile(path.join(f.root, 'check.cjs'), 'trusted checker');
  await fs.writeFile(path.join(f.root, 'result.txt'), 'initial');
  await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'Keep requirements intact.');
  const host = new FakeHost(), runner = new FakeRunner();
  const bridge = new Bridge(f.store, f.workspace, f.native, { host, runner });
  const policy = executionPolicySchema.parse({ mode: 'web-controlled', network: 'public-internet', checks: [{ id: 'required', argv: ['node', 'check.cjs'] }], protectedFiles: ['check.cjs'], expectedFiles: ['result.txt'], ...overrides });
  await bridge.recover(); await bridge.bind('https://chatgpt.com/c/fixture-chat', 1);
  const messages: unknown[] = []; bridge.conversation = { surface: 'codex-inapp', send: m => messages.push(m), close() {} };
  await bridge.open('goal', undefined, policy);
  await bridge.dispatch({ requestId: 'work', task: 'Update result', context: 'No full history copied.', criteria: 'Required checks pass' });
  await eventually(() => bridge.turn!.status === 'dispatching');
  const turn = bridge.turn!, turnToken = turn.token;
  const versions = { contextVersion: turn.contextEnvelope!.version, policyVersion: policy ? 1 : 0 };
  const acknowledge = () => bridge.workerContext(turnToken, turn.contextEnvelope!.digest);
  const verify = async (requestId: string) => {
    const result = await bridge.execution.request({ kind: 'verify', requestId, turnToken, ...versions });
    await eventually(() => !['queued', 'running'].includes(f.store.state.runs[result.run_id]!.status)); return result.run_id;
  };
  return { ...f, bridge, host, runner, policy, messages, turn, turnToken, versions, acknowledge, verify, cleanup: async () => { await bridge.shutdown(); await f.cleanup(); } };
}

test('web-controlled mode fails closed without host integration; Plan cannot execute', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const policy = executionPolicySchema.parse({ mode: 'web-controlled', network: 'public-internet', checks: [{ id: 'x', argv: ['true'] }], protectedFiles: ['test'], expectedFiles: ['out'] });
  await assert.rejects(f.bridge.open('goal', undefined, policy), code('HOST_INTEGRATION_REQUIRED'));
  await assert.rejects(f.bridge.open('plan', undefined, policy), code('PLAN_READ_ONLY'));
  assert.equal(f.bridge.session, undefined);
});

test('context must be acknowledged; stale versions and checker writes fail', async t => {
  const f = await setup(); t.after(f.cleanup);
  assert.equal(f.host.parked, true); assert.equal(f.host.modelRequests, 0);
  assert.match(f.turn.contextEnvelope!.instructions[0]!.source, /repository:AGENTS/);
  const write = { operationId: randomUUID(), path: 'result.txt', expectedHash: hash('initial'), content: 'fixed', turnToken: f.turnToken, ...f.versions };
  await assert.rejects(f.bridge.mutate(write), code('CONTEXT_STALE'));
  await assert.rejects(f.bridge.workerContext(f.turnToken, '0'.repeat(64)), code('CONTEXT_STALE'));
  await f.acknowledge();
  await assert.rejects(f.bridge.mutate({ ...write, contextVersion: 999 }), code('CONTEXT_STALE'));
  await assert.rejects(f.bridge.mutate({ ...write, policyVersion: 999 }), code('CONTEXT_STALE'));
  await assert.rejects(f.bridge.mutate({ ...write, path: 'check.cjs' }), code('PROTECTED_CHECK'));
  await f.bridge.mutate(write);
  assert.equal((await f.workspace.read('result.txt')).content, 'fixed');
  await f.bridge.pump(); assert.equal(f.host.modelRequests, 0);
});

test('Web iterates after failed verification; intermediate answers never close the grant', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  f.runner.exitCode = 1; const failed = await f.verify('fail');
  assert.equal(f.bridge.execution.result(failed).status, 'failed');
  await f.bridge.browserEvent({ type: 'answer', turnId: f.turn.id, response: 'Still fixing', generation: f.store.state.chat!.generation });
  assert.equal(f.turn.status, 'dispatching');
  await f.bridge.mutate({ operationId: randomUUID(), path: 'result.txt', expectedHash: hash('initial'), content: 'fixed', turnToken: f.turnToken, ...f.versions });
  await f.bridge.pump(); assert.equal(f.host.modelRequests, 0);
  f.runner.exitCode = 0; const passed = await f.verify('pass');
  await assert.rejects(f.bridge.checkpoint({ revision: f.store.state.runs[passed]!.revision, verdict: 'pass', summary: 'forged', checks: [] }), code('RUNNER_EVIDENCE_REQUIRED'));
  await f.bridge.workerFinish(f.turnToken, 'Complete after trusted verification.', { ...f.versions, runId: passed });
  assert.equal(f.turn.status, 'checked'); assert.equal(f.turn.token, '');
  assert.equal(f.native.thread.goal!.status, 'active');
  await f.bridge.pump(); await f.bridge.pump();
  assert.equal(f.host.modelRequests, 1); assert.equal(f.runner.executions, 2);
});

test('execution requests are idempotent and diagnostics cannot become verification evidence', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  const request = { kind: 'exec' as const, requestId: 'diagnostic', argv: ['node', '--version'], turnToken: f.turnToken, ...f.versions };
  const first = await f.bridge.execution.request(request);
  await eventually(() => f.store.state.runs[first.run_id]!.status === 'passed');
  assert.equal((await f.bridge.execution.request(request)).run_id, first.run_id);
  assert.equal(f.runner.executions, 1);
  await assert.rejects(f.bridge.execution.request({ ...request, argv: ['different'] }), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.bridge.workerFinish(f.turnToken, 'claim', { ...f.versions, runId: first.run_id }), code('VERIFICATION_REQUIRED'));
  await assert.rejects(f.bridge.execution.request({ ...request, requestId: 'secret', argv: ['echo', f.store.state.controlToken] }), code('SECRET_ARGUMENT'));
});

test('source drift, checker changes and sandbox source mutation invalidate evidence', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  const passed = await f.verify('verify');
  await fs.writeFile(path.join(f.root, 'result.txt'), 'changed externally');
  await assert.rejects(f.bridge.workerFinish(f.turnToken, 'claim', { ...f.versions, runId: passed }), code('WORKSPACE_DRIFT'));
  f.runner.sourceChanged = true; const stale = await f.verify('mutated-copy');
  assert.equal(f.bridge.execution.result(stale).status, 'stale');
  await fs.writeFile(path.join(f.root, 'check.cjs'), 'replaced');
  await assert.rejects(f.verify('checker'), code('POLICY_STALE'));
});

test('user input revokes the host lease and prevents subsequent effects and wakes', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  f.host.lease!.state = 'revoked';
  await f.bridge.pump();
  assert.equal(f.bridge.session!.status, 'paused'); assert.equal(f.turn.token, '');
  await assert.rejects(f.verify('late'), code('EXECUTION_REVOKED'));
  await f.bridge.pump(); assert.equal(f.host.modelRequests, 0);
});

test('late generation observations are ignored and no model wakes while delivery is uncertain', async t => {
  const f = await setup(); t.after(f.cleanup);
  const previous = f.store.state.chat!.generation;
  await f.bridge.bind(f.store.state.chat!.url, 2);
  await f.bridge.browserEvent({ type: 'answer', turnId: f.turn.id, generation: previous, response: 'late' });
  assert.equal(f.turn.response, undefined);
  await f.bridge.browserEvent({ type: 'uncertain', turnId: f.turn.id, generation: f.store.state.chat!.generation });
  await f.bridge.pump(); await f.bridge.pump();
  assert.equal(f.host.modelRequests, 0);
  assert.equal((f.messages as { type: string }[]).filter(m => m.type === 'dispatch').length, 1);
});

test('lost wake receipt survives bridge restart without a second model request', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  const id = await f.verify('verify'); await f.bridge.workerFinish(f.turnToken, 'done', { ...f.versions, runId: id });
  f.host.loseReceipt = true; await f.bridge.pump(); assert.equal(f.host.modelRequests, 1);
  f.bridge.close(); const store = new Store(f.store.directory); await store.open(f.root);
  const recovered = new Bridge(store, f.workspace, f.native, { host: f.host, runner: f.runner }); t.after(() => recovered.close());
  await recovered.recover(); await recovered.pump();
  assert.equal(f.host.modelRequests, 1);
  assert.equal(Object.values(store.state.wakeEvents)[0]!.status, 'accepted');
});

test('version 1 state migrates with a private backup and does not enable Web execution', async t => {
  const f = await fixture(); t.after(f.cleanup); f.bridge.close();
  const old = { ...f.store.state, version: 1, runs: undefined, wakeEvents: undefined };
  await fs.writeFile(path.join(f.store.directory, 'state.json'), JSON.stringify(old));
  const store = new Store(f.store.directory); await store.open(f.root);
  assert.equal(store.state.version, 3); assert.deepEqual(store.state.runs, {}); assert.deepEqual(store.state.localAssists, {});
  const backups = (await fs.readdir(f.store.directory)).filter(p => /^state-v1-/.test(p)); assert.equal(backups.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.store.directory, backups[0]!), 'utf8')).version, 1);
});

test('verification budget pauses effects and raises one attention event, not completion', async t => {
  const f = await setup({ verificationLimit: 1 }); t.after(f.cleanup); await f.acknowledge();
  f.runner.exitCode = 1; await f.verify('last-allowed');
  await assert.rejects(f.verify('over-budget'), code('EXECUTION_BUDGET'));
  await f.bridge.pump(); await f.bridge.pump();
  assert.equal(f.host.modelRequests, 1); assert.equal(f.turn.workerFinished, undefined);
  assert.equal(Object.values(f.store.state.wakeEvents)[0]!.kind, 'needs_attention');
});

test('user pause cancels active execution and invalidates context without a wake', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  const execute = f.runner.run.bind(f.runner);
  f.runner.run = async input => { await new Promise<void>(resolve => { if (input.signal.aborted) resolve(); else input.signal.addEventListener('abort', () => resolve(), { once: true }); }); return execute(input); };
  const result = await f.bridge.execution.request({ kind: 'exec', argv: ['fixture'], requestId: 'long', turnToken: f.turnToken, ...f.versions });
  await eventually(() => f.store.state.runs[result.run_id]!.status === 'running');
  await f.bridge.control('pause');
  await eventually(() => Boolean(f.store.state.runs[result.run_id]!.finishedAt));
  assert.equal(f.bridge.execution.result(result.run_id).status, 'cancelled');
  assert.equal(f.turn.token, ''); assert.equal(f.host.modelRequests, 0);
});

test('post-seal source drift revokes completion wake and raises attention instead', async t => {
  const f = await setup(); t.after(f.cleanup); await f.acknowledge();
  const id = await f.verify('check'); await f.bridge.workerFinish(f.turnToken, 'done', { ...f.versions, runId: id });
  await fs.writeFile(path.join(f.root, 'result.txt'), 'changed after seal');
  await f.bridge.pump(); await f.bridge.pump();
  assert.equal(f.turn.validationState, 'stale');
  const events = Object.values(f.store.state.wakeEvents);
  assert.equal(events.find(e => e.kind === 'completion_candidate')!.status, 'revoked');
  assert.equal(events.find(e => e.kind === 'needs_attention')!.status, 'accepted');
  assert.equal(f.host.modelRequests, 1);
});
