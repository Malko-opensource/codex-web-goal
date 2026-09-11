import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { Workspace } from './workspace.js';
import { hash, requireThat } from './shared.js';
import type { ExecutionRun, FrozenPolicy } from './execution-contract.js';
import { publicInternetProxy } from './egress.js';
import { watchdogProgram } from './runner-watchdog.js';

export interface RunnerPort {
  preflight(): Promise<{ available: true; backend: string }>;
  run(input: { run: ExecutionRun; policy: FrozenPolicy; workspace: Workspace; signal: AbortSignal; output: (chunk: string) => void }): Promise<Pick<ExecutionRun, 'checks' | 'artifacts' | 'sourceChanged' | 'environment'>>;
}
export async function snapshotWorkspace(workspace: Workspace, destination: string, revision: string) {
  requireThat(await workspace.revision() === revision, 'WORKSPACE_DRIFT', 'Workspace changed before snapshot.');
  let size = 0;
  for (const file of await workspace.files()) {
    const { absolute } = await workspace.resolve(file);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat(); size += stat.size;
      requireThat(stat.isFile() && stat.nlink === 1 && size <= 256 * 1024 * 1024, 'SNAPSHOT_LIMIT', 'Snapshot requires unlinked regular files and at most 256 MiB.');
      const target = path.join(destination, file); await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await handle.readFile(), { flag: 'wx', mode: stat.mode & 0o777 });
    } finally { await handle.close(); }
  }
  requireThat(await workspace.revision() === revision && await new Workspace(destination).revision() === revision, 'WORKSPACE_DRIFT', 'Snapshot does not match the source revision.');
}
const quote = (value: string) => JSON.stringify(value);
export function seatbeltProfile(jobRoot: string, toolRoots: string[], proxyPort: number, localPorts: number[] = [], protectedPaths: string[] = []) {
  // Never grant /System: /System/Volumes/Data aliases the user's writable volume.
  const reads = ['/System/Library', '/usr/lib', '/usr/bin', '/bin', '/usr/share', '/private/var/db/dyld', ...toolRoots];
  const publicTLS = '(allow file-read* (literal "/private/etc/ssl/openssl.cnf") (literal "/private/etc/ssl/cert.pem"))';
  const sysctl = '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osversion") (sysctl-name "kern.osproductversion") (sysctl-name "kern.version") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfilesperproc"))';
  const protectedParents = new Set<string>();
  for (const file of protectedPaths) {
    requireThat(file.startsWith(`${jobRoot}/`), 'PROTECTED_CHECK', 'Protected checks must be inside the private snapshot.');
    for (let directory = path.dirname(file); directory.startsWith(`${jobRoot}/`); directory = path.dirname(directory)) protectedParents.add(directory);
  }
  // A read-only checker cannot be replaced indirectly by renaming its containing directory.
  const checkerGuards = protectedPaths.map(file => `(deny file-write* (literal ${quote(file)}))`).concat(
    [...protectedParents].map(directory => `(deny file-write-unlink (literal ${quote(directory)}))`),
  ).join('\n');
  return `(version 1)\n(deny default)\n(allow process-exec process-fork)\n(allow signal (target same-sandbox))\n(allow process-info* (target same-sandbox))\n${sysctl}\n(allow file-read-metadata)\n(allow file-read* (literal "/"))\n${publicTLS}\n(allow file-read* ${reads.map(p => `(subpath ${quote(p)})`).join(' ')})\n(allow file-map-executable ${[...reads, jobRoot].map(p => `(subpath ${quote(p)})`).join(' ')})\n(allow file-read* file-write* (subpath ${quote(jobRoot)}))\n(allow file-read* file-write* (literal "/dev/null"))\n(allow file-read* (literal "/dev/random") (literal "/dev/urandom"))\n(allow network-outbound (remote ip "localhost:${proxyPort}"))\n${localPorts.map(port => `(allow network-inbound (local ip "localhost:${port}"))\n(allow network-outbound (remote ip "localhost:${port}"))`).join('\n')}\n${checkerGuards}\n`;
}

/** Keep sockets reserved until they are duplicated into the sandboxed child's FDs. */
export async function reserveLocalServices(count: number) {
  const leases: { server: Server; fd: number; port: number }[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const fd = (server as Server & { _handle?: { fd?: number } })._handle?.fd;
      if (!Number.isInteger(fd)) { server.close(); throw new Error('Runtime cannot transfer a reserved listening socket; local services are unavailable.'); }
      leases.push({ server, fd: fd!, port: (server.address() as AddressInfo).port });
    }
    return leases;
  } catch (error) { for (const lease of leases) lease.server.close(); throw error; }
}

