import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const project = readJson('package.json');
const marketplace = readJson('.agents/plugins/marketplace.json');
const plugin = readJson('plugins/codex-web-goal/.codex-plugin/plugin.json');
const required = [
  '.agents/plugins/marketplace.json',
  'plugins/codex-web-goal/.codex-plugin/plugin.json',
  'plugins/codex-web-goal/.mcp.json',
  'plugins/codex-web-goal/dist/control-mcp.cjs',
  'plugins/codex-web-goal/THIRD_PARTY_NOTICES.txt',
  'plugins/codex-web-goal/skills/web-goal/SKILL.md'
];
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
for (const relative of required) {
  if (!tracked.has(relative)) throw new Error(`Distribution file is not tracked: ${relative}`);
  if (!fs.statSync(path.join(root, relative)).isFile()) throw new Error(`Distribution file is not regular: ${relative}`);
}
if (marketplace.name !== 'codex-web-goal') throw new Error('Marketplace name must be codex-web-goal.');
const entry = marketplace.plugins?.find(candidate => candidate.name === 'codex-web-goal');
if (entry?.source?.source !== 'local' || entry.source.path !== './plugins/codex-web-goal') {
  throw new Error('Marketplace source must resolve to ./plugins/codex-web-goal.');
}
if (plugin.name !== 'codex-web-goal' || plugin.version !== project.version) {
  throw new Error('Plugin name/version must match the public package.');
}
if (fs.statSync(path.join(root, 'plugins/codex-web-goal/dist/control-mcp.cjs')).size < 100_000) {
  throw new Error('Self-contained plugin MCP bundle is unexpectedly small.');
}
console.log(`Distribution manifest and ${required.length} tracked runtime files are ready for ${plugin.name}@${plugin.version}.`);
