import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { Workspace } from '../src/workspace.js';
import { Bridge } from '../src/bridge.js';
import type { NativePort, NativeThread } from '../src/codex.js';

export class FakeNative implements NativePort {
  thread: NativeThread;
  online = true;
  constructor(cwd: string) { this.thread = { id: 'fixture-thread', cwd, loaded: true, goal: { threadId: 'fixture-thread', objective: 'Build a verified calculator', createdAt: 1, status: 'active' } }; }
  async inspect() { if (!this.online) throw new Error('Native offline'); return structuredClone(this.thread); }
  async candidates() { return [await this.inspect()]; }
  close() {}
}
export async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'web-goal-test-'));
  const root = path.join(directory, 'repo'); await fs.mkdir(root);
  const store = new Store(path.join(directory, 'state')); await store.open(root);
  const native = new FakeNative(root), workspace = new Workspace(root), bridge = new Bridge(store, workspace, native);
  await bridge.recover();
  return { directory, root, store, native, workspace, bridge, async cleanup() { bridge.close(); await fs.rm(directory, { recursive: true, force: true }); } };
}
export async function startTurn(bridge: Bridge, mode: 'goal' | 'plan' = 'goal') {
  await bridge.bind('https://chatgpt.com/c/fixture-chat', 1);
  const messages: unknown[] = []; bridge.browser = { send: value => messages.push(value), close() {} };
  await bridge.open(mode);
  const turn = await bridge.dispatch({ requestId: 'task-1', task: 'Implement add(a,b)', context: '', criteria: 'add(2,3) is 5' });
  await eventually(() => bridge.turn?.status === 'dispatching');
  await bridge.browserEvent({ type: 'submitted', turnId: turn.id });
  return { turn: bridge.turn!, messages };
}
export async function eventually(predicate: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(r => setTimeout(r, 20)); }
}
