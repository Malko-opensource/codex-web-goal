import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hash, requireThat } from './shared.js';

const OMIT = new Set(['.git', '.codex', '.agents', '.web-goal', 'node_modules', 'dist', 'build', 'coverage', '.next', '.cache', '.venv', 'vendor']);
const MAX_TEXT = 2 * 1024 * 1024;
const secretName = (name: string) => /^\.env(?:\.|$)/i.test(name) && !/^\.env\.(example|sample|template)$/i.test(name) ||
  /^(?:id_rsa|id_ed25519|credentials(?:\.json)?|auth\.json)$/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name);
async function syncParent(file: string) {
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export class Workspace {
  constructor(readonly root: string) {}
  async resolve(input: string, writing = false) {
    requireThat(input.length > 0 && !input.includes('\0'), 'PATH', 'A workspace path is required.');
    const absolute = path.resolve(this.root, input), relative = path.relative(this.root, absolute);
    requireThat(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'PATH_ESCAPE', 'Path is outside the selected workspace.');
    const parts = relative.split(path.sep).filter(Boolean);
    requireThat(parts.every(part => !OMIT.has(part) && !secretName(part)), 'PROTECTED_PATH', 'This path is excluded from remote access.');
    if (writing) requireThat(!parts.some(p => ['AGENTS.md', 'CLAUDE.md'].includes(p)) && relative !== '', 'PROTECTED_PATH', 'Remote edits cannot change agent instructions or the workspace root.');
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        requireThat(!stat.isSymbolicLink(), 'SYMLINK', 'Remote tools do not follow symlinks.');
        requireThat(stat.isDirectory() || stat.isFile(), 'SPECIAL_FILE', 'Only regular files and directories are supported.');
        if (stat.isFile()) requireThat(stat.nlink === 1, 'HARDLINK', 'Remote tools do not access multiply-linked files.');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return { absolute, relative: relative.split(path.sep).join('/') };
  }
  async read(input: string) {
    const { absolute, relative } = await this.resolve(input);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.size <= MAX_TEXT, 'FILE_LIMIT', 'Read requires a regular text file no larger than 2 MiB.');
      const bytes = await handle.readFile();
      requireThat(!bytes.includes(0), 'BINARY', 'Binary files are not supported by text tools.');
      const content = bytes.toString('utf8');
      requireThat(Buffer.from(content).equals(bytes), 'ENCODING', 'Text tools require valid UTF-8 without lossy decoding.');
      return { path: relative, content, sha256: hash(bytes) };
    } finally { await handle.close(); }
  }
  async current(input: string) {
    try { return await this.read(input); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: input, content: null, sha256: 'absent' };
      throw e;
    }
  }
  async write(input: string, content: string | null) {
    const { absolute } = await this.resolve(input, true);
    if (content === null) { await fs.unlink(absolute); await syncParent(absolute); return; }
    requireThat(Buffer.byteLength(content) <= MAX_TEXT && !content.includes('\0'), 'FILE_LIMIT', 'Write requires text no larger than 2 MiB.');
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await this.resolve(input, true);
    const temporary = path.join(path.dirname(absolute), `.web-goal-${randomUUID()}.tmp`);
    let mode = 0o644;
    try { mode = (await fs.stat(absolute)).mode & 0o777; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const handle = await fs.open(temporary, 'wx', mode);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, absolute);
    await syncParent(absolute);
  }
  async files() {
    const files: string[] = [];
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (OMIT.has(entry.name) || secretName(entry.name) || /^\.web-goal-.*\.tmp$/.test(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) files.push(path.relative(this.root, absolute).split(path.sep).join('/'));
        requireThat(files.length <= 20_000, 'WORKSPACE_LIMIT', 'Workspace exceeds 20,000 source files; choose a smaller project root.');
      }
    };
    await walk(this.root);
    return files.sort();
  }
  async revision() {
    const digest = createHash('sha256');
    for (const file of await this.files()) {
      const { absolute } = await this.resolve(file);
      digest.update(file).update('\0');
      const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk); }
      finally { await handle.close(); }
      digest.update('\0');
    }
    return digest.digest('hex');
  }
}
