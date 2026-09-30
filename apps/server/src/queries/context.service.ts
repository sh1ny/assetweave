import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeSlotName } from '@assetweave/contracts/catalog';
import { productionFields } from '@assetweave/contracts/production';
import type { ContextItem, ContextQuery, ContextResult, ContextSection, TextExcerpt } from '@assetweave/contracts/queries';
import { DatabaseService } from '../database/database.service.js';
import { paginate } from './pagination.js';

type SectionName = keyof ContextResult['sections'];
type Alternative = ContextResult['alternatives'][number];
interface ProjectRow { id: string; name: string; notes: string }
interface AssetRow extends ProjectRow { projectId: string; stage: string | null }
interface DecisionRow {
  decisionId: string | null; decisionRevision: number | null;
  decisionActor: string | null; decisionAt: string | null;
  decisionChannel: string | null; decisionInstruction: string | null;
  decisionRecordedBy: string | null; decisionRationale: string | null;
}
interface TargetSlotRow extends ProjectRow {
  assetId: string; normalizedName: string;
  selectedCandidateId: string | null; selectedArtifactId: string | null; selectedClipId: string | null;
  selectedClipName: string | null; selectedPlaybackRevisionId: string | null; selectedReviewState: string | null;
}
interface SlotRow extends TargetSlotRow, DecisionRow {
  previousCandidateId: string | null; previousArtifactId: string | null;
  previousClipId: string | null; previousPlaybackRevisionId: string | null;
  nextCandidateId: string | null; nextArtifactId: string | null;
  nextClipId: string | null; nextPlaybackRevisionId: string | null;
}
interface CandidateRow extends DecisionRow {
  id: string; slotId: string; artifactId: string; clipId: string | null; reviewState: string;
  revision: number; placedAt: string; clipName: string | null; playbackRevisionId: string | null;
  artifactName: string; ownerAssetId: string; ownerAssetName: string;
  ownerProjectId: string; ownerProjectName: string;
  previousReviewState: string | null; nextReviewState: string | null;
  reviewedPlaybackRevisionId: string | null; selectionDisposition: string | null;
}
interface ArtifactRow {
  id: string; projectId: string; projectName: string; assetId: string; assetName: string;
  requestId: string | null; kind: string; name: string; notes: string;
  capturedAt: string; recordedBy: string; memberCount: number;
}
interface ClaimRow {
  artifactId: string; field: string; id: string | null; revision: number | null;
  revisionId: string | null; state: string | null; valueJson: string | null;
  sourceKind: string | null; sourceDetail: string | null;
}
interface InputRow {
  id: string; outputArtifactId: string; inputArtifactId: string; clipId: string | null;
  playbackRevisionId: string | null; role: string | null; revisionId: string; revision: number;
}
interface GapRow {
  id: string; outputArtifactId: string; kind: string; inputArtifactId: string | null;
  clipId: string | null; description: string; sourceKind: string; revisionId: string; revision: number;
}
interface RequestRow {
  id: string; projectId: string; assetId: string; slotId: string | null; intent: string;
  notes: string; recordedBy: string; recordedAt: string; outcomeRevision: number;
  outcomeStatus: string | null; outcomeNotes: string | null;
  proposedInputCount: number; capturedArtifactCount: number;
}
interface ProposalRow {
  id: string; ordinal: number; artifactId: string; clipId: string | null;
  playbackRevisionId: string | null; role: string | null;
}
interface RelevantScope { assetId: string; sourceId: string | null }
const excerptLimit = 512;
const standardPlaceholders = productionFields.map(() => '(?)').join(', ');
const preview = (column: string) => `substr(${column}, 1, ${excerptLimit + 1})`;
const link = (kind: string, id: string) => `/api/${kind}/${encodeURIComponent(id)}`;
const lineageUrl = (id: string, direction: 'inputs' | 'dependents') =>
  `/api/queries/lineage/${encodeURIComponent(id)}?direction=${direction}`;
