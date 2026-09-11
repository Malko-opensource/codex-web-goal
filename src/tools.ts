import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bridge } from './bridge.js';
import { requireThat, errorInfo, VERSION } from './shared.js';

export type Tool = {
  name: string; description: string; schema: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean; execute: (input: unknown) => Promise<unknown>;
};
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, readOnly: boolean,
  handler: (input: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown): Tool {
  const schema = z.object(shape).strict();
  return { name, description, schema: schema as z.ZodObject<z.ZodRawShape>, readOnly, execute: async input => handler(schema.parse(input)) };
}
const str = () => z.string().min(1).max(2000);
const turnToken = z.string().max(100).optional();
const mutation = { operation_id: z.string().uuid(), path: str(), expected_sha256: z.string().regex(/^(absent|[a-f0-9]{64})$/), turn_token: turnToken };

export function remoteTools(bridge: Bridge): Tool[] {
  return [
    tool('workspace_info', 'Read the selected workspace and workflow. Plain tasks use file tools and locally approved commands. Goal tasks use a turn token.', {}, true,
      () => ({ workspace: bridge.workspace.root, mode: bridge.session?.status === 'closed' ? 'direct' : bridge.session?.mode ?? 'direct', rootRules: 'Read AGENTS.md if present. Paths are restricted to this workspace. Native Codex owns Goal verification.' })),
    tool('workspace_list', 'List source files relative to the workspace. Generated folders, credentials and symlinks are excluded.', { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(200) }, true,
      async ({ offset, limit }) => { const files = await bridge.workspace.files(); return { files: files.slice(offset, offset + limit), total: files.length }; }),
    tool('workspace_read', 'Read a text file. sha256 covers the whole file and is required for edits. line_start is one-based.', { path: str(), line_start: z.number().int().min(1).default(1), line_count: z.number().int().min(1).max(2000).default(300) }, true,
      async ({ path, line_start, line_count }) => { const file = await bridge.workspace.read(path); const lines = file.content.split('\n'); return { path: file.path, sha256: file.sha256, content: lines.slice(line_start - 1, line_start - 1 + line_count).join('\n'), line_start, total_lines: lines.length }; }),
    tool('workspace_search', 'Literal text search in source files; returns bounded line snippets, not a shell or regular expression.', { query: z.string().min(1).max(500), limit: z.number().int().min(1).max(100).default(40) }, true,
      async ({ query, limit }) => {
        const matches: { path: string; line: number; text: string }[] = [];
        for (const file of await bridge.workspace.files()) {
          try { const { content } = await bridge.workspace.read(file); content.split('\n').forEach((line, i) => { if (matches.length < limit && line.includes(query)) matches.push({ path: file, line: i + 1, text: line.slice(0, 400) }); }); } catch { /* Binary/protected files are not search results. */ }
          if (matches.length >= limit) break;
        }
        return { matches, truncated: matches.length >= limit };
      }),
    tool('workspace_write', 'Create or replace a text file. Use expected_sha256=absent for new files. Reuse operation_id ONLY for the same request. Include turn_token for Goal edits.', { ...mutation, content: z.string().max(2 * 1024 * 1024) }, false,
      ({ operation_id, expected_sha256, turn_token, ...rest }) => bridge.mutate({ ...rest, operationId: operation_id, expectedHash: expected_sha256, turnToken: turn_token })),
    tool('workspace_edit', 'Apply exact text replacements to one file. Each old_text must occur exactly once. Atomic per file, guarded by whole-file SHA256.', { ...mutation, edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() }).strict()).min(1).max(50) }, false,
      ({ operation_id, expected_sha256, turn_token, path, edits }) => bridge.mutate({ operationId: operation_id, expectedHash: expected_sha256, turnToken: turn_token, path, edits: edits.map(e => ({ oldText: e.old_text, newText: e.new_text })) })),
    tool('workspace_delete', 'Delete one file with its expected hash. A backup is preserved. Goal turns require an explicit deletion grant.', mutation, false,
      ({ operation_id, expected_sha256, turn_token, path }) => bridge.mutate({ operationId: operation_id, expectedHash: expected_sha256, turnToken: turn_token, path, delete: true })),
    tool('worker_context', 'Call first for an automated Goal turn. Returns its task and granted capabilities. Never changes native Goal state.', { turn_token: z.string().min(1).max(100) }, true,
      async ({ turn_token }) => { requireThat(bridge.session, 'NO_SESSION', 'No active session.'); await bridge.nativeCheck(bridge.session); return bridge.workerContext(turn_token); }),
    tool('worker_finish', 'Call after all work for this Web turn, before your final answer. Closes the write grant so local Codex can safely verify.', { turn_token: z.string().min(1).max(100), summary: z.string().min(1).max(8000) }, false,
      ({ turn_token, summary }) => bridge.workerFinish(turn_token, summary)),
    tool('command_request', 'Request a local shell command for an ordinary Web task. A human must approve the exact command in the dashboard. Unavailable during Goal/Plan.', { command: z.string().min(1).max(12_000), cwd: str().default('.'), timeout_ms: z.number().int().min(1000).max(600_000).default(120_000) }, false,
      ({ command, cwd, timeout_ms }) => bridge.requestCommand(command, cwd, timeout_ms)),
    tool('command_status', 'Read output/status of a locally approved direct-mode command.', { job_id: z.string().uuid() }, true,
      ({ job_id }) => { const job = bridge.state.jobs[job_id]; requireThat(job, 'JOB_MISSING', 'Unknown command job.'); return job; })
  ];
}

