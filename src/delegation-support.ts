import { randomUUID } from 'node:crypto';
import type { Bridge } from './bridge.js';
import { requireThat, equalSecret } from './shared.js';
import { digestObject, type Versions } from './execution-contract.js';
import { DelegationResources } from './delegation-resources.js';

/** Shared adjuncts for ordinary requests and Goal delegations; no native model calls. */
export class DelegationSupport {
  private tasks = new Set<Promise<void>>();
  constructor(readonly bridge: Bridge, readonly resources = new DelegationResources()) {}
  async readResource(token: string, versions: Versions, id: string, file?: string, cursor?: number, limit?: number) {
    return this.bridge.gate.run(async () => {
      const turn = await this.bridge.execution.authorize(token, versions);
      const grant = turn.contextEnvelope!.resources?.find(r => r.id === id);
      requireThat(grant, 'RESOURCE_NOT_GRANTED', 'The local context did not select this resource.');
      const result = await this.resources.read(id, grant.digest, file, cursor, limit);
      this.bridge.store.event('resource_returned', `${turn.id}:${id}:${result.sha256}`); await this.bridge.store.save();
      return result;
    });
  }
  async requestLocal(token: string, versions: Versions, requestId: string, task: string, reason: string) {
    return this.bridge.gate.run(async () => {
      const existing = Object.values(this.bridge.state.localAssists).find(r => r.turnId === this.bridge.turn?.id && r.requestId === requestId);
      const requestHash = digestObject({ ...versions, task, reason });
      if (existing) {
        requireThat(this.bridge.turn?.token && equalSecret(token, this.bridge.turn.token) && existing.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Local assistance request changed or its grant was revoked.');
        return existing;
      }
      const turn = await this.bridge.execution.authorize(token, versions);
      requireThat((await this.bridge.execution.host?.capabilities())?.localAssistance === true, 'HOST_ASSISTANCE_UNSUPPORTED', 'Host cannot route bounded local work to the original conversation.');
      requireThat(!this.hasUnsettledEffects(turn.id), 'EFFECT_PENDING', 'Resolve execution and external effects before a local handoff.');
      requireThat(Object.values(this.bridge.state.localAssists).filter(r => r.sessionId === turn.sessionId).length < (this.bridge.session!.executionPolicy!.maxLocalAssists ?? 3), 'ASSISTANCE_BUDGET', 'Local handoff limit reached; ask the user to review scope.');
      const id = randomUUID();
      const request = { id, requestId, requestHash, sessionId: turn.sessionId, turnId: turn.id, contextVersion: turn.contextEnvelope!.version, task: this.bridge.execution.redact(task), reason: this.bridge.execution.redact(reason), status: 'pending' as const, createdAt: Date.now() };
      this.bridge.state.localAssists[id] = request; turn.executionBlocked = 'LOCAL_ASSISTANCE_PENDING';
      this.bridge.execution.enqueueWake(turn, 'local_assistance', `Local work requested: ${request.task}\nReason: ${request.reason}\nReturn a bounded result for assistance ${id}. Web effects are suspended; this is not a completion claim.`);
      const event = Object.values(this.bridge.state.wakeEvents).find(e => e.binding.turnId === turn.id && e.kind === 'local_assistance')!;
      event.assistanceId = id; await this.bridge.store.save(); return request;
    });
  }
  async resolveLocal(id: string, outcome: 'resolved' | 'declined', summary: string) {
    return this.bridge.gate.run(async () => {
      const request = this.bridge.state.localAssists[id], turn = this.bridge.turn;
      requireThat(request && turn?.id === request.turnId, 'ASSISTANCE_STALE', 'This result does not belong to the current delegation.');
      const safe = this.bridge.execution.redact(summary);
      if (request.status === outcome && request.summary === safe) return { ...request, replay: true };
      requireThat(request.status === 'pending' && this.bridge.session?.status === 'active', 'ASSISTANCE_STALE', 'Local result arrived after cancellation or replacement.');
      await this.bridge.nativeCheck(this.bridge.session);
      // A resumed lease is expected here; only an exact, unrevoked origin may accept the return.
      const lease = await this.bridge.execution.host!.reconcile(turn.hostLease!);
      const { sameBinding } = await import('./delegation-host.js');
      requireThat(sameBinding(lease, this.bridge.execution.binding(turn)) && lease.leaseId === turn.hostLease!.leaseId && lease.state === 'resumed' && lease.expiresAt > Date.now(), 'ASSISTANCE_STALE', 'The originating host request was superseded.');
      request.status = outcome; request.summary = safe;
      await this.bridge.execution.revoke(turn, 'LOCAL_ASSISTANCE_RETURNED');
      turn.status = 'handed_off'; this.bridge.session.status = 'paused';
      await this.bridge.store.save();
      return { ...request, instruction: 'Review the local result, resume this session, then dispatch a new context/request_id. Old Web tokens and evidence cannot be reused.' };
    });
  }
  hasUnsettledEffects(turnId: string) {
    return Object.values(this.bridge.state.runs).some(r => r.turnId === turnId && ['queued', 'running', 'uncertain'].includes(r.status)) ||
      Object.values(this.bridge.state.capabilityCalls).some(r => r.turnId === turnId && ['pending', 'running', 'uncertain'].includes(r.status));
  }
  async requestCapability(token: string, versions: Versions, requestId: string, id: string, args: Record<string, unknown>) {
    return this.bridge.gate.run(async () => {
      const turn = await this.bridge.execution.authorize(token, versions);
      requireThat(JSON.stringify(args).length <= 32_000 && this.bridge.execution.redact(JSON.stringify(args)) === JSON.stringify(args), 'CAPABILITY_ARGUMENTS', 'Arguments must be bounded and exclude bridge credentials.');
      const grant = turn.contextEnvelope!.capabilities?.find(c => c.id === id); requireThat(grant, 'CAPABILITY_NOT_GRANTED', 'Capability was not selected in this context.');
      const requestHash = digestObject({ ...versions, id, args });
      const prior = Object.values(this.bridge.state.capabilityCalls).find(r => r.turnId === turn.id && r.requestId === requestId);
      if (prior) { requireThat(prior.requestHash === requestHash, 'IDEMPOTENCY_CONFLICT', 'Capability request ID changed.'); return prior; }
      requireThat(!this.hasUnsettledEffects(turn.id), 'EFFECT_PENDING', 'Reconcile the existing effect before requesting another.');
      requireThat(Object.values(this.bridge.state.capabilityCalls).filter(r => r.turnId === turn.id).length < 100, 'CAPABILITY_BUDGET', 'Capability call limit reached.');
      const call = { id: randomUUID(), requestId, requestHash, turnId: turn.id, capabilityId: id, digest: grant.digest, args, status: 'pending' as const, createdAt: Date.now() };
      this.bridge.state.capabilityCalls[call.id] = call; await this.bridge.store.save();
      return { ...call, instruction: 'Await explicit approval of this exact call in the local dashboard. Do not resend an uncertain call.' };
    });
  }
  async capabilityResult(token: string, versions: Versions, id: string, cursor = 0, limit = 4000) {
    return this.bridge.gate.run(async () => {
      const turn = await this.bridge.execution.authorize(token, versions); const call = this.bridge.state.capabilityCalls[id]; requireThat(call?.turnId === turn.id, 'CAPABILITY_CALL', 'No call in this delegation.');
      const output = call.output ?? ''; requireThat(cursor >= 0 && cursor <= output.length && Number.isInteger(cursor), 'LOG_CURSOR', 'Invalid output cursor.');
      const end = Math.min(output.length, cursor + Math.min(limit, 32000));
      return { id: call.id, capability_id: call.capabilityId, status: call.status, isError: call.isError, output: output.slice(cursor, end), next_cursor: end, total: output.length };
    });
  }
  async decideCapability(id: string, allow: boolean) {
    const call = await this.bridge.gate.run(async () => {
      const call = this.bridge.state.capabilityCalls[id], turn = this.bridge.turn;
      requireThat(call?.status === 'pending' && turn?.id === call.turnId, 'CAPABILITY_CALL', 'No current pending call.');
      await this.bridge.execution.authorize(turn.token, { contextVersion: turn.contextEnvelope!.version, policyVersion: turn.contextEnvelope!.policyVersion });
      call.status = allow ? 'running' : 'denied'; await this.bridge.store.save(); return call;
    });
    if (allow) {
      const task = (async () => {
        let result: { output: string; isError: boolean } | undefined;
        try { result = await this.resources.call(call.capabilityId, call.digest, call.args); } catch { /* Unknown remote effects: never replay automatically. */ }
        await this.bridge.gate.run(async () => {
          if (call.status === 'running' && result) { call.status = 'done'; call.output = this.bridge.execution.redact(result.output); call.isError = result.isError; }
          else { call.status = 'uncertain'; call.output = 'Remote outcome may have occurred; reconcile with the configured service. No automatic retry.'; }
          await this.bridge.store.save();
        });
      })();
      this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {});
    }
    return call;
  }
  revoke(turnId: string) {
    for (const request of Object.values(this.bridge.state.localAssists)) if (request.turnId === turnId && request.status === 'pending') request.status = 'revoked';
    for (const call of Object.values(this.bridge.state.capabilityCalls)) if (call.turnId === turnId) {
      if (call.status === 'pending') call.status = 'revoked';
      if (call.status === 'running') call.status = 'uncertain';
    }
  }
  async drain() { await Promise.allSettled([...this.tasks]); }
}