function excerpt(value: string, fullRecordUrl: string): TextExcerpt {
  // SQLite substr counts Unicode characters rather than UTF-16 units.
  let end = 0;
  let characters = 0;
  for (const character of value) {
    if (characters === excerptLimit) {
      return { value: value.slice(0, end), truncated: true, fullRecordUrl };
    }
    end += character.length;
    characters++;
  }
  return { value, truncated: false, fullRecordUrl };
}
function notFound(kind: string): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: `${kind} was not found.` });
}
function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message });
}
function ambiguous(category: Alternative['category'], rows: { id: string; name: string }[], ownerId?: string): never {
  const alternativesTruncated = rows.length > 50;
  const listUrl = category === 'project' ? '/api/projects?limit=50'
    : category === 'asset' ? `/api/assets?limit=50${ownerId ? `&projectId=${encodeURIComponent(ownerId)}` : ''}`
      : `/api/assets/${encodeURIComponent(ownerId!)}/slots?limit=50`;
  throw new ConflictException({ code: 'CONFLICT', message: `The ${category} name is ambiguous. Specify its ID.`,
    alternatives: rows.slice(0, 50).map(row => ({ category, id: row.id, name: row.name,
      url: link(category === 'project' ? 'projects' : category === 'asset' ? 'assets' : 'slots', row.id) })),
    alternativesTruncated, ...(alternativesTruncated ? { alternativesUrl: listUrl } : {}) });
}
function relevantPredicate(column: string): string {
  return `(${column} = ? OR EXISTS (SELECT 1 FROM slots selected_slot
    JOIN candidates selected_candidate ON selected_candidate.id = selected_slot.selected_candidate_id
    WHERE selected_slot.asset_id = ? AND selected_candidate.artifact_id = ${column}))`;
}
function relevantParams(scope: RelevantScope): [string | null, string] {
  return [scope.sourceId, scope.assetId];
}
function decisionMetadata(row: DecisionRow, historyUrl: string, type: 'review' | 'selection') {
  if (row.decisionId === null) throw new Error('A missing decision cannot have recorded metadata.');
  return { id: row.decisionId, revision: row.decisionRevision,
    url: `/api/queries/revisions/${type}/${encodeURIComponent(row.decisionId)}`, historyUrl,
    actor: row.decisionActor, at: row.decisionAt,
    authority: { channel: row.decisionChannel,
      instruction: excerpt(row.decisionInstruction!, historyUrl), recordedBy: row.decisionRecordedBy },
    rationale: row.decisionRationale === null ? null : excerpt(row.decisionRationale, historyUrl) };
}

@Injectable()
export class ContextService {
  constructor(private readonly database: DatabaseService) {}

  /** No slot or source is guessed from names, prior requests, review state, or captured ownership. */
  context(input: ContextQuery): ContextResult {
    if (input.cursor && !input.section) invalid('A context cursor requires its section.');
    const connection = this.database.connection;
    const project = this.project(input, connection);
    const asset = this.asset(input, project?.id ?? null, connection);
    const storedOwner = project ?? connection.prepare(`SELECT id, name, ${preview('notes')} AS notes FROM projects WHERE id = ?`)
      .get(asset.projectId) as ProjectRow | undefined;
    if (!storedOwner) notFound('Project');
    const owner = storedOwner;
    const target = this.target(input, asset.id, connection);
    const source = input.sourceArtifactId ? connection.prepare('SELECT id FROM artifacts WHERE id = ?')
      .get(input.sourceArtifactId) as { id: string } | undefined : undefined;
    if (input.sourceArtifactId && !source) notFound('Source artifact');
    const scope: RelevantScope = { assetId: asset.id, sourceId: source?.id ?? null };
    const contextIdentity = ['context', owner.id, asset.id, target?.id ?? null, source?.id ?? null, input.limit];
    const sections: ContextResult['sections'] = {
      slots: this.slots(input, contextIdentity, asset.id),
      candidates: this.candidates(input, contextIdentity, target?.id ?? null, target?.selectedCandidateId ?? null),
      artifacts: this.artifacts(input, contextIdentity, scope),
      claims: this.claims(input, contextIdentity, scope),
      inputs: this.inputs(input, contextIdentity, scope),
      gaps: this.gaps(input, contextIdentity, scope),
      requests: this.requests(input, contextIdentity, scope, target?.id ?? null),
    };
    // The first slot page is the bounded disambiguation list, even when another
    // section (or a later slots page) is being continued.
    const firstSlots = !target && input.section === 'slots' && input.cursor
      ? this.slots({ ...input, cursor: undefined }, contextIdentity, asset.id) : sections.slots;
    return { watermark: this.database.watermark,
      project: { id: owner.id, name: owner.name, notes: excerpt(owner.notes, link('projects', owner.id)),
        url: link('projects', owner.id) },
      asset: { id: asset.id, name: asset.name, stage: asset.stage,
        notes: excerpt(asset.notes, link('assets', asset.id)), url: link('assets', asset.id) },
      targetSlot: target ? { id: target.id, name: target.name, selectedCandidateId: target.selectedCandidateId,
        notes: excerpt(target.notes, link('slots', target.id)), url: link('slots', target.id) } : null,
      explicitSource: source ? { id: source.id, url: link('artifacts', source.id) } : null,
      sections, alternatives: target ? [] : firstSlots.items.map(item => {
        const row = item.record as { name: string };
        return { category: 'slot', id: item.id, name: row.name, url: item.url };
      }) };
  }

