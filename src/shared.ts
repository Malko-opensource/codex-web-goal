import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const VERSION = '0.1.1';
export const PORTS = { mcp: 43120, control: 43121, codex: 43122 };
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const equalSecret = (a: string, b: string) => {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
export class BridgeError extends Error {
  constructor(public code: string, message: string, public http = 409) { super(message); }
}
export function requireThat(condition: unknown, code: string, message: string, http = 409): asserts condition {
  if (!condition) throw new BridgeError(code, message, http);
}
export function errorInfo(error: unknown) {
  return error instanceof BridgeError ? { code: error.code, message: error.message } :
    { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
}
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
export type NativeGoal = {
  threadId: string; objective: string; createdAt: number; updatedAt?: number;
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  tokensUsed?: number; tokenBudget?: number | null; timeUsedSeconds?: number;
};
export type NativeBinding = { threadId: string; fingerprint: string; objective: string };
export const goalFingerprint = (goal: NativeGoal) => hash(`${goal.threadId}:${goal.createdAt}:${goal.objective}`);
export type TurnStatus = 'queued' | 'dispatching' | 'submitted' | 'answered' | 'uncertain' | 'blocked' | 'sealed' | 'checked' | 'cancelled';
export type Turn = {
  id: string; requestId: string; requestHash: string; sessionId: string; sequence: number;
  marker: string; prompt: string; token: string; phase: 'plan' | 'code'; allowDelete: boolean;
  status: TurnStatus; createdAt: number; response?: string; reason?: string; workerFinished?: boolean; workerReport?: string;
  revision?: string; checkpoint?: { verdict: 'pass' | 'fail' | 'blocked'; summary: string; checks: Check[]; at: number };
};
export type Check = { command: string; exitCode: number | null; summary: string };
export type Session = {
  id: string; binding: NativeBinding; mode: 'plan' | 'goal'; status: 'active' | 'paused' | 'closed';
  createdAt: number; reason?: string; turnIds: string[];
};
export type Operation = {
  id: string; requestHash: string; path: string; before: string; after: string;
  status: 'prepared' | 'applied' | 'uncertain'; turnId?: string; backup?: string; at: number;
};
export type Job = {
  id: string; command: string; cwd: string; status: 'pending' | 'running' | 'done' | 'denied' | 'interrupted';
  createdAt: number; exitCode?: number | null; output: string; timeoutMs: number;
};
export type State = {
  version: 1; workspace: string; mcpToken: string; controlToken: string;
  extension?: { id: string; secret: string };
  chat?: { url: string; tabId: number }; activeSession?: string;
  sessions: Record<string, Session>; turns: Record<string, Turn>; operations: Record<string, Operation>;
  jobs: Record<string, Job>; events: { at: number; kind: string; detail: string }[];
};
export function chatUrl(value: string): string {
  const url = new URL(value);
  requireThat(url.protocol === 'https:' && url.hostname === 'chatgpt.com' &&
    /^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname), 'CHAT_URL', 'Select a saved ChatGPT conversation (a /c/ URL).');
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}
