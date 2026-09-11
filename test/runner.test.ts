import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { isPublicAddress, publicDestination } from '../src/egress.js';
import { snapshotWorkspace, seatbeltProfile, MacSandboxRunner } from '../src/runner.js';
import { Workspace } from '../src/workspace.js';
import { executionPolicySchema, type FrozenPolicy, type ExecutionRun } from '../src/execution-contract.js';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

test('egress rejects loopback, private, mapped, metadata and reserved addresses', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('1.1.1.1'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(publicDestination('bridge.example', ['bridge.example']));
  await assert.rejects(publicDestination('127.0.0.1', []));
});

test('snapshot is independent, excludes credentials, and detects source drift', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await fs.writeFile(path.join(f.root, 'source'), 'safe'); await fs.writeFile(path.join(f.root, '.env'), 'secret');
  const destination = path.join(f.directory, 'copy'); await fs.mkdir(destination);
  const revision = await f.workspace.revision(); await snapshotWorkspace(f.workspace, destination, revision);
  assert.deepEqual(await new Workspace(destination).files(), ['source']);
  await fs.writeFile(path.join(destination, 'source'), 'copy changed');
  assert.equal((await f.workspace.read('source')).content, 'safe');
  await fs.writeFile(path.join(f.root, 'source'), 'live changed');
  await assert.rejects(snapshotWorkspace(f.workspace, path.join(f.directory, 'other'), revision));
});

test('native policy only permits the egress gateway, not arbitrary sockets', () => {
  const profile = seatbeltProfile('/private/tmp/job', ['/opt/node/bin'], 45678, [], ['/private/tmp/job/work/checks/check.txt']);
  assert.match(profile, /deny default/); assert.match(profile, /localhost:45678/);
  assert.doesNotMatch(profile, /network\*|network-inbound|localhost:\*/);
  assert.match(profile, /deny file-write\* \(literal "\/private\/tmp\/job\/work\/checks\/check.txt"\)/);
  assert.match(profile, /deny file-write-unlink \(literal "\/private\/tmp\/job\/work\/checks"\)/);
});

test('actual Mac sandbox executes and denies live files and inherited credentials', { skip: process.platform !== 'darwin' || process.env.WEB_GOAL_SANDBOX_TESTS !== '1' }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  await fs.writeFile(path.join(f.root, 'result.txt'), 'safe');
  const privateFile = path.join(f.directory, 'canary'); await fs.writeFile(privateFile, 'must not read');
  const local = createServer((_req, res) => res.end('private service'));
  await new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve)); t.after(() => local.close());
  const privateUrl = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  const source = `if /bin/cat ${JSON.stringify(privateFile)} >/dev/null 2>&1; then exit 9; fi; if test -n "$WEB_GOAL_CANARY"; then exit 8; fi; if /usr/bin/curl --noproxy '*' --max-time 2 -fsS ${privateUrl} >/dev/null 2>&1; then exit 7; fi; status=$(/usr/bin/curl --proxy "$HTTP_PROXY" --noproxy '' --max-time 3 -s -o /dev/null -w '%{http_code}' ${privateUrl}); test "$status" = 403 || exit 6; /usr/bin/printf sandbox-pass`;
  const policy: FrozenPolicy = { ...executionPolicySchema.parse({ mode: 'web-controlled', network: 'public-internet', checks: [{ id: 'check', argv: ['/bin/sh', '-c', source] }], protectedFiles: ['result.txt'], expectedFiles: ['result.txt'] }), version: 1, digest: 'fixture', protectedHashes: {} };
  const run: ExecutionRun = { id: 'fixture', requestId: 'fixture', requestHash: 'fixture', sessionId: 'fixture', turnId: 'fixture', contextVersion: 1, policyVersion: 1, policyDigest: 'fixture', kind: 'verify', status: 'running', createdAt: Date.now(), commands: policy.checks, revision: await f.workspace.revision(), timeoutMs: 15_000, output: '', outputTruncated: false, checks: [], artifacts: [] };
  const runner = new MacSandboxRunner([]);
  const chunks: string[] = [];
  const result = await runner.run({ run, policy, workspace: f.workspace, signal: new AbortController().signal, output: s => chunks.push(s) });
  assert.equal(result.checks[0]?.exitCode, 0, chunks.join('')); assert.match(chunks.join(''), /sandbox-pass/);
});

test('actual inherited listener is usable only inside the sandbox grant', { skip: process.platform !== 'darwin' || process.env.WEB_GOAL_SANDBOX_TESTS !== '1' }, async t => {
  const f = await fixture(); t.after(f.cleanup);
  const canary = path.join(f.directory, 'canary'); await fs.writeFile(canary, 'private');
  execFileSync('/usr/bin/cc', [path.resolve('test/fixtures/native-sandbox-probe.c'), '-o', path.join(f.root, 'probe')]);
  await fs.writeFile(path.join(f.root, 'result.txt'), 'safe');
  await fs.mkdir(path.join(f.root, 'checks')); await fs.writeFile(path.join(f.root, 'checks', 'check.txt'), 'immutable');
  const policy: FrozenPolicy = { ...executionPolicySchema.parse({ mode: 'web-controlled', network: 'public-internet', checks: [{ id: 'native', argv: ['./probe', canary], localServices: 1 }], protectedFiles: ['probe', 'checks/check.txt'], expectedFiles: ['result.txt'] }), version: 1, digest: 'fixture', protectedHashes: {} };
  const run: ExecutionRun = { id: 'native', requestId: 'native', requestHash: 'native', sessionId: 'fixture', turnId: 'fixture', contextVersion: 1, policyVersion: 1, policyDigest: 'fixture', kind: 'verify', status: 'running', createdAt: Date.now(), commands: policy.checks, revision: await f.workspace.revision(), timeoutMs: 15_000, output: '', outputTruncated: false, checks: [], artifacts: [] };
  const output: string[] = [];
  const result = await new MacSandboxRunner([]).run({ run, policy, workspace: f.workspace, signal: new AbortController().signal, output: s => output.push(s) });
  assert.equal(result.checks[0]?.exitCode, 0, output.join('')); assert.match(output.join(''), /native-sandbox-pass/);
  assert.equal(await fs.readFile(canary, 'utf8'), 'private');
});