  private project(input: ContextQuery, connection: DatabaseSync): ProjectRow | null {
    if (input.projectId) {
      const row = connection.prepare(`SELECT id, name, ${preview('notes')} AS notes FROM projects WHERE id = ?`)
        .get(input.projectId) as ProjectRow | undefined;
      if (!row) notFound('Project');
      if (input.projectName && row.name !== input.projectName) invalid('Project ID and name disagree.');
      return row;
    }
    if (!input.projectName) return null;
    const rows = connection.prepare(`SELECT id, name, ${preview('notes')} AS notes FROM projects
      WHERE name = ? ORDER BY id LIMIT 51`).all(input.projectName) as unknown as ProjectRow[];
    if (!rows.length) notFound('Project');
    if (rows.length > 1) ambiguous('project', rows);
    return rows[0]!;
  }

  private asset(input: ContextQuery, projectId: string | null, connection: DatabaseSync): AssetRow {
    if (input.assetId) {
      const row = connection.prepare(`SELECT id, project_id AS projectId, name, stage,
        ${preview('notes')} AS notes FROM assets WHERE id = ?`).get(input.assetId) as AssetRow | undefined;
      if (!row) notFound('Asset');
      if (projectId && row.projectId !== projectId) invalid('Asset does not belong to the specified project.');
      if (input.assetName && row.name !== input.assetName) invalid('Asset ID and name disagree.');
      return row;
    }
    if (!input.assetName) invalid('Specify the asset identity.');
    const rows = connection.prepare(`SELECT id, project_id AS projectId, name, stage,
      ${preview('notes')} AS notes FROM assets WHERE name = ? ${projectId ? 'AND project_id = ?' : ''}
      ORDER BY id LIMIT 51`).all(input.assetName!, ...(projectId ? [projectId] : [])) as unknown as AssetRow[];
    if (!rows.length) notFound('Asset');
    if (rows.length > 1) ambiguous('asset', rows, projectId ?? undefined);
    return rows[0]!;
  }

  private target(input: ContextQuery, assetId: string, connection: DatabaseSync): TargetSlotRow | null {
    if (!input.slotId && !input.slotName) return null;
    const normalized = input.slotName ? normalizeSlotName(input.slotName) : null;
    const row = connection.prepare(`SELECT s.id, s.asset_id AS assetId, s.normalized_name AS normalizedName,
      s.name, ${preview('s.notes')} AS notes,
      s.selected_candidate_id AS selectedCandidateId, c.artifact_id AS selectedArtifactId,
      c.clip_id AS selectedClipId, c.review_state AS selectedReviewState,
      clip.name AS selectedClipName, clip.current_revision_id AS selectedPlaybackRevisionId
      FROM slots s LEFT JOIN candidates c ON c.id = s.selected_candidate_id
      LEFT JOIN clips clip ON clip.id = c.clip_id
      WHERE ${input.slotId ? 's.id = ?' : 's.asset_id = ? AND s.normalized_name = ?'}`)
      .get(...(input.slotId ? [input.slotId] : [assetId, normalized])) as TargetSlotRow | undefined;
    if (!row) notFound('Slot');
    if (row.assetId !== assetId) invalid('Slot does not belong to the specified asset.');
    if (normalized && row.normalizedName !== normalized) invalid('Slot ID and name disagree.');
    return row;
  }

