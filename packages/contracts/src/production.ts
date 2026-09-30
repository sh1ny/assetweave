import * as z from 'zod';
import { catalogId } from './catalog.js';

const text = z.string().trim().min(1).max(16_384);
const role = z.string().trim().min(1).max(200);
const source = z.strictObject({ kind: role, detail: z.string().max(16_384).optional() });
export const productionFields = ['producer', 'productionTime', 'model', 'prompt', 'negativePrompt', 'seed', 'parameters', 'context'] as const;
export const productionField = z.string().trim().min(1).max(200);
export const exactInput = z.strictObject({
  artifactId: catalogId,
  clipId: catalogId.optional(),
  playbackRevisionId: catalogId.optional(),
  role: role.optional(),
}).refine(input => (input.clipId === undefined) === (input.playbackRevisionId === undefined), {
  message: 'A known playback input requires both its clip and immutable playback revision.',
});
export const createRequestInput = z.strictObject({
  intent: text,
  notes: z.string().max(16_384).optional(),
  slotId: catalogId.optional(),
  proposedInputs: z.array(exactInput).max(128).optional(),
});
export const reportOutcomeInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  notes: z.string().max(16_384).optional(),
});
export const claimInput = z.discriminatedUnion('state', [
  z.strictObject({ field: productionField, state: z.literal('known'), value: z.json(), source }),
  z.strictObject({ field: productionField, state: z.literal('unknown'), source }),
  z.strictObject({ field: productionField, state: z.literal('absent'), source }),
]);
export const recordClaimsInput = z.strictObject({ claims: z.array(claimInput).min(1).max(128) });
export const correctClaimInput = z.strictObject({
  expectedRevision: z.number().int().positive(), claim: claimInput,
});
export const recordInputsInput = z.strictObject({ inputs: z.array(exactInput).min(1).max(128) });
export const correctInputInput = z.strictObject({ expectedRevision: z.number().int().positive(), input: exactInput });
export const retractRevisionInput = z.strictObject({ expectedRevision: z.number().int().positive() });
export const lineageGapInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('upstream'), inputArtifactId: catalogId.optional(), description: text, sourceKind: role }),
  z.strictObject({ kind: z.literal('playback'), inputArtifactId: catalogId, clipId: catalogId, description: text, sourceKind: role }),
]);
export const recordGapsInput = z.strictObject({ gaps: z.array(lineageGapInput).min(1).max(128) });
export const correctGapInput = z.strictObject({ expectedRevision: z.number().int().positive(), gap: lineageGapInput });

export type ExactInput = z.output<typeof exactInput>;
export type CreateRequestInput = z.output<typeof createRequestInput>;
export type ReportOutcomeInput = z.output<typeof reportOutcomeInput>;
export type ClaimInput = z.output<typeof claimInput>;
export type LineageGapInput = z.output<typeof lineageGapInput>;
export type CorrectClaimInput = z.output<typeof correctClaimInput>;
export type CorrectInputInput = z.output<typeof correctInputInput>;
export type CorrectGapInput = z.output<typeof correctGapInput>;
export interface ProposedInputRecord {
  id: string; ordinal: number; requestId: string;
  artifactId: string; clipId: string | null; playbackRevisionId: string | null; role: string | null;
}
export interface OutcomeReport {
  id: string; requestId: string; revision: number; status: 'succeeded' | 'failed' | 'cancelled';
  notes: string; actor: string; at: string;
}
export interface RequestRecord {
  id: string; projectId: string; assetId: string; slotId: string | null;
  intent: string; notes: string; recordedBy: string; recordedAt: string;
  outcomeRevision: number;
  outcome: { status: 'unknown' } | OutcomeReport;
  proposedInputs: ProposedInputRecord[];
  capturedArtifacts: { id: string; capturedAt: string }[];
}
export interface ClaimRevision {
  id: string; assertionId: string; artifactId: string; revision: number;
  claim: ClaimInput; actor: string; at: string;
}
export interface ClaimRecord extends ClaimRevision { currentRevisionId: string }
export interface NotRecordedClaim { artifactId: string; field: string; state: 'not-recorded' }
export interface InputEdgeRevision {
  id: string; edgeId: string; outputArtifactId: string; revision: number;
  input: { artifactId: string; clipId: string | null; playbackRevisionId: string | null; role: string | null };
  effective: boolean; actor: string; at: string;
}
export interface InputEdgeRecord extends InputEdgeRevision { currentRevisionId: string }
export interface LineageGapRevision {
  id: string; gapId: string; outputArtifactId: string; revision: number;
  gap: LineageGapInput; effective: boolean; actor: string; at: string;
}
export interface LineageGapRecord extends LineageGapRevision { currentRevisionId: string }
