import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssetRecord, CandidateRecord, SlotRecord } from '@assetweave/contracts/catalog';
import type {
  AssetStageDecision, CandidateReviewDecision, DecisionAuthority, ReviewCandidateInput, ReviewResult,
  SelectionResult, SelectionTarget, SelectCandidateInput, SetStageInput, SlotDecisionState,
  SlotSelectionDecision, StageResult,
} from '@assetweave/contracts/decisions';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { CatalogRepository } from '../catalog/catalog.repository.js';
import { DatabaseService, type ExpectedRevision, type MutationContext } from '../database/database.service.js';
import { PlaybackService } from '../media/playback.service.js';
import { paginate } from '../queries/pagination.js';

export interface DecisionRecorder { actor: string; authority: Pick<DecisionAuthority, 'channel' | 'instruction'> }
interface HistoryMetadata {
  auditEventId: number; actor: string; at: string; rationale: string | null;
  channel: DecisionAuthority['channel']; instruction: string; recordedBy: string;
}
interface ReviewRow extends HistoryMetadata {
  id: string; candidateId: string; artifactId: string; clipId: string | null;
  playbackRevisionId: string | null; revision: number; previousState: CandidateRecord['reviewState'];
  nextState: CandidateRecord['reviewState']; afterJson: string;
}
interface SelectionRow extends HistoryMetadata {
  id: string; slotId: string; revision: number;
  previousCandidateId: string | null; previousArtifactId: string | null;
  previousClipId: string | null; previousPlaybackRevisionId: string | null;
  nextCandidateId: string | null; nextArtifactId: string | null;
  nextClipId: string | null; nextPlaybackRevisionId: string | null;
}
interface StageRow extends HistoryMetadata {
  id: string; assetId: string; revision: number; previousStage: string | null; nextStage: string | null;
}
const historyColumns = `e.id AS auditEventId, e.actor, e.recorded_at AS at, e.rationale,
  h.channel, h.instruction, h.recorded_by AS recordedBy`;

function required<T>(value: T | undefined, name: string): T {
  if (!value) throw new NotFoundException({ code: 'NOT_FOUND', message: `${name} was not found.` });
  return value;
}
function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message });
}
function conflict(message: string, current: unknown): never {
  throw new ConflictException({ code: 'CONFLICT', message, current });
}
function historyFields(row: HistoryMetadata) {
  return { auditEventId: row.auditEventId, actor: row.actor, at: row.at, rationale: row.rationale,
    authority: { channel: row.channel, instruction: row.instruction, recordedBy: row.recordedBy } };
}
function target(candidate: CandidateRecord, playbackRevisionId: string | null): SelectionTarget {
  return { candidateId: candidate.id, artifactId: candidate.artifactId,
    clipId: candidate.clipId, playbackRevisionId };
}
function selectionTarget(candidateId: string | null, artifactId: string | null, clipId: string | null,
  playbackRevisionId: string | null): SelectionTarget | null {
  return candidateId === null ? null : { candidateId, artifactId: artifactId!, clipId, playbackRevisionId };
}

@Injectable()
export class DecisionsService {
  constructor(private readonly database: DatabaseService, private readonly catalog: CatalogRepository,
    private readonly playback: PlaybackService) {}

  private candidate(id: string, connection: DatabaseSync): CandidateRecord {
    return required(this.catalog.getCandidate(id, connection), 'Candidate');
  }
  private slot(id: string, connection: DatabaseSync): SlotRecord {
    return required(this.catalog.getSlot(id, connection), 'Slot');
  }
  private asset(id: string, connection: DatabaseSync): AssetRecord {
    return required(this.catalog.getAsset(id, connection), 'Asset');
  }
  private recorder(recording: DecisionRecorder): DecisionRecorder {
    if (!recording.actor.trim() || !recording.authority.instruction.trim() ||
      !['reported', 'browser'].includes(recording.authority.channel)) {
      throw new BadRequestException({ code: 'MISSING_AUTHORITY', message: 'A decision requires retained human authority.' });
    }
    return recording;
  }

