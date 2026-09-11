import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bridge } from './bridge.js';
import { requireThat, errorInfo, VERSION } from './shared.js';
import { executionPolicySchema, contextDetailsSchema, commandSchema } from './execution-contract.js';

export type Tool = {
  name: string; description: string; schema: z.ZodObject<z.ZodRawShape>;
  readOnly: boolean; execute: (input: unknown) => Promise<unknown>;
  resourceContent?: boolean;
};
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, readOnly: boolean,
  handler: (input: z.infer<z.ZodObject<S>>) => Promise<unknown> | unknown): Tool {
  const schema = z.object(shape).strict();
  return { name, description, schema: schema as z.ZodObject<z.ZodRawShape>, readOnly, execute: async input => handler(schema.parse(input)) };
}
const str = () => z.string().min(1).max(2000);
const turnToken = z.string().max(100).optional();
const versions = { context_version: z.number().int().positive().optional(), policy_version: z.number().int().positive().optional() };
const mutation = { operation_id: z.string().uuid(), path: str(), expected_sha256: z.string().regex(/^(absent|[a-f0-9]{64})$/), turn_token: turnToken, ...versions };

export function remoteTools(bridge: Bridge): Tool[] {
  const tools = [
    tool('workspace_info', 'Read the workspace and workflow. Legacy direct tasks use approved commands. Shared request/Goal delegations require a context-bound turn token.', {}, true,
      () => ({ workspace: bridge.workspace.root, mode: bridge.session?.status === 'closed' ? 'direct' : bridge.session?.mode ?? 'direct', rootRules: 'Read AGENTS.md if present. Paths are restricted to this workspace. The originating conversation owns final acceptance; worker_context defines the execution and result contract.' })),
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
    tool('workspace_write', 'Create or replace a text file. Use expected_sha256=absent for new files. Reuse operation_id ONLY for the same request. Delegated edits require turn_token and current context/policy versions.', { ...mutation, content: z.string().max(2 * 1024 * 1024) }, false,
      ({ operation_id, expected_sha256, turn_token, context_version, policy_version, ...rest }) => bridge.mutate({ ...rest, operationId: operation_id, expectedHash: expected_sha256, turnToken: turn_token, contextVersion: context_version, policyVersion: policy_version })),
    tool('workspace_edit', 'Apply exact text replacements to one file. Each old_text must occur exactly once. Atomic per file, guarded by whole-file SHA256.', { ...mutation, edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() }).strict()).min(1).max(50) }, false,
      ({ operation_id, expected_sha256, turn_token, context_version, policy_version, path, edits }) => bridge.mutate({ operationId: operation_id, expectedHash: expected_sha256, turnToken: turn_token, contextVersion: context_version, policyVersion: policy_version, path, edits: edits.map(e => ({ oldText: e.old_text, newText: e.new_text })) })),
    tool('workspace_delete', 'Delete one file with its expected hash. A backup is preserved. Goal turns require an explicit deletion grant.', mutation, false,
      ({ operation_id, expected_sha256, turn_token, context_version, policy_version, path }) => bridge.mutate({ operationId: operation_id, expectedHash: expected_sha256, turnToken: turn_token, contextVersion: context_version, policyVersion: policy_version, path, delete: true })),
    tool('worker_context', 'Read canonical context and granted policy. In web-controlled mode call again with acknowledge_digest before effects; acknowledgement is not proof of understanding.', { turn_token: z.string().min(1).max(100), acknowledge_digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }, false,
      async ({ turn_token, acknowledge_digest }) => { requireThat(bridge.session, 'NO_SESSION', 'No active session.'); await bridge.nativeCheck(bridge.session); return bridge.workerContext(turn_token, acknowledge_digest); }),
    tool('worker_finish', 'Submit the selected result contract. Only verified-files requires a passing verification run_id. Files require read-back; answer results claim no execution validation. outcome=blocked requests attention.', { turn_token: z.string().min(1).max(100), summary: z.string().min(1).max(8000), ...versions, run_id: z.string().uuid().optional(), outcome: z.enum(['complete', 'blocked']).default('complete'), evidence: z.array(z.string().max(1000)).max(20).default([]), unresolved: z.array(z.string().max(1000)).max(20).default([]) }, false,
      ({ turn_token, summary, context_version, policy_version, run_id, outcome, evidence, unresolved }) => bridge.workerFinish(turn_token, summary, { contextVersion: context_version, policyVersion: policy_version, runId: run_id, outcome, evidence, unresolved })),
    tool('worker_resource_read', 'Read only selected skill bundle files or image bytes. Images return MCP image content, not a browser composer attachment. Skill instructions do not grant tools. Use cursor for full text.', { turn_token: z.string().min(1).max(100), ...versions, resource_id: str(), file: str().optional(), cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32000).default(8000) }, true,
      ({ turn_token, context_version, policy_version, resource_id, file, cursor, limit }) => bridge.delegation.readResource(turn_token, { contextVersion: context_version, policyVersion: policy_version }, resource_id, file, cursor, limit)),
    tool('worker_request_local', 'Request bounded local Codex work in the originating conversation. Suspends Web effects; this is a normal handoff, not completion. Requires host support. Reuse request_id for identical input.', { turn_token: z.string().min(1).max(100), ...versions, request_id: str(), task: z.string().min(1).max(8000), reason: z.string().min(1).max(2000) }, false,
      ({ turn_token, context_version, policy_version, request_id, task, reason }) => bridge.delegation.requestLocal(turn_token, { contextVersion: context_version, policyVersion: policy_version }, request_id, task, reason)),
    tool('worker_capability_request', 'Request a selected MCP tool with exact arguments. The local dashboard must approve each call; no credentials or endpoint URLs in arguments. Unknown effects are not retried.', { turn_token: z.string().min(1).max(100), ...versions, request_id: str(), capability_id: str(), arguments: z.record(z.string(), z.unknown()) }, false,
      ({ turn_token, context_version, policy_version, request_id, capability_id, arguments: args }) => bridge.delegation.requestCapability(turn_token, { contextVersion: context_version, policyVersion: policy_version }, request_id, capability_id, args)),
    tool('worker_capability_result', 'Read bounded stored output of an approved MCP call without repeating it. Default 4,000 characters; cursor fetches more.', { turn_token: z.string().min(1).max(100), ...versions, call_id: z.string().uuid(), cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32000).default(4000) }, true,
      ({ turn_token, context_version, policy_version, call_id, cursor, limit }) => bridge.delegation.capabilityResult(turn_token, { contextVersion: context_version, policyVersion: policy_version }, call_id, cursor, limit)),
    tool('workspace_exec', 'Execute argv inside a disposable Mac sandbox. Internet is public-only through a proxy. Source changes in the copy are not applied to the workspace. Reuse request_id to query the same request; never retry an uncertain run under a new ID without reconciliation.', { ...commandSchema.shape, ...versions, turn_token: z.string().min(1).max(100), request_id: str(), timeout_ms: z.number().int().min(1000).max(3_600_000).optional() }, false,
      ({ argv, cwd, localServices, context_version, policy_version, turn_token, request_id, timeout_ms }) => bridge.execution.request({ kind: 'exec', argv, cwd, localServices, contextVersion: context_version, policyVersion: policy_version, turnToken: turn_token, requestId: request_id, timeoutMs: timeout_ms })),
    tool('workspace_verify', 'Run ALL fixed required checks against a source snapshot. Web cannot supply exit codes or relax this policy.', { ...versions, turn_token: z.string().min(1).max(100), request_id: str() }, false,
      ({ context_version, policy_version, turn_token, request_id }) => bridge.execution.request({ kind: 'verify', contextVersion: context_version, policyVersion: policy_version, turnToken: turn_token, requestId: request_id })),
    tool('workspace_job_result', 'Read bounded execution evidence/log deltas from this session. This never reruns a command.', { run_id: z.string().uuid(), cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(32_000).default(8000) }, true,
      ({ run_id, cursor, limit }) => bridge.execution.result(run_id, cursor, limit)),
    tool('workspace_job_cancel', 'Cancel this turn\'s run and its process group. Cancellation does not undo already produced effects.', { ...versions, turn_token: z.string().min(1).max(100), run_id: z.string().uuid() }, false,
      ({ run_id, turn_token, context_version, policy_version }) => bridge.execution.cancel(run_id, turn_token, { contextVersion: context_version, policyVersion: policy_version })),
    tool('command_request', 'Request a local shell command for an ordinary Web task. A human must approve the exact command in the dashboard. Unavailable during Goal/Plan.', { command: z.string().min(1).max(12_000), cwd: str().default('.'), timeout_ms: z.number().int().min(1000).max(600_000).default(120_000) }, false,
      ({ command, cwd, timeout_ms }) => bridge.requestCommand(command, cwd, timeout_ms)),
    tool('command_status', 'Read output/status of a locally approved direct-mode command.', { job_id: z.string().uuid() }, true,
      ({ job_id }) => { const job = bridge.state.jobs[job_id]; requireThat(job, 'JOB_MISSING', 'Unknown command job.'); return job; })
  ];
  tools.find(t => t.name === 'worker_resource_read')!.resourceContent = true;
  return tools;
}