  private section<T>(input: ContextQuery, identity: readonly unknown[], name: SectionName,
    load: (after: readonly string[] | null, count: number) => T[], key: (row: T) => string[],
    item: (row: T) => ContextItem): ContextSection {
    const page = paginate(this.database, { limit: input.limit, cursor: input.section === name ? input.cursor : undefined },
      [...identity, name], load, key);
    return { items: page.items.map(item), nextCursor: page.nextCursor, truncated: page.nextCursor !== null };
  }

  private slots(input: ContextQuery, identity: readonly unknown[], assetId: string): ContextSection {
    return this.section<SlotRow>(input, identity, 'slots', (after, count) => this.database.connection.prepare(`
      SELECT s.id, s.asset_id AS assetId, s.normalized_name AS normalizedName,
        s.name, ${preview('s.notes')} AS notes,
        s.selected_candidate_id AS selectedCandidateId, c.artifact_id AS selectedArtifactId,
        c.clip_id AS selectedClipId, c.review_state AS selectedReviewState,
        clip.name AS selectedClipName, clip.current_revision_id AS selectedPlaybackRevisionId,
        d.id AS decisionId, d.revision AS decisionRevision,
        event.actor AS decisionActor, event.recorded_at AS decisionAt,
        authority.channel AS decisionChannel, ${preview('authority.instruction')} AS decisionInstruction,
        authority.recorded_by AS decisionRecordedBy, ${preview('event.rationale')} AS decisionRationale,
        d.previous_candidate_id AS previousCandidateId, previous.artifact_id AS previousArtifactId,
        d.previous_clip_id AS previousClipId, d.previous_playback_revision_id AS previousPlaybackRevisionId,
        d.next_candidate_id AS nextCandidateId, next.artifact_id AS nextArtifactId,
        d.next_clip_id AS nextClipId, d.next_playback_revision_id AS nextPlaybackRevisionId
      FROM slots s LEFT JOIN candidates c ON c.id = s.selected_candidate_id
      LEFT JOIN clips clip ON clip.id = c.clip_id
      LEFT JOIN slot_selections d ON d.id = (SELECT latest.id FROM slot_selections latest
        WHERE latest.slot_id = s.id ORDER BY latest.revision DESC LIMIT 1)
      LEFT JOIN candidates previous ON previous.id = d.previous_candidate_id
      LEFT JOIN candidates next ON next.id = d.next_candidate_id
      LEFT JOIN audit_events event ON event.id = d.audit_event_id
      LEFT JOIN authorities authority ON authority.id = d.authority_id
      WHERE s.asset_id = ? ${after ? 'AND (s.name, s.id) > (?, ?)' : ''}
      ORDER BY s.name, s.id LIMIT ?`).all(assetId, ...(after ? [after[0]!, after[1]!] : []), count) as unknown as SlotRow[],
    row => [row.name, row.id], row => {
      const url = link('slots', row.id);
      return { id: row.id, url, record: {
        name: row.name, notes: excerpt(row.notes, url), selectedCandidateId: row.selectedCandidateId,
        selectionState: row.selectedCandidateId ? 'currently-selected' : 'unselected',
        decisionUrl: `${url}/decision`, selectionHistoryUrl: `${url}/selection-history`,
        latestSelectionDecision: row.decisionId === null ? null : {
          ...decisionMetadata(row, `${url}/selection-history`, 'selection'),
          previous: row.previousCandidateId ? { candidateId: row.previousCandidateId,
            artifactId: row.previousArtifactId, clipId: row.previousClipId,
            playbackRevisionId: row.previousPlaybackRevisionId } : null,
          next: row.nextCandidateId ? { candidateId: row.nextCandidateId,
            artifactId: row.nextArtifactId, clipId: row.nextClipId,
            playbackRevisionId: row.nextPlaybackRevisionId } : null,
        },
        selected: row.selectedCandidateId ? {
          candidateId: row.selectedCandidateId, candidateUrl: link('candidates', row.selectedCandidateId),
          artifactId: row.selectedArtifactId, artifactUrl: link('artifacts', row.selectedArtifactId!),
          reviewState: row.selectedReviewState, clip: row.selectedClipId ? {
            id: row.selectedClipId, name: row.selectedClipName, url: link('clips', row.selectedClipId),
            currentRevisionId: row.selectedPlaybackRevisionId,
            currentRevisionUrl: link('playback-revisions', row.selectedPlaybackRevisionId!),
          } : null,
        } : null,
      } };
    });
  }

