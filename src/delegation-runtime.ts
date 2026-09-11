import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Bridge } from './bridge.js';
import { hash, equalSecret, requireThat, errorInfo, type Turn } from './shared.js';
import { contextDetailsSchema, digestObject, executionPolicySchema, type ContextDetails, type ContextEnvelope, type ExecutionPolicy, type ExecutionRun, type FrozenPolicy, type HostBinding, type Versions, type WakeEvent } from './execution-contract.js';
import type { DelegationHostPort } from './delegation-host.js';
import { sameBinding } from './delegation-host.js';
import type { RunnerPort } from './runner.js';

export class DelegationRuntime {
  private controllers = new Map<string, AbortController>();
  private tasks = new Set<Promise<void>>();
  private closing = false;
  private nextWakeAttempt = 0;
  constructor(readonly bridge: Bridge, readonly host?: DelegationHostPort, readonly runner?: RunnerPort) {}
  get state() { return this.bridge.state; }
  get policy() { return this.bridge.session?.executionPolicy; }
  redact(value: string) {
    let safe = value;
    for (const secret of [this.state.mcpToken, this.state.controlToken, this.state.extension?.secret, ...Object.values(this.state.turns).map(t => t.token)].filter((s): s is string => Boolean(s))) safe = safe.split(secret).join('[REDACTED]');
    return safe.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/https?:\/\/[^\s"']*\/(?:mcp\/)[^\s"']*/gi, '[REDACTED_CONNECTOR_URL]');
  }
  async freezePolicy(input: ExecutionPolicy): Promise<FrozenPolicy> {
    const parsed = executionPolicySchema.parse(input);
    requireThat(this.host, 'HOST_INTEGRATION_REQUIRED', 'Delegation needs an explicit host wait adapter. No polling fallback is allowed.');
    await this.host.capabilities();
    if (parsed.resultKind === 'verified-files') {
      requireThat(this.runner, 'RUNNER_REQUIRED', 'Verified-file delegation needs an isolated runner.'); await this.runner.preflight();
    }
    parsed.protectedFiles = [...new Set(await Promise.all(parsed.protectedFiles.map(async file => (await this.bridge.workspace.resolve(file)).relative)))];
    parsed.expectedFiles = [...new Set(await Promise.all(parsed.expectedFiles.map(async file => (await this.bridge.workspace.resolve(file)).relative)))];
    const protectedHashes: Record<string, string> = {};
    for (const file of parsed.protectedFiles) protectedHashes[file] = (await this.bridge.workspace.read(file)).sha256;
    for (const file of parsed.expectedFiles) await this.bridge.workspace.resolve(file);
    const policy = { ...parsed, version: 1, protectedHashes };
    return { ...policy, digest: digestObject(policy) };
  }
  binding(turn: Turn): HostBinding {
    const session = this.state.sessions[turn.sessionId]!;
    return { sessionId: session.id, turnId: turn.id, threadId: session.binding.threadId, ...(session.mode === 'task' ? { origin: { ...session.origin! } } : { goalFingerprint: session.binding.fingerprint }), contextVersion: turn.contextEnvelope!.version, policyVersion: session.executionPolicy!.version };
  }
  async prepareContext(turn: Turn, input: { task: string; context: string; criteria: string; contextDetails?: ContextDetails }) {
    const details = contextDetailsSchema.parse(input.contextDetails ?? {});
    const grants = this.bridge.delegation.resources.select(details.resourceIds, details.capabilityIds);
    for (const reference of details.references) requireThat((await this.bridge.workspace.read(reference.path)).sha256 === reference.sha256, 'CONTEXT_STALE', 'A context reference has changed.');
    const instructions = [...details.instructions];
    const roots = new Set(['', ...details.references.flatMap(ref => {
      const segments = path.posix.dirname(ref.path).split('/'); return segments.map((_s, i) => segments.slice(0, i + 1).join('/')).filter(p => p !== '.');
    })]);
    for (const root of roots) {
      const file = await this.bridge.workspace.current(path.posix.join(root, 'AGENTS.md'));
      if (file.content) instructions.push({ text: file.content, source: `repository:${file.path}@${file.sha256}` });
    }
    const body: Omit<ContextEnvelope, 'digest'> = { ...details, ...grants, instructions, version: turn.sequence, policyVersion: this.policy!.version,
      objective: this.bridge.session!.binding.objective, task: input.task, criteria: input.criteria, historySummary: input.context,
      workspaceRevision: await this.bridge.workspace.revision(), createdAt: Date.now(), authority: 'local-supervisor', historyAuthority: 'evidence-only', truncated: false };
    requireThat(JSON.stringify(body).length <= 60_000, 'CONTEXT_LIMIT', 'Context exceeds 60,000 characters; select relevant history without truncating mandatory instructions.');
    turn.contextEnvelope = { ...body, digest: digestObject(body) };
    await this.bridge.store.save();
    await this.park(turn);
  }
  async park(turn: Turn) {
    requireThat(this.host, 'HOST_INTEGRATION_REQUIRED', 'No host wait adapter.');
    try {
      const lease = await this.host.park(this.binding(turn));
      requireThat(sameBinding(lease, this.binding(turn)) && lease.state === 'waiting_external' && lease.expiresAt > Date.now(), 'HOST_NOT_PARKED', 'Host must confirm external wait before delegation.');
      turn.hostLease = lease; turn.executionBlocked = undefined;
    } catch (error) { turn.executionBlocked = `HOST_PARK_UNCERTAIN: ${this.redact(errorInfo(error).message)}`; }
    await this.bridge.store.save();
  }
  async assertLease(turn: Turn) {
    requireThat(this.host && turn.hostLease, 'HOST_NOT_PARKED', 'Host has not acknowledged this delegation.');
    const lease = await this.host.reconcile(turn.hostLease);
    requireThat(sameBinding(lease, this.binding(turn)) && lease.leaseId === turn.hostLease.leaseId && lease.state === 'waiting_external' && lease.expiresAt > Date.now(), 'HOST_LEASE_REVOKED', 'Host wait was revoked, expired or superseded.');
    turn.hostLease = lease;
  }
  async authorize(turnToken: string, versions: Versions, allowFinished = false) {
    const session = this.bridge.session, turn = this.bridge.turn;
    requireThat(session?.status === 'active' && session.executionPolicy && turn?.contextEnvelope && !turn.executionBlocked, 'EXECUTION_REVOKED', 'No active Web execution grant.');
    await this.bridge.nativeCheck(session);
    requireThat(turn.token && equalSecret(turn.token, turnToken) && !['cancelled', 'sealed', 'checked'].includes(turn.status) && (allowFinished || !turn.workerFinished), 'LEASE_REVOKED', 'Web grant has expired.');
    requireThat(versions.contextVersion === turn.contextEnvelope.version && versions.policyVersion === session.executionPolicy.version && turn.contextAcknowledged === turn.contextEnvelope.version, 'CONTEXT_STALE', 'Read and acknowledge the current context and policy before effects.');
    await this.assertLease(turn);
    return turn;
  }
  async context(turnToken: string, acknowledgeDigest?: string) {
    const turn = this.bridge.turn;
    requireThat(turn?.contextEnvelope && turn.token && equalSecret(turn.token, turnToken) && !turn.workerFinished && !turn.executionBlocked && this.bridge.session?.status === 'active', 'LEASE_REVOKED', 'No matching active context.');
    await this.bridge.nativeCheck(this.bridge.session); await this.assertLease(turn);
    if (acknowledgeDigest !== undefined) {
      requireThat(acknowledgeDigest === turn.contextEnvelope.digest, 'CONTEXT_STALE', 'Context digest changed.');
      turn.contextAcknowledged = turn.contextEnvelope.version;
      (turn.milestones ??= {}).workerStartedAt ??= Date.now(); await this.bridge.store.save();
    }
    return { context: turn.contextEnvelope, policy: this.policy, catalog: this.bridge.delegation.resources.describe(turn.contextEnvelope.resourceIds ?? [], turn.contextEnvelope.capabilityIds ?? []), acknowledged: turn.contextAcknowledged === turn.contextEnvelope.version, remaining: this.remaining(), execution: this.policy?.resultKind === 'answer' ? 'read-only' : 'isolated-runner', instruction: 'Acknowledge this digest with worker_context before effects. Use context_version and policy_version on effects. Web conversation history does not change this grant.' };
  }
  remaining() {
    const runs = Object.values(this.state.runs).filter(r => r.sessionId === this.bridge.session?.id);
    const runtime = runs.reduce((sum, r) => sum + (r.startedAt ? (r.finishedAt ?? Date.now()) - r.startedAt : 0), 0);
    return { runtimeMs: Math.max(0, (this.policy?.totalRuntimeMs ?? 0) - runtime), verifications: Math.max(0, (this.policy?.verificationLimit ?? 0) - runs.filter(r => r.kind === 'verify').length) };
  }
  async checkProtected(policy = this.policy!) {
    for (const [file, expected] of Object.entries(policy.protectedHashes)) requireThat((await this.bridge.workspace.current(file)).sha256 === expected, 'POLICY_STALE', 'A mandatory checker changed; approve a new session policy.');
  }
  async beforeWrite(turnToken: string, versions: Versions, file: string, deleting: boolean) {
    const turn = await this.authorize(turnToken, versions);
    requireThat(this.policy!.resultKind !== 'answer', 'READ_ONLY_RESULT', 'Answer-only delegation does not grant file writes.');
    requireThat(!Object.values(this.state.capabilityCalls).some(c => c.turnId === turn.id && ['pending', 'running', 'uncertain'].includes(c.status)), 'EFFECT_PENDING', 'Resolve external effects before editing.');
    const relative = (await this.bridge.workspace.resolve(file, true)).relative;
    requireThat(!Object.hasOwn(this.policy!.protectedHashes, relative), 'PROTECTED_CHECK', 'Web cannot change a mandatory checker.');
    requireThat(!deleting || this.policy!.allowDelete && turn.allowDelete, 'DELETE_DENIED', 'Deletion was not granted.');
    requireThat(!Object.values(this.state.runs).some(r => r.turnId === turn.id && ['queued', 'running'].includes(r.status)), 'RUN_ACTIVE', 'Wait for the snapshot run before editing source.');
    turn.validationState = 'stale';
    return turn.id;
  }
  async request(input: Versions & { requestId: string; turnToken: string; kind: 'exec' | 'verify'; argv?: string[]; cwd?: string; localServices?: number; timeoutMs?: number }) {
    return this.bridge.gate.run(async () => {
      requireThat(!this.closing, 'SHUTTING_DOWN', 'The runner is shutting down.');
      const turn = await this.authorize(input.turnToken, input);
      requireThat(this.policy!.resultKind !== 'answer' && this.runner, 'EXECUTION_NOT_GRANTED', 'This delegation has no isolated command grant.');
      requireThat(!Object.values(this.state.capabilityCalls).some(c => c.turnId === turn.id && ['pending', 'running', 'uncertain'].includes(c.status)), 'EFFECT_PENDING', 'Resolve external effects before executing.');
      requireThat(input.kind !== 'verify' || this.policy!.checks.length > 0, 'VERIFICATION_NOT_CONFIGURED', 'No mandatory execution checks are configured.');
      const requestHash = digestObject({ ...input, turnToken: undefined });
      const prior = Object.values(this.state.runs).find(r => r.turnId === turn.id && r.requestId === input.requestId);
      if (prior) { requireThat(prior.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Execution request ID was reused for different input.'); return this.result(prior.id); }
      requireThat(!Object.values(this.state.runs).some(r => ['queued', 'running'].includes(r.status)), 'RUN_ACTIVE', 'Only one run may execute at a time.');
      const remaining = this.remaining();
      if (remaining.runtimeMs <= 0 || input.kind === 'verify' && remaining.verifications <= 0) {
        turn.executionBlocked = 'EXECUTION_BUDGET'; this.enqueueWake(turn, 'needs_attention', 'Execution budget exhausted; work is not complete.'); await this.bridge.store.save();
        requireThat(false, 'EXECUTION_BUDGET', 'Execution budget exhausted.');
      }
      await this.checkProtected();
      const commands = input.kind === 'verify' ? this.policy!.checks.map(({ argv, cwd, localServices }) => ({ argv, cwd, localServices })) : [{ argv: input.argv!, cwd: input.cwd ?? '.', localServices: input.localServices }];
      for (const command of commands) {
        requireThat(command.argv?.length && command.argv.every(arg => typeof arg === 'string' && !arg.includes('\0')), 'COMMAND', 'Use an argv array without NUL.');
        requireThat(this.redact(JSON.stringify(command)) === JSON.stringify(command), 'SECRET_ARGUMENT', 'Do not pass bridge credentials to commands.');
        await this.bridge.workspace.resolve(command.cwd);
      }
      const id = randomUUID();
      const run: ExecutionRun = { id, requestId: input.requestId, requestHash, sessionId: turn.sessionId, turnId: turn.id, contextVersion: turn.contextEnvelope!.version, policyVersion: this.policy!.version, policyDigest: this.policy!.digest, revision: await this.bridge.workspace.revision(), kind: input.kind, commands, status: 'queued', createdAt: Date.now(), timeoutMs: Math.min(input.timeoutMs ?? this.policy!.commandTimeoutMs, this.policy!.commandTimeoutMs, remaining.runtimeMs), output: '', outputTruncated: false, checks: [], artifacts: [] };
      this.state.runs[id] = run; await this.bridge.store.save();
      // Scheduling and waiting happen in this process, not by making a model poll.
      setImmediate(() => { const task = this.execute(id); this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {}); });
      return this.result(id);
    });
  }
  private async execute(id: string) {
    const controller = new AbortController(); this.controllers.set(id, controller);
    const run = this.state.runs[id]!;
    try {
      await this.bridge.gate.run(async () => {
        requireThat(!this.closing && run.status === 'queued', 'RUN_CANCELLED', 'Run was cancelled before start.');
        const turn = this.state.turns[run.turnId]!;
        await this.authorize(turn.token, { contextVersion: run.contextVersion, policyVersion: run.policyVersion });
        run.status = 'running'; run.startedAt = Date.now(); await this.bridge.store.save();
      });
      const timeout = setTimeout(() => controller.abort(new Error('Execution deadline exceeded.')), run.timeoutMs);
      let evidence: Awaited<ReturnType<RunnerPort['run']>>;
      try {
        evidence = await this.runner!.run({ run: structuredClone(run), policy: structuredClone(this.state.sessions[run.sessionId]!.executionPolicy!), workspace: this.bridge.workspace, signal: controller.signal, output: chunk => {
          if (run.output.length + chunk.length > 1_000_000) { run.outputTruncated = true; controller.abort(new Error('Execution output limit exceeded.')); }
          run.output = this.redact(run.output + chunk).slice(0, 1_000_000);
        } });
      } finally { clearTimeout(timeout); }
      await this.bridge.gate.run(async () => {
        Object.assign(run, evidence);
        if (run.status !== 'running' || controller.signal.aborted) { run.status = 'cancelled'; run.error = this.redact(String(controller.signal.reason ?? 'Execution cancelled.')); }
        else {
          const turn = this.state.turns[run.turnId]!;
          await this.authorize(turn.token, { contextVersion: run.contextVersion, policyVersion: run.policyVersion });
          await this.checkProtected();
          if (await this.bridge.workspace.revision() !== run.revision || evidence.sourceChanged) run.status = 'stale';
          else run.status = evidence.checks.length === run.commands.length && evidence.checks.every((c, i) => c.exitCode === 0 && !c.timedOut && digestObject(c.argv) === digestObject(run.commands[i]!.argv)) ? 'passed' : 'failed';
          if (run.kind === 'verify' && run.status === 'passed') turn.validationState = undefined;
        }
      });
    } catch (error) {
      if (!['cancelled', 'uncertain'].includes(run.status)) run.status = 'failed';
      run.error = this.redact(errorInfo(error).message);
    } finally {
      this.controllers.delete(id);
      await this.bridge.gate.run(async () => { run.finishedAt = Date.now(); this.bridge.store.event('execution_finished', `${run.id}: ${run.status}`); await this.bridge.store.save(); });
    }
  }
  result(id: string, cursor = 0, limit = 8000) {
    const run = this.state.runs[id]; requireThat(run && run.sessionId === this.bridge.session?.id, 'RUN_MISSING', 'No run in this session.');
    requireThat(Number.isInteger(cursor) && cursor >= 0 && cursor <= run.output.length, 'LOG_CURSOR', 'Cursor is outside this run log.');
    const end = Math.min(run.output.length, cursor + Math.min(limit, 32_000));
    return { run_id: run.id, kind: run.kind, status: run.status, revision: run.revision, context_version: run.contextVersion, policy_version: run.policyVersion, checks: run.checks, artifacts: run.artifacts, sourceChanged: run.sourceChanged, environment: run.environment, output: this.redact(run.output.slice(cursor, end)), next_cursor: end, output_truncated: run.outputTruncated, error: run.error };
  }
  async cancel(id: string, turnToken: string, versions: Versions) {
    return this.bridge.gate.run(async () => { const turn = await this.authorize(turnToken, versions); const run = this.state.runs[id]; requireThat(run?.turnId === turn.id, 'RUN_MISSING', 'Run belongs to another turn.'); this.cancelRun(run); await this.bridge.store.save(); return this.result(id); });
  }
  private cancelRun(run: ExecutionRun) { if (['queued', 'running'].includes(run.status)) { run.status = 'cancelled'; this.controllers.get(run.id)?.abort(); } }
  async revoke(turn: Turn, reason: string) {
    this.bridge.delegation.revoke(turn.id);
    turn.executionBlocked = reason; turn.token = ''; turn.contextAcknowledged = undefined;
    for (const run of Object.values(this.state.runs)) if (run.turnId === turn.id) this.cancelRun(run);
    for (const event of Object.values(this.state.wakeEvents)) if (event.binding.turnId === turn.id && event.status === 'pending') event.status = 'revoked';
    if (turn.hostLease) { try { await this.host?.revoke(turn.hostLease); } catch { /* A disconnected host must expire its own lease, never auto-resume it. */ } turn.hostLease.state = 'revoked'; }
  }
  async finish(turnToken: string, summary: string, input: Versions & { runId?: string; outcome?: 'complete' | 'blocked'; evidence?: string[]; unresolved?: string[] }) {
    const turn = await this.authorize(turnToken, input);
    requireThat(!Object.values(this.state.runs).some(r => r.turnId === turn.id && ['queued', 'running'].includes(r.status)), 'RUN_ACTIVE', 'Wait for or cancel active execution.');
    requireThat(!Object.values(this.state.capabilityCalls).some(c => c.turnId === turn.id && c.status === 'running'), 'EFFECT_PENDING', 'Wait for the active external call.');
    if (input.outcome === 'blocked') {
      this.bridge.delegation.revoke(turn.id);
      turn.workerFinished = true; turn.workerReport = this.redact(summary); turn.executionBlocked = 'WORKER_BLOCKED';
      this.enqueueWake(turn, 'needs_attention', summary); await this.bridge.store.save(); return { ok: true, completionEligible: false };
    }
    requireThat(!this.bridge.delegation.hasUnsettledEffects(turn.id), 'EFFECT_PENDING', 'Reconcile pending execution or external effects before finishing.');
    const resultKind = this.policy!.resultKind ?? 'verified-files';
    const run = input.runId ? this.state.runs[input.runId] : undefined;
    if (resultKind === 'verified-files') requireThat(run && run.turnId === turn.id && run.kind === 'verify' && run.status === 'passed' && run.contextVersion === turn.contextEnvelope!.version && run.policyDigest === this.policy!.digest, 'VERIFICATION_REQUIRED', 'Finish requires trusted passing verification for this context and policy.');
    else requireThat(!input.runId, 'RESULT_CONTRACT', 'Non-execution results cannot claim runner validation.');
    await this.checkProtected();
    const revision = await this.bridge.workspace.revision();
    requireThat(!run || revision === run.revision, 'WORKSPACE_DRIFT', 'Reverify the current source before finishing.');
    if (resultKind === 'answer') requireThat(revision === turn.contextEnvelope!.workspaceRevision, 'CONTEXT_STALE', 'Source changed during analysis; refresh the delegation context.');
    const artifacts: { path: string; sha256: string }[] = [];
    for (const file of this.policy!.expectedFiles) {
      const read = await this.bridge.workspace.read(file);
      requireThat(!run || run.artifacts.some(a => a.path === file && a.sha256 === read.sha256), 'ARTIFACT_MISMATCH', 'Expected file read-back does not match verification.');
      artifacts.push({ path: file, sha256: read.sha256 });
    }
    requireThat(await this.bridge.workspace.revision() === revision, 'WORKSPACE_DRIFT', 'Source changed during read-back.');
    turn.workerFinished = true; turn.workerReport = this.redact(summary); turn.verifiedRunId = run?.id;
    turn.result = { kind: resultKind, summary: turn.workerReport, evidence: (input.evidence ?? []).map(s => this.redact(s)), unresolved: (input.unresolved ?? []).map(s => this.redact(s)), revision, artifacts, runId: run?.id };
    turn.token = ''; turn.revision = revision; turn.status = 'checked'; turn.validationState = undefined;
    const now = Date.now(); Object.assign(turn.milestones ??= {}, { workerFinishedAt: now, sealedAt: now, validatedAt: now });
    turn.checkpoint = { verdict: 'pass', summary: run ? 'Runner evidence and file read-back passed; native Goal unchanged.' : 'Result contract captured; semantic acceptance remains with the originating conversation. No execution validation claimed.', at: now, checks: run?.checks.map(c => ({ command: JSON.stringify(c.argv), exitCode: c.exitCode, summary: 'Captured by isolated runner' })) ?? [] };
    this.enqueueWake(turn, 'completion_candidate', `${turn.workerReport}\nResult: ${resultKind}, revision ${revision}. Return to the originating conversation for acceptance.`);
    await this.bridge.store.save(); return { ok: true, completionEligible: true, run_id: run?.id, revision, instruction: 'This delegation is sealed. The original request or Goal is not automatically completed.' };
  }
  enqueueWake(turn: Turn, kind: WakeEvent['kind'], summary: string) {
    const id = hash(`${turn.id}:${turn.contextEnvelope!.version}:${kind}`);
    this.state.wakeEvents[id] ??= { id, binding: this.binding(turn), kind, result: kind === 'completion_candidate' ? turn.result : undefined, summary: this.redact(summary).slice(0, 8000), createdAt: Date.now(), status: 'pending', attempts: 0 };
  }
  async tick() {
    if (this.closing) return;
    const turn = this.bridge.turn;
    if (!turn?.contextEnvelope || !this.policy) return;
    if (!turn.hostLease && turn.status === 'queued' && Date.now() - turn.createdAt < 120_000) { await this.park(turn); return; }
    if (!turn.workerFinished && !turn.executionBlocked) {
      try { await this.assertLease(turn); } catch { await this.revoke(turn, 'HOST_WAIT_LOST'); this.bridge.session!.status = 'paused'; await this.bridge.store.save(); return; }
    }
    if (Date.now() < this.nextWakeAttempt) return;
    for (const event of Object.values(this.state.wakeEvents)) {
      if (event.status !== 'pending' || event.binding.turnId !== turn.id || !turn.hostLease) continue;
      try {
        // Host must reconcile its durable receipt AND user-input generation atomically on resumeOnce.
        const lease = await this.host!.reconcile(turn.hostLease);
        if (!sameBinding(lease, event.binding) || ['revoked', 'unknown'].includes(lease.state) || lease.expiresAt <= Date.now()) { event.status = 'revoked'; continue; }
        if (event.kind === 'completion_candidate' && turn.revision && await this.bridge.workspace.revision() !== turn.revision) {
          event.status = 'revoked'; turn.validationState = 'stale'; turn.executionBlocked = 'WORKSPACE_DRIFT';
          this.enqueueWake(turn, 'needs_attention', 'Source changed after verification/seal; completion evidence is stale.');
          await this.bridge.store.save(); continue;
        }
        event.attempts++; await this.bridge.store.save();
        const receipt = await this.host!.resumeOnce(lease, event); event.status = receipt.status;
      } catch { this.nextWakeAttempt = Date.now() + 30_000; }
      await this.bridge.store.save();
    }
  }
  async recover() {
    for (const call of Object.values(this.state.capabilityCalls)) if (call.status === 'running') { call.status = 'uncertain'; call.output = 'Bridge restarted; reconcile the existing service call. It will not be replayed.'; }
    for (const run of Object.values(this.state.runs)) if (['queued', 'running'].includes(run.status)) { run.status = 'uncertain'; run.finishedAt = Date.now(); run.error = 'Bridge restarted; prior execution will not be replayed.'; }
    const turn = this.bridge.turn;
    if (turn?.contextEnvelope && !turn.workerFinished && Object.values(this.state.runs).some(r => r.turnId === turn.id && r.status === 'uncertain')) {
      turn.executionBlocked = 'EXECUTION_UNCERTAIN'; this.enqueueWake(turn, 'needs_attention', 'Execution outcome is uncertain after restart; inspect existing evidence before retrying.');
    }
    await this.bridge.store.save();
  }
  summary() {
    const turn = this.bridge.turn;
    const runs = Object.values(this.state.runs).filter(r => r.turnId === turn?.id);
    const latest = runs.at(-1);
    return { mode: this.policy ? 'web-controlled' : 'local-supervised', hostConfigured: Boolean(this.host), runnerConfigured: Boolean(this.runner), contextVersion: turn?.contextEnvelope?.version, contextAcknowledged: turn?.contextAcknowledged, hostWait: turn?.hostLease?.state, blocked: turn?.executionBlocked, latestRun: latest ? { id: latest.id, status: latest.status, kind: latest.kind, revision: latest.revision } : undefined, remaining: this.remaining(), wakeEvents: Object.values(this.state.wakeEvents).filter(e => e.binding.turnId === turn?.id).map(e => ({ id: e.id, kind: e.kind, status: e.status })),
      metrics: { runCount: runs.length, localAssistanceCount: Object.values(this.state.localAssists).filter(r => r.sessionId === this.bridge.session?.id).length, runnerWallMs: runs.reduce((sum, r) => sum + (r.startedAt ? (r.finishedAt ?? Date.now()) - r.startedAt : 0), 0), retainedLogCharacters: runs.reduce((sum, r) => sum + r.output.length, 0), nativeReportedGoalTokens: this.bridge.session?.mode === 'goal' ? this.bridge.nativeState?.goal?.tokensUsed ?? null : null, localModelRequestCount: null, webModelUsage: null } };
  }
  async diagnostics() {
    const probe = async (fn: () => Promise<unknown>) => { try { return { ok: true, details: await fn() }; } catch (error) { return { ok: false, error: this.redact(errorInfo(error).message) }; } };
    return { status: this.summary(), host: this.host ? await probe(() => this.host!.capabilities()) : { ok: false, error: 'Host wait adapter not configured; stock Codex integration remains incomplete.' }, runner: this.runner ? await probe(() => this.runner!.preflight()) : { ok: false, error: 'Runner not configured.' }, realHostZeroModelValidation: 'not-established-by-capability-handshake', tunnelReachability: 'not-tested' };
  }
  close() { this.closing = true; for (const run of Object.values(this.state.runs)) this.cancelRun(run); for (const controller of this.controllers.values()) controller.abort(); }
  async drain() { await new Promise<void>(resolve => setImmediate(resolve)); await Promise.allSettled([...this.tasks]); }
}
