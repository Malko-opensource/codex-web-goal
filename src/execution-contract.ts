import { z } from 'zod';
import { hash } from './shared.js';

const relativePath = z.string().min(1).max(2000).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !p.includes('\0'), 'Use a relative workspace path');
export const commandSchema = z.object({
  argv: z.array(z.string().min(1).max(12_000)).min(1).max(100),
  cwd: relativePath.default('.'),
  localServices: z.number().int().min(0).max(4).optional(),
}).strict();
export const executionPolicySchema = z.object({
  mode: z.literal('web-controlled'),
  network: z.literal('public-internet'),
  allowDelete: z.boolean().default(false),
  commandTimeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  totalRuntimeMs: z.number().int().min(1000).max(86_400_000).default(1_800_000),
  verificationLimit: z.number().int().min(1).max(100).default(5),
  resultKind: z.enum(['verified-files', 'files', 'answer']).default('verified-files'),
  maxLocalAssists: z.number().int().min(0).max(20).default(3),
  checks: z.array(commandSchema.extend({ id: z.string().min(1).max(100) })).max(40).default([]),
  protectedFiles: z.array(relativePath).max(200).default([]),
  expectedFiles: z.array(relativePath).max(1000).default([]),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.checks.map(c => c.id)).size !== p.checks.length) ctx.addIssue({ code: 'custom', message: 'Check IDs must be unique' });
  if (p.resultKind === 'verified-files' && (!p.checks.length || !p.protectedFiles.length || !p.expectedFiles.length)) ctx.addIssue({ code: 'custom', message: 'Verified files require checks, protected checkers and expected files' });
  if (p.resultKind === 'files' && !p.expectedFiles.length) ctx.addIssue({ code: 'custom', message: 'File results require expected files' });
  if (p.resultKind !== 'verified-files' && p.checks.length) ctx.addIssue({ code: 'custom', message: 'Required checks must use verified-files; do not silently skip them' });
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type FrozenPolicy = ExecutionPolicy & { version: number; digest: string; protectedHashes: Record<string, string> };
export const contextDetailsSchema = z.object({
  constraints: z.array(z.string().min(1).max(5000)).max(100).default([]),
  instructions: z.array(z.object({ text: z.string().min(1).max(20_000), source: z.string().min(1).max(2000) }).strict()).max(100).default([]),
  decisions: z.array(z.string().max(5000)).max(100).default([]),
  openQuestions: z.array(z.string().max(5000)).max(100).default([]),
  references: z.array(z.object({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(200).default([]),
  historyOmitted: z.boolean().default(true),
  resourceIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(100).default([]),
  capabilityIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).max(40).default([]),
}).strict();
export type ContextDetails = z.infer<typeof contextDetailsSchema>;
export type ContextEnvelope = ContextDetails & {
  version: number; digest: string; policyVersion: number; objective: string; task: string; criteria: string;
  historySummary: string; workspaceRevision: string; createdAt: number;
  authority: 'local-supervisor'; historyAuthority: 'evidence-only'; truncated: false;
  resources?: { id: string; digest: string }[];
  capabilities?: { id: string; digest: string }[];
};
export const digestObject = (value: unknown) => hash(JSON.stringify(value));
export type Versions = { contextVersion?: number; policyVersion?: number };
export type RequestOrigin = { requestId: string; inputVersion: number };
export type HostBinding = { sessionId: string; turnId: string; threadId: string; goalFingerprint?: string; origin?: RequestOrigin; contextVersion: number; policyVersion: number };
export type HostLease = HostBinding & { leaseId: string; state: 'waiting_external' | 'resumed' | 'revoked' | 'unknown'; expiresAt: number };
export type DelegationResult = { kind: 'verified-files' | 'files' | 'answer'; summary: string; unresolved: string[]; evidence: string[]; revision?: string; artifacts: { path: string; sha256: string }[]; runId?: string };
export type WakeEvent = { id: string; binding: HostBinding; kind: 'completion_candidate' | 'needs_attention' | 'local_assistance'; summary: string; result?: DelegationResult; assistanceId?: string; createdAt: number; status: 'pending' | 'accepted' | 'revoked'; attempts: number };
export type LocalAssistance = { id: string; requestId: string; requestHash: string; sessionId: string; turnId: string; contextVersion: number; task: string; reason: string; status: 'pending' | 'resolved' | 'declined' | 'revoked'; createdAt: number; summary?: string };
export type CapabilityCall = { id: string; requestId: string; requestHash: string; turnId: string; capabilityId: string; digest: string; args: Record<string, unknown>; status: 'pending' | 'running' | 'done' | 'denied' | 'uncertain' | 'revoked'; createdAt: number; output?: string; isError?: boolean };
export type ExecutionRun = {
  id: string; requestId: string; requestHash: string; sessionId: string; turnId: string;
  contextVersion: number; policyVersion: number; policyDigest: string; revision: string;
  kind: 'exec' | 'verify'; commands: z.infer<typeof commandSchema>[];
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'uncertain' | 'stale';
  createdAt: number; startedAt?: number; finishedAt?: number; timeoutMs: number;
  output: string; outputTruncated: boolean; error?: string;
  checks: { argv: string[]; exitCode: number | null; timedOut: boolean }[];
  artifacts: { path: string; sha256: string; size: number }[];
  sourceChanged?: boolean; environment?: Record<string, string>;
};
