import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, token, type State } from './shared.js';

export class Store {
  state!: State;
  constructor(readonly directory: string) {}
  async open(workspace: string) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
    try {
      this.state = JSON.parse(await fs.readFile(path.join(this.directory, 'state.json'), 'utf8')) as State;
      requireThat(this.state.version === 1, 'STATE_VERSION', 'Unsupported state version.');
      requireThat(this.state.workspace === workspace, 'WORKSPACE_CHANGED', 'Use a different state directory for a different workspace.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { version: 1, workspace, mcpToken: token(), controlToken: token(), sessions: {}, turns: {}, operations: {}, jobs: {}, events: [] };
      await this.save();
    }
  }
  event(kind: string, detail: string) {
    this.state.events.push({ at: Date.now(), kind, detail });
    this.state.events = this.state.events.slice(-300);
  }
  async save() {
    const destination = path.join(this.directory, 'state.json');
    const temp = `${destination}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, destination);
    // POSIX directory fsync makes the rename durable; Windows does not support opening directories.
    if (process.platform !== 'win32') {
      const directory = await fs.open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async backup(content: string) {
    const directory = path.join(this.directory, 'backups');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${randomUUID()}.txt`;
    const backup = await fs.open(path.join(directory, name), 'wx', 0o600);
    try { await backup.writeFile(content); await backup.sync(); } finally { await backup.close(); }
    if (process.platform !== 'win32') {
      const handle = await fs.open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    return name;
  }
}
