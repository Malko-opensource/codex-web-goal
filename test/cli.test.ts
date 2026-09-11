import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, eventually } from './helpers.js';

async function port() {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); assert.ok(address && typeof address === 'object'); server.close(() => resolve(address.port));
    });
  });
}
test('built CLI starts, reports status and shuts down without editing the target repository', async t => {
  const f = await fixture(); const directory = path.join(f.directory, 'cli-state'), cli = path.resolve('dist/cli.js');
  const ports = [await port(), await port()];
  const child = spawn(process.execPath, [cli, 'start', '--no-codex', '--workspace', f.root, '--state-dir', directory, '--mcp-port', String(ports[0]), '--control-port', String(ports[1])], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
  const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => { child.kill(); await done; await f.cleanup(); });
  await eventually(() => { if (child.exitCode !== null) throw new Error(stderr); return stdout.includes('Dashboard:'); });
  const status = await promisify(execFile)(process.execPath, [cli, 'status', '--state-dir', directory]);
  assert.equal(JSON.parse(status.stdout).workspace, await fs.realpath(f.root));
  assert.deepEqual(await fs.readdir(f.root), []);
  child.kill('SIGTERM'); await done;
  // Windows TerminateProcess does not deliver SIGTERM to the JS signal handler.
  if (process.platform !== 'win32') await assert.rejects(fs.stat(path.join(directory, 'daemon.lock')));
});
