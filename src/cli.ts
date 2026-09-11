#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Store } from './store.js';
import { Workspace } from './workspace.js';
import { Bridge } from './bridge.js';
import { CodexClient } from './codex.js';
import { serve } from './http.js';
import { PORTS, VERSION, requireThat } from './shared.js';
import { runControlMcp, controlClient, defaultStateDirectory } from './control-mcp.js';
import { SocketDelegationHost } from './delegation-host.js';
import { MacSandboxRunner } from './runner.js';
import { DelegationResources } from './delegation-resources.js';

const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
  workspace: { type: 'string' }, 'state-dir': { type: 'string' }, 'mcp-port': { type: 'string' }, 'control-port': { type: 'string' },
  'codex-url': { type: 'string' }, help: { type: 'boolean', short: 'h' }, 'no-codex': { type: 'boolean' }, 'thread-id': { type: 'string' },
  'host-wait-socket': { type: 'string' }, 'tool-root': { type: 'string', multiple: true }, 'deny-egress-host': { type: 'string', multiple: true }, 'resource-manifest': { type: 'string' }
} });
const command = positionals[0] ?? 'help';
const directory = path.resolve(values['state-dir'] ?? defaultStateDirectory());
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function port(value: string | undefined, fallback: number) {
  const result = value === undefined ? fallback : Number(value);
  requireThat(Number.isInteger(result) && result > 0 && result <= 65535, 'PORT', 'Port must be an integer from 1 to 65535.'); return result;
}
async function execute(program: string, args: string[], env = process.env) {
  const child = spawn(program, args, { stdio: 'inherit', env });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`${program} exited with ${code}`))); });
}
async function main() {
  if (values.help || command === 'help') {
    console.log('Optional --resource-manifest /absolute/private.json: explicitly selected skills, images and approval-gated MCP tools. No automatic sharing of installed plugins or Codex attachments.');
    console.log('Optional web-controlled integration: --host-wait-socket /absolute/private.sock\n  --tool-root /canonical/tool/installation (repeatable), --deny-egress-host tunnel.example (repeatable)\nThe socket requires an actual host scheduler implementation; it is not a stock Codex API.\n');
    console.log(`Codex Web Goal ${VERSION}\n\nCommands:\n  start --workspace /absolute/repo    Start local bridge, dashboard and Codex App Server\n  codex [--thread-id ID]              Open Codex TUI on the same App Server\n  status                             Read bridge status\n  doctor                             Check bridge/native connection\n  install-plugin                     Register and install this local plugin in Codex\n  mcp                                Run the control MCP server over stdio\n\nOptions: --state-dir DIR, --mcp-port ${PORTS.mcp}, --control-port ${PORTS.control},\n  --codex-url ws://127.0.0.1:${PORTS.codex} (connect to an existing server), --no-codex (plain Web tasks only)\n\nExpose ONLY the MCP port, e.g. ngrok http ${PORTS.mcp}. Keep the control and Codex ports local.`); return;
  }
  if (command === 'mcp') { await runControlMcp(directory); return; }
  if (command === 'install-plugin') {
    await execute('codex', ['plugin', 'marketplace', 'add', root]);
    await execute('codex', ['plugin', 'add', 'codex-web-goal@codex-web-goal']); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await (await controlClient(directory)).call('web_goal_status'), null, 2)); return; }
  if (command === 'doctor') {
    const client = await controlClient(directory);
    const native = await client.call('web_goal_threads').catch(error => ({ error: String(error) }));
    console.log(JSON.stringify({ bridge: await client.call('web_goal_snapshot'), execution: await client.call('web_goal_diagnostics'), nativeThreads: native }, null, 2)); return;
  }
  if (command === 'codex') {
    const { runtime } = await controlClient(directory);
    const args = ['--remote', runtime.codexUrl, '-C', runtime.workspace];
    if (values['thread-id']) args.push('resume', values['thread-id']);
    await execute('codex', args, { ...process.env, WEB_GOAL_STATE_DIR: directory }); return;
  }
  requireThat(command === 'start', 'COMMAND', `Unknown command: ${command}`);
  const workspaceRoot = await fs.realpath(path.resolve(values.workspace ?? process.cwd()));
  requireThat((await fs.stat(workspaceRoot)).isDirectory(), 'WORKSPACE', 'Workspace must be a directory.');
  const inside = path.relative(workspaceRoot, directory);
  requireThat(path.isAbsolute(inside) || inside.startsWith(`..${path.sep}`) || inside === '..' || inside.split(path.sep)[0] === '.web-goal', 'STATE_LOCATION', 'Place state outside the workspace or inside its protected .web-goal directory.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, 'daemon.lock');
  try { await fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(lockPath, 'utf8'));
    requireThat(Number.isInteger(pid) && pid > 0, 'LOCK_INVALID', 'Invalid daemon.lock; inspect the state directory locally.');
    let alive = true; try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    requireThat(!alive, 'ALREADY_RUNNING', 'A daemon is already using this state directory.');
    await fs.unlink(lockPath); await fs.writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  const codexUrl = values['codex-url'] ?? `ws://127.0.0.1:${PORTS.codex}`;
  const native = new CodexClient(codexUrl);
  let child: ReturnType<typeof spawn> | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    if (!values['no-codex'] && !values['codex-url']) {
      // Do not accidentally attach to an unrelated server when our child cannot bind.
      await new Promise<void>((resolve, reject) => {
        const probe = createServer(); probe.once('error', reject);
        probe.listen(PORTS.codex, '127.0.0.1', () => probe.close(() => resolve()));
      });
      const log = await fs.open(path.join(directory, 'codex-app-server.log'), 'a', 0o600);
      const pluginEntry = path.join(root, 'plugins', 'codex-web-goal', 'dist', 'control-mcp.cjs');
      child = spawn('codex', ['app-server', '--listen', codexUrl,
        '-c', 'mcp_servers.web_goal.command="node"', '-c', `mcp_servers.web_goal.args=${JSON.stringify([pluginEntry])}`,
        '-c', `mcp_servers.web_goal.env.WEB_GOAL_STATE_DIR=${JSON.stringify(directory)}`],
      { cwd: workspaceRoot, env: { ...process.env, WEB_GOAL_STATE_DIR: directory }, stdio: ['ignore', log.fd, log.fd] });
      child.on('error', error => console.error(`Codex startup: ${error.message}`)); await log.close();
      let connected = false;
      for (let i = 0; i < 40; i++) { try { await native.connect(); connected = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
      requireThat(connected, 'CODEX_START', `Could not start Codex App Server. See ${path.join(directory, 'codex-app-server.log')}`);
      requireThat(child.exitCode === null && !child.killed, 'CODEX_START', 'The owned App Server exited during startup.');
    }
    const store = new Store(directory); await store.open(workspaceRoot);
    for (const toolRoot of values['tool-root'] ?? []) requireThat(directory !== toolRoot && !directory.startsWith(`${toolRoot}/`), 'TOOL_ROOT', 'Tool roots must not expose the bridge state.');
    let resources: DelegationResources | undefined;
    if (values['resource-manifest']) {
      const manifest = await fs.realpath(path.resolve(values['resource-manifest']));
      const relative = path.relative(workspaceRoot, manifest);
      requireThat(relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || relative.split(path.sep)[0] === '.web-goal', 'MANIFEST_LOCATION', 'Keep capability configuration outside remotely writable source.');
      resources = await DelegationResources.load(manifest);
    }
    const bridge = new Bridge(store, new Workspace(workspaceRoot), native, { resources, ...(values['host-wait-socket'] ? {
      host: new SocketDelegationHost(values['host-wait-socket']),
      runner: new MacSandboxRunner(values['tool-root'] ?? [], values['deny-egress-host'] ?? []),
    } : {}) }); await bridge.recover();
    const servers = await serve(bridge, { mcpPort: port(values['mcp-port'], PORTS.mcp), controlPort: port(values['control-port'], PORTS.control), uiDirectory: path.join(root, 'dist', 'ui') });
    await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify({ ...servers, close: undefined, workspace: workspaceRoot, codexUrl, pid: process.pid }), { mode: 0o600 });
    console.log(`\nCodex Web Goal ${VERSION}\nWorkspace: ${workspaceRoot}\nDashboard: http://127.0.0.1:${servers.controlPort}/#${store.state.controlToken}\nMCP: http://127.0.0.1:${servers.mcpPort}/mcp/${store.state.mcpToken}\n\nTunnel: ngrok http ${servers.mcpPort}\nCodex: codex-web-goal codex${values['state-dir'] ? ` --state-dir ${directory}` : ''}\n\nKeep the tokenized URLs private. Ctrl+C stops the bridge and its owned Codex process.\n`);
    let stopping = false;
    shutdown = async () => { if (stopping) return; stopping = true; await bridge.shutdown(); await servers.close(); child?.kill('SIGTERM'); await fs.unlink(lockPath).catch(() => {}); };
    process.once('SIGINT', () => { void shutdown!().then(() => process.exit(0)); });
    process.once('SIGTERM', () => { void shutdown!().then(() => process.exit(0)); });
    child?.once('exit', () => { console.error('The owned Codex App Server exited. Goal writes will be denied until reconnection.'); });
  } catch (error) { await shutdown?.(); native.close(); child?.kill(); await fs.unlink(lockPath).catch(() => {}); throw error; }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