  /** Resolve a stable clip against its current revision at the decision transaction boundary. */
  private observed(candidate: CandidateRecord, supplied: string | undefined, connection: DatabaseSync): string | null {
    if (!candidate.clipId) {
      if (supplied !== undefined) invalid('Whole-artifact targets do not have playback revisions.');
      return null;
    }
    if (!supplied) invalid('A clip decision requires its observed playback revision.');
    const clip = connection.prepare('SELECT current_revision_id AS currentRevisionId FROM clips WHERE id = ? AND artifact_id = ?')
      .get(candidate.clipId, candidate.artifactId) as { currentRevisionId: string } | undefined;
    if (!clip) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Candidate clip was not found.' });
    if (clip.currentRevisionId !== supplied) conflict('The named clip playback changed. Reload before deciding.', {
      candidateId: candidate.id, clipId: candidate.clipId, currentRevisionId: clip.currentRevisionId,
    });
    return supplied;
  }

  getSlotDecision(slotId: string, connection = this.database.connection): SlotDecisionState {
    const slot = this.slot(slotId, connection);
    if (!slot.selectedCandidateId) return { slot, selected: null };
    const candidate = this.candidate(slot.selectedCandidateId, connection);
    const currentRevisionId = candidate.clipId ? this.currentRevisionId(candidate, connection) : null;
    return { slot, selected: { candidate,
      playback: currentRevisionId === null ? null : this.playback.getRevision(currentRevisionId, connection) } };
  }
  private currentRevisionId(candidate: CandidateRecord, connection: DatabaseSync): string {
    const row = connection.prepare('SELECT current_revision_id AS id FROM clips WHERE id = ? AND artifact_id = ?')
      .get(candidate.clipId!, candidate.artifactId) as { id: string } | undefined;
    return required(row, 'Clip').id;
  }

  private reviewRows(filter: 'id' | 'candidate_id', id: string, connection: DatabaseSync,
    after: readonly string[] | null = null, count?: number): CandidateReviewDecision[] {
    const rows = connection.prepare(`SELECT r.id, r.candidate_id AS candidateId, r.artifact_id AS artifactId,
      r.clip_id AS clipId, r.playback_revision_id AS playbackRevisionId, r.revision,
      r.previous_state AS previousState, r.next_state AS nextState, e.after_json AS afterJson,
      ${historyColumns} FROM candidate_reviews r
      JOIN audit_events e ON e.id = r.audit_event_id JOIN authorities h ON h.id = r.authority_id
      WHERE r.${filter} = ? ${after ? 'AND r.revision > ?' : ''}
      ORDER BY r.revision, r.id ${count === undefined ? '' : 'LIMIT ?'}`)
      .all(id, ...(after ? [Number(after[0])] : []), ...(count === undefined ? [] : [count])) as unknown as ReviewRow[];
    return rows.map(row => {
      const after: unknown = JSON.parse(row.afterJson);
      const disposition = after !== null && typeof after === 'object' && 'selectionDisposition' in after
        ? after.selectionDisposition : null;
      return { id: row.id, candidateId: row.candidateId, artifactId: row.artifactId,
        clipId: row.clipId, playbackRevisionId: row.playbackRevisionId, revision: row.revision,
        previousState: row.previousState, nextState: row.nextState,
        selectionDisposition: disposition === 'keep' || disposition === 'clear' || disposition === 'replace'
          ? disposition : null, ...historyFields(row) };
    });
  }
  candidateHistory(id: string, input: PageInput): QueryPage<CandidateReviewDecision> {
    this.candidate(id, this.database.connection);
    return paginate(this.database, input, ['candidates', id, 'reviews'],
      (after, count) => this.reviewRows('candidate_id', id, this.database.connection, after, count),
      row => [String(row.revision)]);
  }