export function controlTools(bridge: Bridge): Tool[] {
  return [
    tool('delegation_open', 'Open a shared Web delegation for an ordinary request or an active Goal. Ordinary requests need no Goal or mode switch. Host support is mandatory; this tool does not implement the host scheduler.', { kind: z.enum(['request', 'goal']), thread_id: str().optional(), origin_request_id: str().optional(), input_version: z.number().int().positive().optional(), objective: z.string().min(1).max(8000).optional(), policy: executionPolicySchema }, false,
      ({ kind, thread_id, origin_request_id, input_version, objective, policy }) => {
        if (kind === 'request') requireThat(origin_request_id && input_version && objective, 'REQUEST_ORIGIN', 'Provide origin_request_id, input_version and objective.');
        return bridge.open(kind === 'request' ? 'task' : 'goal', thread_id, policy, kind === 'request' ? { requestId: origin_request_id!, inputVersion: input_version!, objective: objective! } : undefined);
      }),
    tool('delegation_catalog', 'List descriptions and digests of explicitly configured resources and capabilities, not all installed plugins. Select IDs in the dispatch context.', {}, true, () => bridge.delegation.resources.list()),
    tool('delegation_dispatch', 'Delegate one task using the shared lifecycle. No automatic Goal creation. Preserve required instructions; select only relevant resourceIds and capabilityIds.', { request_id: str(), task: z.string().min(1).max(35000), context: z.string().max(15000).default(''), criteria: z.string().min(1).max(5000), allow_delete: z.boolean().default(false), context_details: contextDetailsSchema.optional() }, false,
      ({ request_id, allow_delete, context_details, ...rest }) => bridge.dispatch({ ...rest, requestId: request_id, allowDelete: allow_delete, contextDetails: context_details })),
    tool('delegation_status', 'Compact state for the shared delegation; program/host owns normal waiting. Unknown usage is not zero.', {}, true, () => bridge.compactView()),
    tool('delegation_result', 'Retrieve a stored delegation result by turn ID. Does not wake a model or repeat a Web request. The origin retains semantic acceptance.', { turn_id: z.string().uuid() }, true,
      async ({ turn_id }) => { const turn = bridge.state.turns[turn_id]; requireThat(turn, 'TURN_MISSING', 'Unknown delegation.'); return { turn_id, status: turn.status, result: turn.result, stale: turn.validationState === 'stale' || Boolean(turn.revision && turn.revision !== await bridge.workspace.revision()), returnEvents: Object.values(bridge.state.wakeEvents).filter(e => e.binding.turnId === turn_id).map(e => ({ id: e.id, kind: e.kind, status: e.status })) }; }),
    tool('delegation_control', 'Pause/resume/cancel/close this delegation, never the originating Goal. Old grants do not revive.', { action: z.enum(['pause', 'resume', 'cancel', 'close']) }, false, ({ action }) => bridge.control(action)),
    tool('delegation_assistance_result', 'Return the result of requested local work. Does not restore Web permissions: review, resume, then dispatch a fresh context. Late origin results are rejected.', { assistance_id: z.string().uuid(), outcome: z.enum(['resolved', 'declined']), summary: z.string().min(1).max(8000) }, false,
      ({ assistance_id, outcome, summary }) => bridge.delegation.resolveLocal(assistance_id, outcome, summary)),
    tool('web_goal_status', 'Read bridge state, Web results, local checkpoints and connection status. No goal mutation.', {}, true, () => bridge.view()),
    tool('web_goal_snapshot', 'Read compact actionable status without full conversation or logs. Host, not the model, owns external waiting.', {}, true, () => bridge.compactView()),
    tool('web_goal_diagnostics', 'Probe configured host and runner capabilities without model calls. Does not claim real-host zero-model acceptance or public tunnel reachability.', {}, true, () => bridge.execution.diagnostics()),
    tool('web_goal_threads', 'List loaded native Codex threads in the selected workspace. Use the matching ID when opening a session.', {}, true, () => bridge.native.candidates(bridge.workspace.root)),
    tool('web_goal_open', 'Bind to a real native Goal. Optional web-controlled execution requires configured host wait integration and isolated runner. Existing sessions cannot silently change policy.', { mode: z.enum(['plan', 'goal']), thread_id: str().optional(), execution_policy: executionPolicySchema.optional() }, false,
      ({ mode, thread_id, execution_policy }) => bridge.open(mode, thread_id, execution_policy)),
    tool('web_goal_invalidate_context', 'Stop the current delegation when user instructions/context change. Revokes grants and queued wakes; resume then dispatch a new explicit context. Does not replace native Goal.', { reason: z.string().min(1).max(2000) }, false,
      async ({ reason }) => { const result = await bridge.control('pause'); bridge.store.event('context_invalidated', bridge.execution.redact(reason)); await bridge.store.save(); return result; }),
    tool('web_goal_control', 'Pause/resume/cancel/close BRIDGE delivery and write grants. Does not modify native Goal state. Pause/cancel revokes old grants.', { action: z.enum(['pause', 'resume', 'cancel', 'close']) }, false,
      ({ action }) => bridge.control(action)),
    tool('web_goal_dispatch', 'Send exactly one task to the bound Web conversation. Reuse request_id when retrying the same submission. Previous turn must be locally checkpointed.', {
      request_id: str(), task: z.string().min(1).max(35_000), context: z.string().max(15_000).default(''), criteria: z.string().min(1).max(5000), allow_delete: z.boolean().default(false), context_details: contextDetailsSchema.optional()
    }, false, ({ request_id, allow_delete, context_details, ...rest }) => bridge.dispatch({ ...rest, requestId: request_id, allowDelete: allow_delete, contextDetails: context_details })),
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
    try {
      const result = await spec.execute(input);
      if (spec.resourceContent && result && typeof result === 'object' && 'image' in result && 'mime' in result) {
        const { image, mime, ...metadata } = result as { image: string; mime: string; [key: string]: unknown };
        return { content: [{ type: 'text' as const, text: JSON.stringify(metadata) }, { type: 'image' as const, data: image, mimeType: mime }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorInfo(error)) }] }; }
  });
  return server;
}
