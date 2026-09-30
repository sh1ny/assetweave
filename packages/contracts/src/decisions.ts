import * as z from 'zod';
import { catalogId, type AssetRecord, type CandidateRecord, type SlotRecord } from './catalog.js';
import type { PlaybackRevision } from './playback.js';

export const reviewState = z.enum(['unreviewed', 'reviewed-undecided', 'approved', 'rejected']);
export const selectionDisposition = z.enum(['keep', 'clear', 'replace']);
const expectedRevision = z.number().int().positive();
const authorityFields = {
  // Required on bridge calls; a browser's explicit button/form action is recorded instead.
  instruction: z.string().trim().min(1).max(16_384).optional(),
  rationale: z.string().max(16_384).optional(),
};

export const reviewCandidateInput = z.strictObject({
  expectedCandidateRevision: expectedRevision,
  nextState: reviewState,
  observedPlaybackRevisionId: catalogId.optional(),
  expectedSlotRevision: expectedRevision.optional(),
  disposition: selectionDisposition.optional(),
  replacementCandidateId: catalogId.optional(),
  expectedReplacementCandidateRevision: expectedRevision.optional(),
  observedReplacementPlaybackRevisionId: catalogId.optional(),
  ...authorityFields,
}).superRefine((input, context) => {
  if (input.nextState !== 'rejected' && (input.expectedSlotRevision !== undefined || input.disposition !== undefined ||
    input.replacementCandidateId !== undefined || input.expectedReplacementCandidateRevision !== undefined ||
    input.observedReplacementPlaybackRevisionId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Selection disposition is only available when rejecting a candidate.' });
  }
  if (input.disposition === 'replace') {
    if (!input.replacementCandidateId || !input.expectedReplacementCandidateRevision) {
      context.addIssue({ code: 'custom', message: 'A replacement requires its candidate ID and expected revision.' });
    }
  } else if (input.replacementCandidateId !== undefined || input.expectedReplacementCandidateRevision !== undefined ||
    input.observedReplacementPlaybackRevisionId !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only replace accepts a replacement candidate.' });
  }
});

export const selectCandidateInput = z.strictObject({
  expectedSlotRevision: expectedRevision,
  nextCandidateId: catalogId.nullable(),
  expectedCandidateRevision: expectedRevision.optional(),
  observedPlaybackRevisionId: catalogId.optional(),
  observedPreviousPlaybackRevisionId: catalogId.optional(),
  ...authorityFields,
}).superRefine((input, context) => {
  if (input.nextCandidateId === null && (input.expectedCandidateRevision !== undefined || input.observedPlaybackRevisionId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Clearing a selection does not take a new candidate revision.' });
  }
  if (input.nextCandidateId !== null && input.expectedCandidateRevision === undefined) {
    context.addIssue({ code: 'custom', message: 'Selecting a candidate requires its expected revision.' });
  }
});

export const setStageInput = z.strictObject({
  expectedAssetRevision: expectedRevision,
  stage: z.string().trim().min(1).max(200).nullable(),
  ...authorityFields,
});

export type ReviewCandidateInput = z.output<typeof reviewCandidateInput>;
export type SelectCandidateInput = z.output<typeof selectCandidateInput>;
export type SetStageInput = z.output<typeof setStageInput>;
export type SelectionDisposition = z.output<typeof selectionDisposition>;
export type ReviewState = z.output<typeof reviewState>;

export interface DecisionAuthority {
  channel: 'browser' | 'reported';
  instruction: string;
  recordedBy: string;
  // Reported human instruction is retained, not verified as that person's identity.
}
export interface DecisionHistoryFields {
  auditEventId: number;
  actor: string;
  at: string;
  authority: DecisionAuthority;
  rationale: string | null;
}
export interface CandidateReviewDecision extends DecisionHistoryFields {
  id: string;
  candidateId: string;
  artifactId: string;
  clipId: string | null;
  playbackRevisionId: string | null;
  revision: number;
  previousState: ReviewState;
  nextState: ReviewState;
  selectionDisposition: SelectionDisposition | null;
}
export interface SelectionTarget {
  candidateId: string;
  artifactId: string;
  clipId: string | null;
  playbackRevisionId: string | null;
}
export interface SlotSelectionDecision extends DecisionHistoryFields {
  id: string;
  slotId: string;
  revision: number;
  previous: SelectionTarget | null;
  next: SelectionTarget | null;
}
export interface AssetStageDecision extends DecisionHistoryFields {
  id: string;
  assetId: string;
  revision: number;
  previousStage: string | null;
  nextStage: string | null;
}
export interface SlotDecisionState {
  slot: SlotRecord;
  selected: { candidate: CandidateRecord; playback: PlaybackRevision | null } | null;
}
export interface ReviewResult { candidate: CandidateRecord; decision: CandidateReviewDecision; selection: SlotDecisionState | null;
  selectionDecision: SlotSelectionDecision | null }
export interface SelectionResult { selection: SlotDecisionState; decision: SlotSelectionDecision }
export interface StageResult { asset: AssetRecord; decision: AssetStageDecision }
