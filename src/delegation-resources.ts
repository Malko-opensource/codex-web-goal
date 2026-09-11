import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { hash, requireThat } from './shared.js';
import { digestObject } from './execution-contract.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const description = z.string().min(1).max(1000);
const relative = z.string().min(1).max(1000).refine(s => !path.isAbsolute(s) && !s.split(/[\\/]/).includes('..'));
const schema = z.object({
  resources: z.array(z.discriminatedUnion('kind', [
    z.object({ id, description, kind: z.literal('skill'), root: z.string(), files: z.array(relative).min(1).max(64) }).strict(),
    z.object({ id, description, kind: z.literal('image'), path: z.string() }).strict(),
  ])).max(100).default([]),
  capabilities: z.array(z.object({ id, description, url: z.string().url(), tool: z.string().min(1).max(200),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    headerEnv: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
  }).strict()).max(40).default([]),
}).strict();
type Manifest = z.infer<typeof schema>;
type Resource = { id: string; kind: 'skill' | 'image'; description: string; digest: string; files: { name: string; absolute: string; sha256: string; size: number; mime?: string }[] };
type Capability = Manifest['capabilities'][number] & { digest: string };

async function safeBytes(file: string, limit: number) {
  requireThat(path.isAbsolute(file) && await fs.realpath(file) === file, 'RESOURCE_PATH', 'Resources must use canonical paths without symlinks.');
  requireThat(!/(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$|\.(?:key|pem|p12|pfx)$/i.test(file), 'RESOURCE_SECRET', 'Credential files cannot be shared as resources.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'RESOURCE_LIMIT', 'Resource must be an unlinked regular file within the size limit.');
    const bytes = await handle.readFile(); requireThat(bytes.length <= limit, 'RESOURCE_LIMIT', 'Resource grew beyond the limit.'); return bytes;
  } finally { await handle.close(); }
}
function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Only PNG, JPEG and WebP image resources are supported.');
}

