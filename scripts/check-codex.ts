// Isolated protocol smoke test. Initializes one ephemeral test thread, never a turn or model call.
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fixture } from '../test/helpers.js';
import { serve } from '../src/http.js';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-goal-codex-'));
const f = await fixture();
const servers = await serve(f.bridge, { mcpPort: 0, controlPort: 0, uiDirectory: path.resolve('dist/ui') });
await fs.writeFile(path.join(f.store.directory, 'runtime.json'), JSON.stringify({ controlPort: servers.controlPort }));
const env = { ...process.env, CODEX_HOME: temporary, WEB_GOAL_STATE_DIR: f.store.directory, RUST_LOG: 'warn,codex_rmcp_client=debug' };
try {
  execFileSync('codex', ['plugin', 'marketplace', 'add', path.resolve('.'), '--json'], { env, stdio: 'pipe', timeout: 15_000 });
  execFileSync('codex', ['plugin', 'add', 'codex-web-goal@codex-web-goal', '--json'], { env, stdio: 'pipe', timeout: 15_000 });
  const cache = path.join(temporary, 'plugins/cache/codex-web-goal/codex-web-goal');
  for (const version of await fs.readdir(cache)) {
    await fs.access(path.join(cache, version, 'dist/control-mcp.cjs'));
  }
} catch (error) { await servers.close(); await f.cleanup(); await fs.rm(temporary, { recursive: true, force: true }); throw error; }
const child = spawn('codex', ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let sequence = 0;
let diagnostics = '';
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let data: any; try { data = JSON.parse(line); } catch { return; }
  const entry = pending.get(data.id); if (!entry) { if (String(data.method).includes('mcp')) diagnostics += line + '\n'; return; }
  clearTimeout(entry.timer); pending.delete(data.id);
  if (data.error) entry.reject(Object.assign(new Error(data.error.message), { code: data.error.code })); else entry.resolve(data.result);
});
child.stderr.on('data', data => { diagnostics = (diagnostics + String(data)).slice(-8000); }); child.on('error', error => { for (const entry of pending.values()) entry.reject(error); });
const call = (method: string, params: object) => new Promise<any>((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10_000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
try {
  const initialize = await call('initialize', { clientInfo: { name: 'web_goal_protocol_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  assert.equal(typeof initialize.userAgent, 'string');
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const threads = await call('thread/loaded/list', { limit: 10 }); assert.ok(Array.isArray(threads.data));
  const started = await call('thread/start', { cwd: temporary, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });
  const inventory = await call('mcpServerStatus/list', { limit: 100, threadId: started.thread.id });
  const webGoal = inventory.data.find((entry: { name: string }) => entry.name.includes('web_goal'));
  assert.ok(webGoal, 'Installed plugin MCP was not discovered by real Codex');
  assert.ok(Object.keys(webGoal.tools).some(name => name.includes('web_goal_status')), `Plugin MCP did not initialize in real Codex: ${JSON.stringify(webGoal)}\n${diagnostics}`);
  const status = await call('mcpServer/tool/call', { server: webGoal.name, threadId: started.thread.id, tool: 'web_goal_status', arguments: {} });
  assert.ok(!status.isError, JSON.stringify(status));
  assert.equal(JSON.parse(status.content[0].text).workspace, f.root, 'Plugin did not use its selected private state directory');
  try { const goal = await call('thread/goal/get', { threadId: started.thread.id }); assert.equal(goal.goal ?? null, null); }
  catch (error) {
    // Some native versions intentionally exclude ephemeral threads from persisted Goals.
    assert.equal((error as { code: number }).code, -32600);
    assert.match((error as Error).message, /ephemeral thread does not support goals/);
  }
  const schema = path.join(temporary, 'schema');
  execFileSync('codex', ['app-server', 'generate-json-schema', '--experimental', '--out', schema], { env, stdio: 'pipe' });
  const contract = JSON.parse(await fs.readFile(path.join(schema, 'v2', 'ThreadGoalGetResponse.json'), 'utf8'));
  for (const key of ['threadId', 'objective', 'status', 'createdAt']) assert.ok(contract.definitions.ThreadGoal.required.includes(key));
  console.log('PASS: isolated plugin installation, real Codex -> plugin MCP -> bridge status call, native Goal method and schema. Only one ephemeral test thread initialized; no turns/model calls or user config changes.');
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  child.stdin.end(); child.kill(); lines.close();
  await new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once('exit', () => resolve()));
  await servers.close(); await f.cleanup();
  await fs.rm(temporary, { recursive: true, force: true });
}
