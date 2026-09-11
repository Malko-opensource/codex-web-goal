import WebSocket from 'ws';
import path from 'node:path';
import { BridgeError, requireThat, type NativeGoal } from './shared.js';

export type NativeThread = { id: string; cwd: string; loaded: boolean; goal: NativeGoal | null };
export interface NativePort {
  inspect(threadId: string): Promise<NativeThread>;
  candidates(workspace: string): Promise<NativeThread[]>;
  close(): void;
}

/** Read-only sidecar client. Never starts turns, resumes threads or sets goals. */
export class CodexClient implements NativePort {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(readonly url: string) {
    const parsed = new URL(url);
    requireThat(parsed.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname), 'CODEX_URL', 'Codex App Server must use a loopback WebSocket address.');
  }
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = (async () => {
      const socket = new WebSocket(this.url, { handshakeTimeout: 5000 });
      this.socket = socket;
      socket.on('message', data => {
        let message: { id?: number; result?: unknown; error?: { message: string } };
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (typeof message.id !== 'number') return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new BridgeError('CODEX_RPC', message.error.message));
        else pending.resolve(message.result);
      });
      socket.on('close', () => {
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError('CODEX_OFFLINE', 'Codex App Server disconnected.')); }
        this.pending.clear();
        if (this.socket === socket) this.socket = undefined;
      });
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      await this.raw('initialize', { clientInfo: { name: 'codex_web_goal', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: 'initialized' }));
    })();
    try { await this.connecting; }
    catch (error) { const socket = this.socket; this.socket = undefined; socket?.close(); throw error; }
    finally { this.connecting = undefined; }
  }
  private raw(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('CODEX_TIMEOUT', `Codex did not answer ${method}.`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async call<T>(method: string, params: unknown): Promise<T> {
    await this.connect();
    return await this.raw(method, params) as T;
  }
  async inspect(threadId: string): Promise<NativeThread> {
    const [read, goal] = await Promise.all([
      this.call<{ thread: { id: string; cwd: string; status?: { type: string } } }>('thread/read', { threadId, includeTurns: false }),
      this.call<{ goal?: NativeGoal | null }>('thread/goal/get', { threadId })
    ]);
    return { id: read.thread.id, cwd: read.thread.cwd, loaded: ['active', 'idle'].includes(read.thread.status?.type ?? ''), goal: goal.goal ?? null };
  }
  async candidates(workspace: string) {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const result: { data: string[]; nextCursor?: string | null } = await this.call('thread/loaded/list', { cursor, limit: 100 });
      ids.push(...result.data); cursor = result.nextCursor ?? null;
    } while (cursor && ids.length < 1000);
    const threads = await Promise.allSettled(ids.map(id => this.inspect(id)));
    return threads.flatMap(value => value.status === 'fulfilled' && path.resolve(value.value.cwd) === workspace ? [value.value] : []);
  }
  close() { this.socket?.close(); }
}