  private candidates(input: ContextQuery, identity: readonly unknown[], slotId: string | null,
    selectedCandidateId: string | null): ContextSection {
    return this.section<CandidateRow>(input, identity, 'candidates', (after, count) => !slotId ? [] :
      this.database.connection.prepare(`SELECT c.id, c.slot_id AS slotId, c.artifact_id AS artifactId,
        c.clip_id AS clipId, c.review_state AS reviewState, c.revision, c.placed_at AS placedAt,
        clip.name AS clipName, clip.current_revision_id AS playbackRevisionId,
        a.name AS artifactName, a.asset_id AS ownerAssetId, owner.name AS ownerAssetName,
        a.project_id AS ownerProjectId, p.name AS ownerProjectName,
        review.id AS decisionId, review.revision AS decisionRevision,
        event.actor AS decisionActor, event.recorded_at AS decisionAt,
        authority.channel AS decisionChannel, ${preview('authority.instruction')} AS decisionInstruction,
        authority.recorded_by AS decisionRecordedBy, ${preview('event.rationale')} AS decisionRationale,
        review.previous_state AS previousReviewState, review.next_state AS nextReviewState,
        review.playback_revision_id AS reviewedPlaybackRevisionId,
        json_extract(event.after_json, '$.selectionDisposition') AS selectionDisposition
        FROM candidates c JOIN artifacts a ON a.id = c.artifact_id
        JOIN assets owner ON owner.id = a.asset_id JOIN projects p ON p.id = a.project_id
        LEFT JOIN clips clip ON clip.id = c.clip_id
        LEFT JOIN candidate_reviews review ON review.id = (SELECT latest.id FROM candidate_reviews latest
          WHERE latest.candidate_id = c.id ORDER BY latest.revision DESC LIMIT 1)
        LEFT JOIN audit_events event ON event.id = review.audit_event_id
        LEFT JOIN authorities authority ON authority.id = review.authority_id
        WHERE c.slot_id = ? ${after ? 'AND (c.placed_at, c.id) > (?, ?)' : ''}
        ORDER BY c.placed_at, c.id LIMIT ?`)
        .all(slotId, ...(after ? [after[0]!, after[1]!] : []), count) as unknown as CandidateRow[],
    row => [row.placedAt, row.id], row => ({ id: row.id, url: link('candidates', row.id), record: {
      placement: { slotId: row.slotId, slotUrl: link('slots', row.slotId), placedAt: row.placedAt },
      artifactId: row.artifactId, artifactName: row.artifactName, artifactUrl: link('artifacts', row.artifactId),
      originalOwner: { projectId: row.ownerProjectId, projectName: row.ownerProjectName,
        projectUrl: link('projects', row.ownerProjectId), assetId: row.ownerAssetId,
        assetName: row.ownerAssetName, assetUrl: link('assets', row.ownerAssetId) },
      clip: row.clipId ? { id: row.clipId, name: row.clipName, url: link('clips', row.clipId),
        currentRevisionId: row.playbackRevisionId,
        currentRevisionUrl: link('playback-revisions', row.playbackRevisionId!) } : null,
      reviewState: row.reviewState, revision: row.revision,
      selectionState: row.id === selectedCandidateId ? 'currently-selected' : 'not-selected',
      latestReviewDecision: row.decisionId === null ? null : {
        ...decisionMetadata(row, `${link('candidates', row.id)}/reviews`, 'review'),
        previousState: row.previousReviewState, nextState: row.nextReviewState,
        playbackRevisionId: row.reviewedPlaybackRevisionId,
        selectionDisposition: row.selectionDisposition,
      },
      reviewHistoryUrl: `${link('candidates', row.id)}/reviews`,
      slotDecisionUrl: `${link('slots', row.slotId)}/decision`,
      selectionHistoryUrl: `${link('slots', row.slotId)}/selection-history`,
    } }));
  }