export function controlTools(bridge: Bridge): Tool[] {
  return [
    tool('web_goal_status', 'Read bridge state, Web results, local checkpoints and connection status. No goal mutation.', {}, true, () => bridge.view()),
    tool('web_goal_threads', 'List loaded native Codex threads in the selected workspace. Use the matching ID when opening a session.', {}, true, () => bridge.native.candidates(bridge.workspace.root)),
    tool('web_goal_open', 'Bind to a real loaded Codex thread. Goal mode requires an active native /goal; plan mode never grants file writes.', { mode: z.enum(['plan', 'goal']), thread_id: str().optional() }, false,
      ({ mode, thread_id }) => bridge.open(mode, thread_id)),
    tool('web_goal_control', 'Pause/resume/cancel/close BRIDGE delivery and write grants. Does not modify native Goal state. Pause/cancel revokes old grants.', { action: z.enum(['pause', 'resume', 'cancel', 'close']) }, false,
      ({ action }) => bridge.control(action)),
    tool('web_goal_dispatch', 'Send exactly one task to the bound Web conversation. Reuse request_id when retrying the same submission. Previous turn must be locally checkpointed.', {
      request_id: str(), task: z.string().min(1).max(35_000), context: z.string().max(15_000).default(''), criteria: z.string().min(1).max(5000), allow_delete: z.boolean().default(false)
    }, false, ({ request_id, allow_delete, ...rest }) => bridge.dispatch({ ...rest, requestId: request_id, allowDelete: allow_delete })),
    tool('web_goal_wait', 'Wait up to 30 seconds for the named Web turn. Return a confirmed response or actionable status; never create another request because a wait timed out.', { turn_id: z.string().uuid(), wait_ms: z.number().int().min(0).max(30_000).default(25_000) }, true,
      ({ turn_id, wait_ms }) => bridge.wait(turn_id, wait_ms)),
    tool('web_goal_seal', 'Revoke Web writes and hash the source tree before LOCAL execution/verification. May reseal after local changes, before rerunning tests.', {}, false, () => bridge.seal()),
    tool('web_goal_checkpoint', 'Record locally executed evidence for the sealed revision. Rejects source drift. Does not mark the native Goal complete.', {
      revision: z.string().regex(/^[a-f0-9]{64}$/), verdict: z.enum(['pass', 'fail', 'blocked']), summary: z.string().min(1).max(8000),
      checks: z.array(z.object({ command: str(), exitCode: z.number().int().nullable(), summary: z.string().max(8000) }).strict()).max(40)
    }, false, input => bridge.checkpoint(input))
  ];
}

export function mcpServer(specs: Tool[], label: string) {
  const server = new McpServer({ name: label, version: VERSION }, { instructions: 'Use this project only for the workspace and chat explicitly selected by the user. Tool descriptions specify execution boundaries.' });
  for (const spec of specs) server.registerTool(spec.name, {
    description: spec.description, inputSchema: spec.schema.shape,
    annotations: { readOnlyHint: spec.readOnly, destructiveHint: !spec.readOnly, openWorldHint: true }
  }, async input => {
    try { const result = await spec.execute(input); return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorInfo(error)) }] }; }
  });
  return server;
}
