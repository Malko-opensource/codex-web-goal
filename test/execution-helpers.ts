import { hash } from '../src/shared.js';
import type { HostBinding, HostLease, WakeEvent } from '../src/execution-contract.js';
import type { DelegationHostPort } from '../src/delegation-host.js';
import type { RunnerPort } from '../src/runner.js';

/** Synthetic scheduler only. These counters do not measure a real Codex host. */
export class FakeHost implements DelegationHostPort {
  lease?: HostLease; modelRequests = 0; parked = false; receipts = new Set<string>(); loseReceipt = false;
  async capabilities() { return { protocol: 1 as const, externalWait: true as const, durableWakeReceipts: true as const, userInputInvalidation: true as const, ordinaryRequests: true, localAssistance: true }; }
  async park(binding: HostBinding) { this.parked = true; this.lease = { ...binding, leaseId: hash(JSON.stringify(binding)), state: 'waiting_external', expiresAt: Date.now() + 60_000 }; return structuredClone(this.lease); }
  async reconcile() { return structuredClone(this.lease!); }
  async resumeOnce(_lease: HostLease, event: WakeEvent) {
    if (this.lease!.state === 'revoked') return { eventId: event.id, status: 'revoked' as const };
    if (!this.receipts.has(event.id)) { this.receipts.add(event.id); this.modelRequests++; this.lease!.state = 'resumed'; }
    if (this.loseReceipt) { this.loseReceipt = false; throw new Error('Receipt lost after scheduling'); }
    return { eventId: event.id, status: 'accepted' as const };
  }
  async revoke() { if (this.lease) this.lease.state = 'revoked'; }
}
export class FakeRunner implements RunnerPort {
  executions = 0; exitCode = 0; sourceChanged = false;
  async preflight() { return { available: true as const, backend: 'synthetic-only' }; }
  async run(input: Parameters<RunnerPort['run']>[0]) {
    this.executions++; input.output('bounded fixture output');
    const artifacts = [];
    for (const file of input.policy.expectedFiles) { const read = await input.workspace.read(file); artifacts.push({ path: file, sha256: read.sha256, size: read.content.length }); }
    return { checks: input.run.commands.map(c => ({ argv: c.argv, exitCode: this.exitCode, timedOut: false })), artifacts, sourceChanged: this.sourceChanged, environment: { backend: 'synthetic-only' } };
  }
}