/** Explicit local configuration, not discovery of every installed skill/plugin or credential. */
export class DelegationResources {
  private resources = new Map<string, Resource>();
  private capabilities = new Map<string, Capability>();
  static async load(file: string) {
    const bytes = await safeBytes(file, 256_000);
    return this.create(schema.parse(JSON.parse(bytes.toString('utf8'))));
  }
  static async create(input: Manifest) {
    const manifest = schema.parse(input), catalog = new DelegationResources();
    for (const item of manifest.resources) {
      requireThat(!catalog.resources.has(item.id), 'RESOURCE_ID', 'Resource IDs must be unique.');
      if (item.kind === 'skill') requireThat(item.files.includes('SKILL.md') && path.isAbsolute(item.root) && await fs.realpath(item.root) === item.root, 'SKILL_ROOT', 'Select a canonical skill root and include SKILL.md.');
      const files: Resource['files'] = []; let total = 0;
      for (const entry of item.kind === 'image' ? [{ name: 'image', absolute: item.path }] : item.files.map(name => ({ name, absolute: path.join(item.root, name) }))) {
        const bytes = await safeBytes(entry.absolute, item.kind === 'image' ? 8 * 1024 * 1024 : 2 * 1024 * 1024);
        total += bytes.length; requireThat(total <= 10 * 1024 * 1024, 'RESOURCE_LIMIT', 'A resource bundle is limited to 10 MiB.');
        if (item.kind === 'skill') requireThat(!bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes), 'RESOURCE_TEXT', 'Skill resources must be UTF-8 text.');
        files.push({ ...entry, sha256: hash(bytes), size: bytes.length, mime: item.kind === 'image' ? imageMime(bytes) : undefined });
      }
      catalog.resources.set(item.id, { id: item.id, description: item.description, kind: item.kind, files, digest: digestObject(files.map(({ absolute: _path, ...publicFile }) => publicFile)) });
    }
    for (const item of manifest.capabilities) {
      requireThat(!catalog.capabilities.has(item.id), 'CAPABILITY_ID', 'Capability IDs must be unique.');
      const url = new URL(item.url);
      requireThat(!url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 'CAPABILITY_URL', 'Configure HTTPS or explicit loopback MCP endpoints.');
      catalog.capabilities.set(item.id, { ...item, digest: digestObject(item) });
    }
    return catalog;
  }
  list() {
    return { resources: [...this.resources.values()].map(({ files: _files, ...r }) => r), capabilities: [...this.capabilities.values()].map(c => ({ id: c.id, description: c.description, digest: c.digest, approval: 'every-call', execution: 'configured-mcp-server' })) };
  }
  select(resourceIds: string[], capabilityIds: string[]) {
    const pin = (ids: string[], entries: Map<string, { digest: string }>) => [...new Set(ids)].map(id => { const entry = entries.get(id); requireThat(entry, 'RESOURCE_MISSING', 'Requested resource/capability is not configured.'); return { id, digest: entry.digest }; });
    return { resources: pin(resourceIds, this.resources), capabilities: pin(capabilityIds, this.capabilities) };
  }
  describe(resourceIds: string[], capabilityIds: string[]) {
    const listed = this.list(); return { resources: listed.resources.filter(r => resourceIds.includes(r.id)), capabilities: listed.capabilities.filter(c => capabilityIds.includes(c.id)).map(c => ({ ...c, inputSchema: this.capabilities.get(c.id)!.inputSchema })) };
  }
  async read(id: string, digest: string, file?: string, cursor = 0, limit = 8000) {
    const resource = this.resources.get(id); requireThat(resource?.digest === digest, 'RESOURCE_STALE', 'Resource grant no longer matches the configured bundle.');
    const selected = resource.files.find(f => f.name === (file ?? (resource.kind === 'skill' ? 'SKILL.md' : 'image')));
    requireThat(selected, 'RESOURCE_FILE', 'Only explicitly listed bundle files are available.');
    const bytes = await safeBytes(selected.absolute, resource.kind === 'image' ? 8 * 1024 * 1024 : 2 * 1024 * 1024);
    requireThat(hash(bytes) === selected.sha256, 'RESOURCE_STALE', 'Resource changed; approve a new context before reading it.');
    if (resource.kind === 'image') return { id, sha256: selected.sha256, mime: selected.mime!, image: bytes.toString('base64'), bytes: bytes.length, status: 'bytes_returned_not_proof_of_model_understanding' };
    const text = bytes.toString('utf8'); requireThat(cursor >= 0 && cursor <= text.length && Number.isInteger(cursor), 'RESOURCE_CURSOR', 'Invalid resource cursor.');
    const end = Math.min(text.length, cursor + Math.min(32000, limit));
    return { id, file: selected.name, sha256: selected.sha256, text: text.slice(cursor, end), next_cursor: end, total: text.length, files: resource.files.map(f => ({ name: f.name, sha256: f.sha256, size: f.size })), authority: 'reference-only-not-an-execution-grant' };
  }
  async call(id: string, digest: string, args: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
    const capability = this.capabilities.get(id); requireThat(capability?.digest === digest, 'CAPABILITY_STALE', 'Capability configuration changed.');
    const headers: Record<string, string> = {};
    for (const [header, env] of Object.entries(capability.headerEnv)) { requireThat(process.env[env], 'CAPABILITY_AUTH', 'Configured authentication is unavailable.'); headers[header] = process.env[env]!; }
    const client = new Client({ name: 'codex-web-goal-approved-relay', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(capability.url), { requestInit: { headers, redirect: 'error' } });
    try {
      await client.connect(transport, { timeout: 10_000 });
      const result = await client.callTool({ name: capability.tool, arguments: args }, undefined, { timeout: 60_000 });
      // Never convert upstream messages into control instructions or forward embedded resources automatically.
      const content = Array.isArray(result.content) ? result.content : [];
      let output = JSON.stringify({ content: content.filter(c => c.type === 'text'), omittedNonText: content.some(c => c.type !== 'text') });
      for (const secret of [...Object.values(headers), capability.url]) if (secret) output = output.split(secret).join('[REDACTED]');
      return { output: output.slice(0, 32_000), isError: result.isError === true };
    } finally { await client.close().catch(() => {}); }
  }
}