  private artifacts(input: ContextQuery, identity: readonly unknown[], scope: RelevantScope): ContextSection {
    return this.section<ArtifactRow>(input, identity, 'artifacts', (after, count) =>
      this.database.connection.prepare(`WITH relevant(id) AS (
        SELECT c.artifact_id AS id FROM slots s JOIN candidates c ON c.id = s.selected_candidate_id
        WHERE s.asset_id = ? ${after ? 'AND c.artifact_id > ?' : ''}
        UNION
        SELECT a.id FROM artifacts a WHERE a.id = ? ${after ? 'AND a.id > ?' : ''}
        ORDER BY id LIMIT ?
      )
      SELECT a.id, a.project_id AS projectId, p.name AS projectName,
        a.asset_id AS assetId, owner.name AS assetName, a.request_id AS requestId, a.kind,
        a.name, ${preview('a.notes')} AS notes, a.captured_at AS capturedAt, a.recorded_by AS recordedBy,
        (SELECT COUNT(*) FROM content_members m WHERE m.artifact_id = a.id) AS memberCount
        FROM relevant rel JOIN artifacts a ON a.id = rel.id
        JOIN assets owner ON owner.id = a.asset_id JOIN projects p ON p.id = a.project_id
        ORDER BY a.id`)
        .all(scope.assetId, ...(after ? [after[0]!] : []), scope.sourceId,
          ...(after ? [after[0]!] : []), count) as unknown as ArtifactRow[],
    row => [row.id], row => {
      const url = link('artifacts', row.id);
      return { id: row.id, url, record: { name: row.name, kind: row.kind, capturedAt: row.capturedAt,
        recordedBy: row.recordedBy, notes: excerpt(row.notes, url), memberCount: row.memberCount,
        originalOwner: { projectId: row.projectId, projectName: row.projectName, projectUrl: link('projects', row.projectId),
          assetId: row.assetId, assetName: row.assetName, assetUrl: link('assets', row.assetId) },
        requestId: row.requestId, requestUrl: row.requestId ? link('requests', row.requestId) : null,
        claimsUrl: `${url}/claims`, inputsUrl: `${url}/inputs`, gapsUrl: `${url}/gaps`,
        lineageUrl: lineageUrl(row.id, 'inputs'), dependentsUrl: lineageUrl(row.id, 'dependents'),
      } };
    });
  }

  private claims(input: ContextQuery, identity: readonly unknown[], scope: RelevantScope): ContextSection {
    return this.section<ClaimRow>(input, identity, 'claims', (after, count) =>
      this.database.connection.prepare(`WITH standard(field) AS (VALUES ${standardPlaceholders}),
        recorded AS (
          SELECT p.artifact_id, p.field FROM provenance_assertions p
          WHERE ${relevantPredicate('p.artifact_id')}
            ${after ? 'AND (p.artifact_id, p.field) > (?, ?)' : ''}
          ORDER BY p.artifact_id, p.field LIMIT ?
        ),
        missing AS (
          SELECT a.id AS artifact_id, s.field FROM artifacts a CROSS JOIN standard s
          WHERE ${relevantPredicate('a.id')}
            ${after ? 'AND (a.id, s.field) > (?, ?)' : ''}
            AND NOT EXISTS (SELECT 1 FROM provenance_assertions p
              WHERE p.artifact_id = a.id AND p.field = s.field)
          ORDER BY a.id, s.field LIMIT ?
        ),
        fields AS (SELECT artifact_id, field FROM recorded UNION ALL
          SELECT artifact_id, field FROM missing)
        SELECT f.artifact_id AS artifactId, f.field, p.id, p.revision, r.id AS revisionId,
          r.state, ${preview('r.value_json')} AS valueJson, r.source_kind AS sourceKind,
          ${preview('r.source_detail')} AS sourceDetail
        FROM fields f LEFT JOIN provenance_assertions p ON p.artifact_id = f.artifact_id AND p.field = f.field
        LEFT JOIN provenance_revisions r ON r.id = p.current_revision_id
        ORDER BY f.artifact_id, f.field LIMIT ?`)
        .all(...productionFields,
          ...relevantParams(scope), ...(after ? [after[0]!, after[1]!] : []), count,
          ...relevantParams(scope), ...(after ? [after[0]!, after[1]!] : []), count,
          count) as unknown as ClaimRow[],
    row => [row.artifactId, row.field], row => {
      const url = row.id ? link('assertions', row.id) :
        `${link('artifacts', row.artifactId)}/claims/${encodeURIComponent(row.field)}`;
      return { id: row.id ?? `${row.artifactId}:${row.field}`, url, record: {
        artifactId: row.artifactId, artifactUrl: link('artifacts', row.artifactId), field: row.field,
        state: row.state ?? 'not-recorded', revision: row.revision, currentRevisionId: row.revisionId,
        historyUrl: row.id ? `${url}/history` : null,
        valueJson: row.state === 'known' ? excerpt(row.valueJson!, url) : null,
        source: row.id ? { kind: row.sourceKind, detail: row.sourceDetail === null ? null : excerpt(row.sourceDetail, url) } : null,
      } };
    });
  }

