import * as z from 'zod';
import { catalogId } from './catalog.js';
import { claimInput, exactInput, lineageGapInput } from './production.js';

export const captureLimits = {
  metadataBytes: 256 * 1024,
  memberBytes: 32 * 1024 * 1024,
  aggregateBytes: 128 * 1024 * 1024,
  members: 128,
  transferMs: 120_000,
} as const;

const label = z.string().trim().min(1).max(200);
const sourceName = z.string().trim().min(1).max(200).refine(value =>
  !/[\\\/:\x00-\x1f]/u.test(value) && !/^\.+$/u.test(value),
{ message: 'Use a filename label, not a path or URL.' });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
export const declaredMember = z.strictObject({
  sourceName,
  byteCount: z.number().int().positive().max(captureLimits.memberBytes),
  sha256,
  mediaType: z.string().trim().min(1).max(100).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu).optional(),
});
export const captureMetadata = z.strictObject({
  operationId: catalogId,
  projectId: catalogId,
  assetId: catalogId,
  kind: label,
  name: label,
  notes: z.string().max(16_384).optional(),
  requestId: catalogId.optional(),
  slotId: catalogId.optional(),
  claims: z.array(claimInput).max(128).optional(),
  inputs: z.array(exactInput).max(128).optional(),
  gaps: z.array(lineageGapInput).max(128).optional(),
  members: z.array(declaredMember).min(1).max(captureLimits.members),
}).superRefine((value, context) => {
  if (value.members.reduce((sum, member) => sum + member.byteCount, 0) > captureLimits.aggregateBytes) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'Declared content exceeds the aggregate capture limit.' });
  }
  if (value.kind === 'png-sequence' && value.members.length < 2) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'A frame sequence requires at least two frames.' });
  }
  if (value.kind !== 'png-sequence' && value.members.length !== 1) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'Multiple members require the png-sequence kind.' });
  }
  if (new Set(value.claims?.map(claim => claim.field)).size !== (value.claims?.length ?? 0)) {
    context.addIssue({ code: 'custom', path: ['claims'], message: 'A field can have only one initial claim.' });
  }
  if (new Set(value.members.map(member => member.sourceName)).size !== value.members.length) {
    context.addIssue({ code: 'custom', path: ['members'], message: 'Member filename labels must be distinct.' });
  }
});

export const storedMember = declaredMember.extend({
  ordinal: z.number().int().nonnegative(),
  storedName: z.string().regex(/^\d{4}\.bin$/u),
});
export const captureDescriptor = z.strictObject({
  version: z.literal(1),
  artifactId: catalogId,
  operationId: catalogId,
  projectId: catalogId,
  assetId: catalogId,
  kind: label,
  name: label,
  notes: z.string().max(16_384),
  requestId: catalogId.nullable(),
  slotId: catalogId.nullable(),
  claims: z.array(claimInput).max(128),
  inputs: z.array(exactInput).max(128),
  gaps: z.array(lineageGapInput).max(128),
  members: z.array(storedMember).min(1).max(captureLimits.members),
  fingerprint: sha256,
});

export type CaptureMetadata = z.output<typeof captureMetadata>;
export type StoredMember = z.output<typeof storedMember>;
export type CaptureDescriptor = z.output<typeof captureDescriptor>;
export const captureReceiptSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('absent'), operationId: catalogId, receiptUrl: z.string() }),
  z.strictObject({ status: z.literal('in-progress'), operationId: catalogId, receiptUrl: z.string() }),
  z.strictObject({ status: z.literal('orphan'), operationId: catalogId, artifactId: catalogId, receiptUrl: z.string() }),
  z.strictObject({ status: z.literal('committed'), operationId: catalogId, artifactId: catalogId,
    fingerprint: sha256, receiptUrl: z.string() }),
  z.strictObject({ status: z.literal('unavailable'), operationId: catalogId, artifactId: catalogId, receiptUrl: z.string() }),
]);

export const captureRecordSchema = z.strictObject({
  id: catalogId, operationId: catalogId, projectId: catalogId, assetId: catalogId,
  requestId: catalogId.nullable(), kind: label, name: label, notes: z.string(),
  capturedAt: z.string(), recordedBy: z.string(),
  members: z.array(storedMember), content: z.enum(['available', 'unavailable']),
  candidateId: catalogId.nullable(),
});

export interface CaptureRecord {
  id: string;
  operationId: string;
  projectId: string;
  assetId: string;
  requestId: string | null;
  kind: string;
  name: string;
  notes: string;
  capturedAt: string;
  recordedBy: string;
  members: StoredMember[];
  content: 'available' | 'unavailable';
  candidateId: string | null;
}
export type CaptureReceipt =
  | { status: 'absent'; operationId: string; receiptUrl: string }
  | { status: 'in-progress'; operationId: string; receiptUrl: string }
  | { status: 'orphan'; operationId: string; artifactId: string; receiptUrl: string }
  | { status: 'committed'; operationId: string; artifactId: string; fingerprint: string; receiptUrl: string }
  | { status: 'unavailable'; operationId: string; artifactId: string; receiptUrl: string };
export interface CaptureRecovery {
  incompleteStaging: { directory: string; operationId: string | null }[];
  publishedOrphans: { artifactId: string; operationId: string | null }[];
  unavailableContent: { artifactId: string; operationId: string }[];
}