  private selectionRows(filter: 'id' | 'slot_id', id: string, connection: DatabaseSync,
    after: readonly string[] | null = null, count?: number): SlotSelectionDecision[] {
    const rows = connection.prepare(`SELECT s.id, s.slot_id AS slotId, s.revision,
      s.previous_candidate_id AS previousCandidateId, previous.artifact_id AS previousArtifactId,
      s.previous_clip_id AS previousClipId, s.previous_playback_revision_id AS previousPlaybackRevisionId,
      s.next_candidate_id AS nextCandidateId, next.artifact_id AS nextArtifactId,
      s.next_clip_id AS nextClipId, s.next_playback_revision_id AS nextPlaybackRevisionId,
      ${historyColumns} FROM slot_selections s
      JOIN audit_events e ON e.id = s.audit_event_id JOIN authorities h ON h.id = s.authority_id
      LEFT JOIN candidates previous ON previous.id = s.previous_candidate_id
      LEFT JOIN candidates next ON next.id = s.next_candidate_id
      WHERE s.${filter} = ? ${after ? 'AND s.revision > ?' : ''}
      ORDER BY s.revision, s.id ${count === undefined ? '' : 'LIMIT ?'}`)
      .all(id, ...(after ? [Number(after[0])] : []), ...(count === undefined ? [] : [count])) as unknown as SelectionRow[];
    return rows.map(row => ({ id: row.id, slotId: row.slotId, revision: row.revision,
      previous: selectionTarget(row.previousCandidateId, row.previousArtifactId, row.previousClipId, row.previousPlaybackRevisionId),
      next: selectionTarget(row.nextCandidateId, row.nextArtifactId, row.nextClipId, row.nextPlaybackRevisionId),
      ...historyFields(row) }));
  }
  slotHistory(id: string, input: PageInput): QueryPage<SlotSelectionDecision> {
    this.slot(id, this.database.connection);
    return paginate(this.database, input, ['slots', id, 'selection-history'],
      (after, count) => this.selectionRows('slot_id', id, this.database.connection, after, count),
      row => [String(row.revision)]);
  }

  private stageRows(filter: 'id' | 'asset_id', id: string, connection: DatabaseSync,
    after: readonly string[] | null = null, count?: number): AssetStageDecision[] {
    const rows = connection.prepare(`SELECT d.id, d.asset_id AS assetId, d.revision,
      d.previous_stage AS previousStage, d.next_stage AS nextStage, ${historyColumns}
      FROM asset_stage_decisions d JOIN audit_events e ON e.id = d.audit_event_id
      JOIN authorities h ON h.id = d.authority_id
      WHERE d.${filter} = ? ${after ? 'AND d.revision > ?' : ''}
      ORDER BY d.revision, d.id ${count === undefined ? '' : 'LIMIT ?'}`)
      .all(id, ...(after ? [Number(after[0])] : []), ...(count === undefined ? [] : [count])) as unknown as StageRow[];
    return rows.map(row => ({ id: row.id, assetId: row.assetId, revision: row.revision,
      previousStage: row.previousStage, nextStage: row.nextStage, ...historyFields(row) }));
  }
  assetStageHistory(id: string, input: PageInput): QueryPage<AssetStageDecision> {
    this.asset(id, this.database.connection);
    return paginate(this.database, input, ['assets', id, 'stage-history'],
      (after, count) => this.stageRows('asset_id', id, this.database.connection, after, count),
      row => [String(row.revision)]);
  }