  private inputs(input: ContextQuery, identity: readonly unknown[], scope: RelevantScope): ContextSection {
    return this.section<InputRow>(input, identity, 'inputs', (after, count) =>
      this.database.connection.prepare(`SELECT e.id, e.output_artifact_id AS outputArtifactId,
        r.input_artifact_id AS inputArtifactId, r.clip_id AS clipId,
        r.playback_revision_id AS playbackRevisionId, r.role, r.id AS revisionId, r.revision
        FROM input_edges e JOIN input_edge_revisions r ON r.id = e.current_revision_id
        WHERE ${relevantPredicate('e.output_artifact_id')} AND r.is_effective = 1
        ${after ? 'AND (e.output_artifact_id, e.id) > (?, ?)' : ''}
        ORDER BY e.output_artifact_id, e.id LIMIT ?`)
        .all(...relevantParams(scope), ...(after ? [after[0]!, after[1]!] : []), count) as unknown as InputRow[],
    row => [row.outputArtifactId, row.id], row => ({ id: row.id, url: link('inputs', row.id), record: {
      kind: 'actual-input', outputArtifactId: row.outputArtifactId,
      outputArtifactUrl: link('artifacts', row.outputArtifactId),
      inputArtifactId: row.inputArtifactId, inputArtifactUrl: link('artifacts', row.inputArtifactId),
      clipId: row.clipId, clipUrl: row.clipId ? link('clips', row.clipId) : null,
      playbackRevisionId: row.playbackRevisionId,
      playbackRevisionUrl: row.playbackRevisionId ? link('playback-revisions', row.playbackRevisionId) : null,
      role: row.role, revision: row.revision, currentRevisionId: row.revisionId,
      historyUrl: `${link('inputs', row.id)}/history`,
      inputLineageUrl: lineageUrl(row.inputArtifactId, 'inputs'),
      dependentLineageUrl: lineageUrl(row.inputArtifactId, 'dependents'),
    } }));
  }

  private gaps(input: ContextQuery, identity: readonly unknown[], scope: RelevantScope): ContextSection {
    return this.section<GapRow>(input, identity, 'gaps', (after, count) =>
      this.database.connection.prepare(`SELECT g.id, g.output_artifact_id AS outputArtifactId,
        r.gap_kind AS kind, r.input_artifact_id AS inputArtifactId, r.clip_id AS clipId,
        ${preview('r.description')} AS description, r.source_kind AS sourceKind,
        r.id AS revisionId, r.revision
        FROM lineage_gaps g JOIN lineage_gap_revisions r ON r.id = g.current_revision_id
        WHERE ${relevantPredicate('g.output_artifact_id')} AND r.is_effective = 1
        ${after ? 'AND (g.output_artifact_id, g.id) > (?, ?)' : ''}
        ORDER BY g.output_artifact_id, g.id LIMIT ?`)
        .all(...relevantParams(scope), ...(after ? [after[0]!, after[1]!] : []), count) as unknown as GapRow[],
    row => [row.outputArtifactId, row.id], row => {
      const url = link('gaps', row.id);
      return { id: row.id, url, record: { outputArtifactId: row.outputArtifactId,
        outputArtifactUrl: link('artifacts', row.outputArtifactId), kind: row.kind,
        inputArtifactId: row.inputArtifactId,
        inputArtifactUrl: row.inputArtifactId ? link('artifacts', row.inputArtifactId) : null,
        clipId: row.clipId, clipUrl: row.clipId ? link('clips', row.clipId) : null,
        description: excerpt(row.description, url), sourceKind: row.sourceKind,
        currentRevisionId: row.revisionId, revision: row.revision, historyUrl: `${url}/history`,
      } };
    });
  }