/** Explicit native sandbox. No inherited Codex policy, credentials, shell or environment. */
export class MacSandboxRunner implements RunnerPort {
  constructor(readonly toolRoots: string[], readonly deniedHosts: string[] = []) {}
  async preflight() {
    requireThat(process.platform === 'darwin', 'RUNNER_PLATFORM', 'The native execution backend requires macOS.');
    await fs.access('/usr/bin/sandbox-exec', constants.X_OK);
    for (const root of this.toolRoots) {
      requireThat(path.isAbsolute(root) && root !== '/' && !['/Users', '/Applications', '/private', '/var', '/tmp', '/System'].includes(root) && !root.startsWith('/System/Volumes') && root !== os.homedir() && !os.homedir().startsWith(`${root}/`) && !root.startsWith(`${os.homedir()}/.`, 0), 'TOOL_ROOT', 'Use explicit non-secret tool installation directories.');
      requireThat(await fs.realpath(root) === root && (await fs.stat(root)).isDirectory(), 'TOOL_ROOT', 'Tool roots must be canonical directories.');
    }
    return { available: true as const, backend: 'macos-seatbelt-public-proxy' };
  }
  async run({ run, policy, workspace, signal, output }: Parameters<RunnerPort['run']>[0]) {
    await this.preflight();
    for (const root of this.toolRoots) requireThat(root !== workspace.root && !workspace.root.startsWith(`${root}/`) && !root.startsWith(`${workspace.root}/`), 'TOOL_ROOT', 'Tool installations must be separate from the live workspace.');
    const jobRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'web-goal-run-'));
    const canonicalRoot = await fs.realpath(jobRoot);
    const work = path.join(canonicalRoot, 'work'), temporary = path.join(canonicalRoot, 'tmp');
    await fs.mkdir(work); await fs.mkdir(temporary);
    const proxy = await publicInternetProxy(this.deniedHosts);
    const checks: ExecutionRun['checks'] = [];
    try {
      await snapshotWorkspace(workspace, work, run.revision);
      const started = Date.now();
      for (const command of run.commands) {
        if (signal.aborted) break;
        const remaining = run.timeoutMs - (Date.now() - started);
        if (remaining <= 0) { checks.push({ argv: command.argv, exitCode: null, timedOut: true }); break; }
        const cwd = (await new Workspace(work).resolve(command.cwd)).absolute;
        const services = await reserveLocalServices(command.localServices ?? 0);
        const profile = seatbeltProfile(canonicalRoot, this.toolRoots, proxy.port, services.map(s => s.port), policy.protectedFiles.map(file => path.join(work, file)));
        const proxyUrl = `http://127.0.0.1:${proxy.port}`;
        const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
          const env = { PATH: [...this.toolRoots.flatMap(root => [path.join(root, 'bin'), root]), '/usr/bin', '/bin'].join(':'), TMPDIR: temporary, LANG: 'en_US.UTF-8', CI: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, npm_config_cache: path.join(canonicalRoot, 'npm-cache'), WEB_GOAL_LOCAL_SERVICES: JSON.stringify(services.map((s, i) => ({ fd: i + 3, port: s.port }))) };
          const child = spawn(process.execPath, ['-e', watchdogProgram], {
            cwd: canonicalRoot, stdio: ['pipe', 'pipe', 'pipe', ...services.map(s => s.fd)], env,
          });
          child.stdin?.on('error', () => {});
          child.stdin?.write(JSON.stringify({ profile, argv: command.argv, cwd, env, fds: services.map((_s, i) => i + 3), timeoutMs: remaining }) + '\n');
          // The child's descriptors retain the reservation after the parent closes its copies.
          for (const service of services) service.server.close();
          let timedOut = false;
          const kill = () => { child.stdin?.end(); };
          const timer = setTimeout(() => { timedOut = true; kill(); }, remaining);
          signal.addEventListener('abort', kill, { once: true });
          if (signal.aborted) kill();
          child.stdout?.on('data', chunk => output(chunk.toString())); child.stderr?.on('data', chunk => output(chunk.toString()));
          child.once('error', reject);
          child.once('close', (exitCode, exitSignal) => { clearTimeout(timer); signal.removeEventListener('abort', kill); kill(); if (exitSignal) output(`\nProcess terminated: ${exitSignal}\n`); resolve({ exitCode, timedOut }); });
        });
        checks.push({ argv: command.argv, ...result });
      }
      const copy = new Workspace(work);
      let sourceChanged = true;
      try { sourceChanged = await copy.revision() !== run.revision; } catch { /* Unsafe output tree is not verification evidence. */ }
      const artifacts: ExecutionRun['artifacts'] = [];
      for (const file of policy.expectedFiles) {
        try { const read = await copy.read(file); artifacts.push({ path: file, sha256: hash(read.content), size: Buffer.byteLength(read.content) }); } catch { /* Missing/unsafe artifact fails the bridge gate. */ }
      }
      return { checks, artifacts, sourceChanged, environment: { platform: process.platform, osRelease: os.release(), arch: process.arch, backend: 'macos-seatbelt-public-proxy', node: process.version, toolRoots: JSON.stringify(this.toolRoots), sourceRevision: run.revision } };
    } finally {
      proxy.close();
      // Only remove the private directory returned by mkdtemp for this invocation.
      await fs.rm(canonicalRoot, { recursive: true, force: true });
    }
  }
}
