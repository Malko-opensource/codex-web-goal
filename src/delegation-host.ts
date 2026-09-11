import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { requireThat } from './shared.js';
import type { HostBinding, HostLease, WakeEvent } from './execution-contract.js';

/** A host integration contract, NOT an undocumented Codex App Server RPC. */
export interface DelegationHostPort {
  capabilities(): Promise<{ protocol: 1; externalWait: true; durableWakeReceipts: true; userInputInvalidation: true; ordinaryRequests?: boolean; localAssistance?: boolean }>;
  park(binding: HostBinding): Promise<HostLease>;
  reconcile(lease: HostLease): Promise<HostLease>;
  resumeOnce(lease: HostLease, event: WakeEvent): Promise<{ eventId: string; status: 'accepted' | 'revoked' }>;
  revoke(lease: HostLease): Promise<void>;
}
const capabilities = z.object({ protocol: z.literal(1), externalWait: z.literal(true), durableWakeReceipts: z.literal(true), userInputInvalidation: z.literal(true), ordinaryRequests: z.boolean().optional(), localAssistance: z.boolean().optional() });
const leaseSchema = z.object({ sessionId: z.string(), turnId: z.string(), threadId: z.string(), goalFingerprint: z.string().optional(), origin: z.object({ requestId: z.string(), inputVersion: z.number().int().positive() }).optional(), contextVersion: z.number().int(), policyVersion: z.number().int(), leaseId: z.string().min(1), state: z.enum(['waiting_external', 'resumed', 'revoked', 'unknown']), expiresAt: z.number() });
export function sameBinding(a: HostBinding, b: HostBinding) {
  return a.sessionId === b.sessionId && a.turnId === b.turnId && a.threadId === b.threadId && a.goalFingerprint === b.goalFingerprint && a.origin?.requestId === b.origin?.requestId && a.origin?.inputVersion === b.origin?.inputVersion && a.contextVersion === b.contextVersion && a.policyVersion === b.policyVersion;
}

/** Only an explicitly configured, user-owned, private UNIX socket is trusted. */
export class SocketDelegationHost implements DelegationHostPort {
  constructor(readonly socketPath: string) { requireThat(path.isAbsolute(socketPath), 'HOST_SOCKET', 'Host socket must be an absolute path.'); }
  private async call(route: string, input: unknown): Promise<unknown> {
    const stat = await fs.lstat(this.socketPath);
    requireThat(stat.isSocket() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), 'HOST_SOCKET', 'Host socket must be user-owned and mode 0600.');
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      const request = http.request({ socketPath: this.socketPath, path: `/web-goal/v1/${route}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 5000 }, response => {
        let data = '';
        response.on('data', chunk => { data += chunk; if (data.length > 64_000) response.destroy(new Error('Host response limit')); });
        response.on('error', reject);
        response.on('end', () => { try { requireThat(response.statusCode === 200, 'HOST_RESPONSE', 'Host rejected delegation request.'); resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      request.on('timeout', () => request.destroy(new Error('Host response uncertain; reconcile before waking.')));
      request.on('error', reject); request.end(body);
    });
  }
  async capabilities() { return capabilities.parse(await this.call('capabilities', {})); }
  async park(binding: HostBinding) {
    const lease = leaseSchema.parse(await this.call('park', binding));
    requireThat(sameBinding(lease, binding), 'HOST_BINDING', 'Host parked a different delegation.'); return lease;
  }
  async reconcile(lease: HostLease) {
    const result = leaseSchema.parse(await this.call('reconcile', lease));
    requireThat(sameBinding(result, lease) && result.leaseId === lease.leaseId, 'HOST_BINDING', 'Host lease changed.'); return result;
  }
  async resumeOnce(lease: HostLease, event: WakeEvent) {
    const receipt = z.object({ eventId: z.string(), status: z.enum(['accepted', 'revoked']) }).parse(await this.call('resume-once', { lease, event }));
    requireThat(receipt.eventId === event.id, 'HOST_RECEIPT', 'Wake receipt does not match event.'); return receipt;
  }
  async revoke(lease: HostLease) { await this.call('revoke', lease); }
}