  /** A selected rejection changes the candidate and (for clear/replace) slot in one audit event. */
  reviewCandidate(id: string, input: ReviewCandidateInput, recording: DecisionRecorder): ReviewResult {
    const { actor, authority } = this.recorder(recording);
    const checks: ExpectedRevision[] = [{ expectedRevision: input.expectedCandidateRevision,
      readCurrent: connection => this.catalog.getCandidate(id, connection) }];
    if (input.expectedSlotRevision !== undefined) {
      checks.push({ expectedRevision: input.expectedSlotRevision, readCurrent: (connection: DatabaseSync) => {
        const candidate = this.catalog.getCandidate(id, connection);
        return candidate ? this.catalog.getSlot(candidate.slotId, connection) : undefined;
      } });
    }
    if (input.expectedReplacementCandidateRevision !== undefined && input.replacementCandidateId) {
      checks.push({ expectedRevision: input.expectedReplacementCandidateRevision,
        readCurrent: (connection: DatabaseSync) => this.catalog.getCandidate(input.replacementCandidateId!, connection) });
    }
    return this.database.mutate({ actor, authority, rationale: input.rationale, targetType: 'candidate-review', targetId: id,
      expected: checks }, context => {
      const beforeCandidate = this.candidate(id, context.connection);
      const slot = this.slot(beforeCandidate.slotId, context.connection);
      const selected = slot.selectedCandidateId === id;
      if (input.nextState !== 'rejected' && input.disposition !== undefined) invalid('Only a rejection can change a selection.');
      if (input.nextState === 'rejected' && selected && (!input.disposition || input.expectedSlotRevision === undefined)) {
        invalid('Rejecting the selected candidate requires an explicit keep, clear, or replace and the expected slot revision.');
      }
      if ((!selected || input.nextState !== 'rejected') && input.disposition !== undefined) {
        invalid('Only the currently selected candidate can use a rejection disposition.');
      }
      const beforeRevision = this.observed(beforeCandidate, input.observedPlaybackRevisionId, context.connection);
      let replacement: CandidateRecord | null = null;
      let replacementRevision: string | null = null;
      if (input.disposition === 'replace') {
        replacement = this.candidate(input.replacementCandidateId!, context.connection);
        if (replacement.slotId !== slot.id || replacement.id === id) {
          conflict('Replacement must be another candidate in the same slot.', { replacementCandidate: replacement });
        }
        replacementRevision = this.observed(replacement, input.observedReplacementPlaybackRevisionId, context.connection);
      }
      const beforeSelection = selected ? target(beforeCandidate, beforeRevision) : null;
      const afterCandidate: CandidateRecord = { ...beforeCandidate, reviewState: input.nextState,
        revision: beforeCandidate.revision + 1 };
      this.catalog.updateCandidate(context.connection, afterCandidate);
      const reviewId = randomUUID();
      context.connection.prepare(`INSERT INTO candidate_reviews(id, candidate_id, artifact_id, clip_id, playback_revision_id,
        revision, previous_state, next_state, authority_id, audit_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reviewId, id, beforeCandidate.artifactId, beforeCandidate.clipId, beforeRevision,
          afterCandidate.revision, beforeCandidate.reviewState, afterCandidate.reviewState, context.authorityId, context.eventId);
      let changedSelection: { slot: SlotRecord; decisionId: string } | null = null;
      if (selected && input.disposition !== undefined && input.disposition !== 'keep') {
        const next = replacement ? target(replacement, replacementRevision) : null;
        changedSelection = this.setSelection(context, slot, beforeSelection, next);
      }
      const selection = selected ? this.getSlotDecision(slot.id, context.connection) : null;
      const selectionDecision = changedSelection
        ? this.selectionRows('id', changedSelection.decisionId, context.connection)[0]! : null;
      const decision = { ...this.reviewRows('id', reviewId, context.connection)[0]!,
        selectionDisposition: input.disposition ?? null };
      return { before: { candidate: beforeCandidate, selection: selected ? slot.selectedCandidateId : null },
        after: { candidate: afterCandidate,
          selection: changedSelection ? changedSelection.slot.selectedCandidateId : slot.selectedCandidateId,
          selectionDisposition: input.disposition ?? null },
        result: { candidate: afterCandidate, decision, selection, selectionDecision } };
    });
  }

  private setSelection(context: MutationContext, before: SlotRecord,
    previous: SelectionTarget | null, next: SelectionTarget | null): { slot: SlotRecord; decisionId: string } {
    const after: SlotRecord = { ...before, selectedCandidateId: next?.candidateId ?? null,
      revision: before.revision + 1, updatedAt: context.at };
    this.catalog.updateSlot(context.connection, after, context.eventId);
    const decisionId = randomUUID();
    context.connection.prepare(`INSERT INTO slot_selections(id, slot_id, revision, previous_candidate_id,
      previous_clip_id, previous_playback_revision_id, next_candidate_id, next_clip_id,
      next_playback_revision_id, authority_id, audit_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(decisionId, before.id, after.revision, previous?.candidateId ?? null, previous?.clipId ?? null,
        previous?.playbackRevisionId ?? null, next?.candidateId ?? null, next?.clipId ?? null,
        next?.playbackRevisionId ?? null, context.authorityId, context.eventId);
    return { slot: after, decisionId };
  }

  selectCandidate(slotId: string, input: SelectCandidateInput, recording: DecisionRecorder): SelectionResult {
    const { actor, authority } = this.recorder(recording);
    const checks: ExpectedRevision[] = [{ expectedRevision: input.expectedSlotRevision,
      readCurrent: connection => this.catalog.getSlot(slotId, connection) }];
    if (input.nextCandidateId && input.expectedCandidateRevision !== undefined) {
      checks.push({ expectedRevision: input.expectedCandidateRevision,
        readCurrent: (connection: DatabaseSync) => this.catalog.getCandidate(input.nextCandidateId!, connection) });
    }
    return this.database.mutate({ actor, authority, rationale: input.rationale, targetType: 'slot-selection', targetId: slotId,
      expected: checks }, context => {
      const slot = this.slot(slotId, context.connection);
      const oldCandidate = slot.selectedCandidateId ? this.candidate(slot.selectedCandidateId, context.connection) : null;
      if (oldCandidate === null && input.observedPreviousPlaybackRevisionId !== undefined) {
        invalid('No previously selected clip requires an observed playback revision.');
      }
      const previous = oldCandidate ? target(oldCandidate,
        this.observed(oldCandidate, input.observedPreviousPlaybackRevisionId, context.connection)) : null;
      const candidate = input.nextCandidateId ? this.candidate(input.nextCandidateId, context.connection) : null;
      if (candidate && candidate.slotId !== slotId) conflict('Selected candidate belongs to another slot.', { candidate });
      if (candidate && input.expectedCandidateRevision === undefined) invalid('Selecting requires the candidate revision.');
      const next = candidate ? target(candidate, this.observed(candidate, input.observedPlaybackRevisionId, context.connection)) : null;
      if (!candidate && input.observedPlaybackRevisionId !== undefined) invalid('A cleared selection has no new playback revision.');
      const { decisionId } = this.setSelection(context, slot, previous, next);
      const selection = this.getSlotDecision(slotId, context.connection);
      const decision = this.selectionRows('id', decisionId, context.connection)[0]!;
      return { before: previous, after: next, result: { selection, decision } };
    });
  }

  setStage(assetId: string, input: SetStageInput, recording: DecisionRecorder): StageResult {
    const { actor, authority } = this.recorder(recording);
    return this.database.mutate({ actor, authority, rationale: input.rationale,
      targetType: 'asset-stage', targetId: assetId,
      expected: [{ expectedRevision: input.expectedAssetRevision,
        readCurrent: connection => this.catalog.getAsset(assetId, connection) }],
    }, context => {
      const before = this.asset(assetId, context.connection);
      const after: AssetRecord = { ...before, stage: input.stage, revision: before.revision + 1,
        updatedAt: context.at };
      this.catalog.updateAsset(context.connection, after, context.eventId);
      const id = randomUUID();
      context.connection.prepare(`INSERT INTO asset_stage_decisions(id, asset_id, revision, previous_stage,
        next_stage, authority_id, audit_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, assetId, after.revision, before.stage, after.stage, context.authorityId, context.eventId);
      const decision = this.stageRows('id', id, context.connection)[0]!;
      return { before, after, result: { asset: after, decision } };
    });
  }
}