  private requests(input: ContextQuery, identity: readonly unknown[], scope: RelevantScope,
    slotId: string | null): ContextSection {
    const connection = this.database.connection;
    const proposals = connection.prepare(`SELECT id, ordinal, artifact_id AS artifactId,
      clip_id AS clipId, playback_revision_id AS playbackRevisionId, role
      FROM proposed_inputs WHERE request_id = ? ORDER BY ordinal LIMIT 6`);
    const relatedArtifacts = connection.prepare(`SELECT a.id FROM artifacts a WHERE a.request_id = ?
      AND ${relevantPredicate('a.id')} ORDER BY a.id LIMIT 6`);
    return this.section<RequestRow>(input, identity, 'requests', (after, count) =>
      connection.prepare(`SELECT r.id, r.project_id AS projectId, r.asset_id AS assetId,
        r.slot_id AS slotId, ${preview('r.intent')} AS intent, ${preview('r.notes')} AS notes,
        r.recorded_by AS recordedBy, r.recorded_at AS recordedAt,
        r.outcome_revision AS outcomeRevision, o.status AS outcomeStatus,
        ${preview('o.notes')} AS outcomeNotes,
        (SELECT COUNT(*) FROM proposed_inputs p WHERE p.request_id = r.id) AS proposedInputCount,
        (SELECT COUNT(*) FROM artifacts a WHERE a.request_id = r.id) AS capturedArtifactCount
        FROM requests r LEFT JOIN request_outcomes o ON o.request_id = r.id AND o.revision = r.outcome_revision
        WHERE ((r.asset_id = ? AND (? IS NULL OR r.slot_id IS NULL OR r.slot_id = ?))
          OR EXISTS (SELECT 1 FROM artifacts a WHERE a.request_id = r.id
            AND ${relevantPredicate('a.id')}))
          ${after ? 'AND (r.recorded_at < ? OR (r.recorded_at = ? AND r.id > ?))' : ''}
        ORDER BY r.recorded_at DESC, r.id LIMIT ?`)
        .all(scope.assetId, slotId, slotId, ...relevantParams(scope),
          ...(after ? [after[0]!, after[0]!, after[1]!] : []), count) as unknown as RequestRow[],
    row => [row.recordedAt, row.id], row => {
      const url = link('requests', row.id);
      // A request may have many proposals. Never present a partial nested list as exhaustive.
      const proposed = proposals.all(row.id) as unknown as ProposalRow[];
      const related = relatedArtifacts.all(row.id, ...relevantParams(scope)) as unknown as { id: string }[];
      return { id: row.id, url, record: { projectId: row.projectId, assetId: row.assetId,
        slotId: row.slotId, slotUrl: row.slotId ? link('slots', row.slotId) : null,
        intent: excerpt(row.intent, url), notes: excerpt(row.notes, url),
        recordedBy: row.recordedBy, recordedAt: row.recordedAt,
        outcome: row.outcomeRevision === 0 ? { status: 'unknown' } : {
          status: row.outcomeStatus, revision: row.outcomeRevision,
          notes: excerpt(row.outcomeNotes!, url), historyUrl: `${url}/outcomes`,
        },
        proposedInputCount: row.proposedInputCount,
        proposedInputs: proposed.slice(0, 5).map(p => ({ id: p.id, ordinal: p.ordinal,
          artifactId: p.artifactId, artifactUrl: link('artifacts', p.artifactId), clipId: p.clipId,
          clipUrl: p.clipId ? link('clips', p.clipId) : null,
          playbackRevisionId: p.playbackRevisionId,
          playbackRevisionUrl: p.playbackRevisionId ? link('playback-revisions', p.playbackRevisionId) : null,
          role: p.role, kind: 'proposed-input',
        })),
        proposedInputsTruncated: proposed.length > 5, proposedInputsUrl: url,
        capturedArtifactCount: row.capturedArtifactCount, capturedArtifactsUrl: url,
        actualInputsForRelevantArtifacts: related.slice(0, 5).map(({ id }) => ({ artifactId: id,
          inputsUrl: `${link('artifacts', id)}/inputs`, gapsUrl: `${link('artifacts', id)}/gaps` })),
        actualInputsForRelevantArtifactsTruncated: related.length > 5,
      } };
    });
  }
}
