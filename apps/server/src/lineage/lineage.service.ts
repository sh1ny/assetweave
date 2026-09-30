import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CorrectGapInput, CorrectInputInput, ExactInput, InputEdgeRecord, InputEdgeRevision,
  LineageGapInput, LineageGapRecord, LineageGapRevision,
} from '@assetweave/contracts/production';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { DatabaseService, type MutationContext } from '../database/database.service.js';
import { paginate } from '../queries/pagination.js';

function notFound(kind: string): never {
  throw new NotFoundException({ code: 'NOT_FOUND', message: `${kind} was not found.` });
}
function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message });
}
export function requireArtifact(connection: DatabaseSync, id: string): { id: string; projectId: string; assetId: string } {
  const record = connection.prepare('SELECT id, project_id AS projectId, asset_id AS assetId FROM artifacts WHERE id = ?')
    .get(id) as { id: string; projectId: string; assetId: string } | undefined;
  return record ?? notFound('Artifact');
}
export function requireExactInput(connection: DatabaseSync, input: ExactInput): void {
  requireArtifact(connection, input.artifactId);
  if ((input.clipId === undefined) !== (input.playbackRevisionId === undefined)) {
    invalid('A clip input must identify its exact playback revision.');
  }
  if (input.clipId && !connection.prepare('SELECT 1 FROM playback_revisions WHERE id = ? AND clip_id = ? AND artifact_id = ?')
    .get(input.playbackRevisionId!, input.clipId, input.artifactId)) {
    invalid('The playback revision does not belong to the input clip and artifact.');
  }
}

const edgeColumns = `r.id, r.edge_id AS edgeId, r.output_artifact_id AS outputArtifactId,
  r.revision, r.input_artifact_id AS artifactId, r.clip_id AS clipId,
  r.playback_revision_id AS playbackRevisionId, r.role, r.is_effective AS effective,
  e.current_revision_id AS currentRevisionId, a.actor, a.recorded_at AS at`;
type EdgeRow = Omit<InputEdgeRecord, 'input' | 'effective'> & {
  artifactId: string; clipId: string | null; playbackRevisionId: string | null;
  role: string | null; effective: number;
};
function edgeRecord(row: EdgeRow): InputEdgeRecord {
  return { id: row.id, edgeId: row.edgeId, outputArtifactId: row.outputArtifactId,
    revision: row.revision, currentRevisionId: row.currentRevisionId,
    input: { artifactId: row.artifactId, clipId: row.clipId, playbackRevisionId: row.playbackRevisionId, role: row.role },
    effective: row.effective === 1, actor: row.actor, at: row.at };
}
const gapColumns = `r.id, r.gap_id AS gapId, r.output_artifact_id AS outputArtifactId,
  r.revision, r.gap_kind AS kind, r.input_artifact_id AS inputArtifactId,
  r.clip_id AS clipId, r.description, r.source_kind AS sourceKind,
  r.is_effective AS effective, g.current_revision_id AS currentRevisionId, a.actor, a.recorded_at AS at`;
type GapRow = Omit<LineageGapRecord, 'gap' | 'effective'> & {
  kind: 'upstream' | 'playback'; inputArtifactId: string | null; clipId: string | null;
  description: string; sourceKind: string; effective: number;
};
function gapRecord(row: GapRow): LineageGapRecord {
  const gap: LineageGapInput = row.kind === 'playback'
    ? { kind: 'playback', inputArtifactId: row.inputArtifactId!, clipId: row.clipId!, description: row.description, sourceKind: row.sourceKind }
    : { kind: 'upstream', ...(row.inputArtifactId ? { inputArtifactId: row.inputArtifactId } : {}),
      description: row.description, sourceKind: row.sourceKind };
  return { id: row.id, gapId: row.gapId, outputArtifactId: row.outputArtifactId,
    revision: row.revision, currentRevisionId: row.currentRevisionId,
    gap, effective: row.effective === 1, actor: row.actor, at: row.at };
}

@Injectable()
export class LineageService {
  constructor(private readonly database: DatabaseService) {}

  private edge(id: string, connection = this.database.connection): InputEdgeRecord {
    const row = connection.prepare(`SELECT ${edgeColumns} FROM input_edges e
      JOIN input_edge_revisions r ON r.id = e.current_revision_id
      JOIN audit_events a ON a.id = r.audit_event_id WHERE e.id = ?`).get(id) as EdgeRow | undefined;
    return row ? edgeRecord(row) : notFound('Input edge');
  }
  getInput(id: string): InputEdgeRecord { return this.edge(id); }
  inputHistory(id: string, input: PageInput): QueryPage<InputEdgeRevision> {
    this.edge(id);
    return paginate(this.database, input, ['inputs', id, 'history'], (after, count) => {
      const rows = this.database.connection.prepare(`SELECT ${edgeColumns} FROM input_edges e
        JOIN input_edge_revisions r ON r.edge_id = e.id
        JOIN audit_events a ON a.id = r.audit_event_id
        WHERE e.id = ? ${after ? 'AND r.revision > ?' : ''}
        ORDER BY r.revision, r.id LIMIT ?`)
        .all(id, ...(after ? [Number(after[0])] : []), count) as unknown as EdgeRow[];
      return rows.map(row => {
        const { currentRevisionId: _ignored, ...history } = edgeRecord(row);
        return history;
      });
    }, row => [String(row.revision)]);
  }
  private gap(id: string, connection = this.database.connection): LineageGapRecord {
    const row = connection.prepare(`SELECT ${gapColumns} FROM lineage_gaps g
      JOIN lineage_gap_revisions r ON r.id = g.current_revision_id
      JOIN audit_events a ON a.id = r.audit_event_id WHERE g.id = ?`).get(id) as GapRow | undefined;
    return row ? gapRecord(row) : notFound('Lineage gap');
  }
  getGap(id: string): LineageGapRecord { return this.gap(id); }
  gapHistory(id: string, input: PageInput): QueryPage<LineageGapRevision> {
    this.gap(id);
    return paginate(this.database, input, ['gaps', id, 'history'], (after, count) => {
      const rows = this.database.connection.prepare(`SELECT ${gapColumns} FROM lineage_gaps g
        JOIN lineage_gap_revisions r ON r.gap_id = g.id
        JOIN audit_events a ON a.id = r.audit_event_id
        WHERE g.id = ? ${after ? 'AND r.revision > ?' : ''}
        ORDER BY r.revision, r.id LIMIT ?`)
        .all(id, ...(after ? [Number(after[0])] : []), count) as unknown as GapRow[];
      return rows.map(row => {
        const { currentRevisionId: _ignored, ...history } = gapRecord(row);
        return history;
      });
    }, row => [String(row.revision)]);
  }

  listInputs(artifactId: string, input: PageInput): QueryPage<InputEdgeRecord> {
    return this.edgePage(artifactId, input, true);
  }
  listInputHistory(artifactId: string, input: PageInput): QueryPage<InputEdgeRecord> {
    return this.edgePage(artifactId, input, false);
  }
  private edgePage(artifactId: string, input: PageInput, effectiveOnly: boolean): QueryPage<InputEdgeRecord> {
    requireArtifact(this.database.connection, artifactId);
    return paginate(this.database, input, ['artifacts', artifactId, 'lineage', effectiveOnly ? 'inputs' : 'input-history'],
      (after, count) => {
        const rows = this.database.connection.prepare(`SELECT ${edgeColumns} FROM input_edges e
          JOIN input_edge_revisions r ON r.id = e.current_revision_id
          JOIN audit_events a ON a.id = r.audit_event_id
          WHERE e.output_artifact_id = ? ${effectiveOnly ? 'AND r.is_effective = 1' : ''}
          ${after ? 'AND e.id > ?' : ''} ORDER BY e.id LIMIT ?`)
          .all(artifactId, ...(after ? [after[0]!] : []), count) as unknown as EdgeRow[];
        return rows.map(edgeRecord);
      }, row => [row.edgeId]);
  }
  listGaps(artifactId: string, input: PageInput): QueryPage<LineageGapRecord> {
    return this.gapPage(artifactId, input, true);
  }
  listGapHistory(artifactId: string, input: PageInput): QueryPage<LineageGapRecord> {
    return this.gapPage(artifactId, input, false);
  }
  private gapPage(artifactId: string, input: PageInput, effectiveOnly: boolean): QueryPage<LineageGapRecord> {
    requireArtifact(this.database.connection, artifactId);
    return paginate(this.database, input, ['artifacts', artifactId, 'lineage', effectiveOnly ? 'gaps' : 'gap-history'],
      (after, count) => {
        const rows = this.database.connection.prepare(`SELECT ${gapColumns} FROM lineage_gaps g
          JOIN lineage_gap_revisions r ON r.id = g.current_revision_id
          JOIN audit_events a ON a.id = r.audit_event_id
          WHERE g.output_artifact_id = ? ${effectiveOnly ? 'AND r.is_effective = 1' : ''}
          ${after ? 'AND g.id > ?' : ''} ORDER BY g.id LIMIT ?`)
          .all(artifactId, ...(after ? [after[0]!] : []), count) as unknown as GapRow[];
        return rows.map(gapRecord);
      }, row => [row.gapId]);
  }
  /** Compose with the outer capture mutation; this does not open another transaction. */
  addInputsInTransaction(context: MutationContext, outputArtifactId: string, inputs: readonly ExactInput[]): InputEdgeRecord[] {
    requireArtifact(context.connection, outputArtifactId);
    return inputs.map(input => {
      requireExactInput(context.connection, input);
      this.assertAcyclic(context.connection, outputArtifactId, input.artifactId);
      const edgeId = randomUUID();
      const revisionId = randomUUID();
      context.connection.prepare('INSERT INTO input_edges(id, output_artifact_id, current_revision_id, revision) VALUES (?, ?, ?, 1)')
        .run(edgeId, outputArtifactId, revisionId);
      this.insertEdgeRevision(context, edgeId, revisionId, outputArtifactId, 1, input, true);
      return this.edge(edgeId, context.connection);
    });
  }
  addInputs(outputArtifactId: string, inputs: readonly ExactInput[], actor: string): InputEdgeRecord[] {
    return this.database.mutate({ actor, targetType: 'artifact-inputs', targetId: outputArtifactId }, context => {
      const result = this.addInputsInTransaction(context, outputArtifactId, inputs);
      return { before: null, after: result, result };
    });
  }
  correctInput(id: string, input: CorrectInputInput, actor: string): InputEdgeRecord {
    return this.reviseInput(id, input.expectedRevision, input.input, true, actor);
  }
  retractInput(id: string, expectedRevision: number, actor: string): InputEdgeRecord {
    return this.reviseInput(id, expectedRevision, undefined, false, actor);
  }
  private reviseInput(id: string, expectedRevision: number, input: ExactInput | undefined, effective: boolean, actor: string): InputEdgeRecord {
    return this.database.mutate({ actor, targetType: 'input-edge', targetId: id,
      expected: [{ expectedRevision, readCurrent: connection => this.edge(id, connection) }],
    }, context => {
      const before = this.edge(id, context.connection);
      if (effective) {
        requireExactInput(context.connection, input!);
        this.assertAcyclic(context.connection, before.outputArtifactId, input!.artifactId);
      }
      const newInput = input ?? {
        artifactId: before.input.artifactId,
        ...(before.input.clipId ? { clipId: before.input.clipId, playbackRevisionId: before.input.playbackRevisionId! } : {}),
        ...(before.input.role ? { role: before.input.role } : {}),
      };
      const revisionId = randomUUID();
      this.insertEdgeRevision(context, id, revisionId, before.outputArtifactId, before.revision + 1, newInput, effective);
      context.connection.prepare('UPDATE input_edges SET current_revision_id = ?, revision = ? WHERE id = ?')
        .run(revisionId, before.revision + 1, id);
      if (before.effective && before.input.clipId === null &&
          (!effective || input!.artifactId !== before.input.artifactId || input!.clipId !== undefined)) {
        const unsupportedGap = context.connection.prepare(`SELECT 1 FROM lineage_gaps g
          JOIN lineage_gap_revisions gap ON gap.id = g.current_revision_id
          WHERE g.output_artifact_id = ? AND gap.gap_kind = 'playback'
          AND gap.input_artifact_id = ? AND gap.is_effective = 1
          AND NOT EXISTS (
            SELECT 1 FROM input_edges e JOIN input_edge_revisions r ON r.id = e.current_revision_id
            WHERE e.output_artifact_id = ? AND r.input_artifact_id = ?
              AND r.clip_id IS NULL AND r.is_effective = 1
          ) LIMIT 1`).get(before.outputArtifactId, before.input.artifactId,
          before.outputArtifactId, before.input.artifactId);
        if (unsupportedGap) throw new ConflictException({ code: 'CONFLICT',
          message: 'An effective playback gap requires a recorded artifact-level input.' });
      }
      const after = this.edge(id, context.connection);
      return { before, after, result: after };
    });
  }
  private insertEdgeRevision(context: MutationContext, id: string, revisionId: string, output: string, revision: number, input: ExactInput, effective: boolean): void {
    context.connection.prepare(`INSERT INTO input_edge_revisions
      (id, edge_id, output_artifact_id, revision, input_artifact_id, clip_id, playback_revision_id, role, is_effective, audit_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, id, output, revision, input.artifactId,
        input.clipId ?? null, input.playbackRevisionId ?? null, input.role ?? null, effective ? 1 : 0, context.eventId);
  }
  private assertAcyclic(connection: DatabaseSync, output: string, input: string): void {
    if (input === output) invalid('An artifact cannot be its own input.');
    const cycle = connection.prepare(`WITH RECURSIVE reach(id) AS (
      SELECT ? UNION SELECT r.input_artifact_id FROM reach JOIN input_edges e
      ON e.output_artifact_id = reach.id JOIN input_edge_revisions r ON r.id = e.current_revision_id
      WHERE r.is_effective = 1
    ) SELECT 1 FROM reach WHERE id = ? LIMIT 1`).get(input, output);
    if (cycle) throw new ConflictException({ code: 'CONFLICT', message: 'The input would introduce a lineage cycle.' });
  }

  /** A playback gap must accompany a known artifact-level input, never an invented playback revision. */
  private validateGap(connection: DatabaseSync, output: string, gap: LineageGapInput): void {
    requireArtifact(connection, output);
    if (gap.inputArtifactId) requireArtifact(connection, gap.inputArtifactId);
    if (gap.kind === 'playback') {
      if (!connection.prepare('SELECT 1 FROM clips WHERE id = ? AND artifact_id = ?').get(gap.clipId, gap.inputArtifactId)) {
        invalid('The playback gap clip does not belong to its input artifact.');
      }
      const edge = connection.prepare(`SELECT 1 FROM input_edges e JOIN input_edge_revisions r
        ON r.id = e.current_revision_id WHERE e.output_artifact_id = ? AND r.input_artifact_id = ?
        AND r.clip_id IS NULL AND r.is_effective = 1 LIMIT 1`).get(output, gap.inputArtifactId);
      if (!edge) invalid('An unknown playback revision requires a recorded artifact-level input.');
    }
  }
  addGapsInTransaction(context: MutationContext, outputArtifactId: string, gaps: readonly LineageGapInput[]): LineageGapRecord[] {
    requireArtifact(context.connection, outputArtifactId);
    return gaps.map(gap => {
      this.validateGap(context.connection, outputArtifactId, gap);
      const gapId = randomUUID();
      const revisionId = randomUUID();
      context.connection.prepare('INSERT INTO lineage_gaps(id, output_artifact_id, current_revision_id, revision) VALUES (?, ?, ?, 1)')
        .run(gapId, outputArtifactId, revisionId);
      this.insertGapRevision(context, gapId, revisionId, outputArtifactId, 1, gap, true);
      return this.gap(gapId, context.connection);
    });
  }
  addGaps(outputArtifactId: string, gaps: readonly LineageGapInput[], actor: string): LineageGapRecord[] {
    return this.database.mutate({ actor, targetType: 'lineage-gaps', targetId: outputArtifactId }, context => {
      const result = this.addGapsInTransaction(context, outputArtifactId, gaps);
      return { before: null, after: result, result };
    });
  }
  correctGap(id: string, input: CorrectGapInput, actor: string): LineageGapRecord {
    return this.reviseGap(id, input.expectedRevision, input.gap, true, actor);
  }
  retractGap(id: string, expectedRevision: number, actor: string): LineageGapRecord {
    return this.reviseGap(id, expectedRevision, undefined, false, actor);
  }
  private reviseGap(id: string, expectedRevision: number, gap: LineageGapInput | undefined, effective: boolean, actor: string): LineageGapRecord {
    return this.database.mutate({ actor, targetType: 'lineage-gap', targetId: id,
      expected: [{ expectedRevision, readCurrent: connection => this.gap(id, connection) }],
    }, context => {
      const before = this.gap(id, context.connection);
      const newGap = gap ?? before.gap;
      if (effective) this.validateGap(context.connection, before.outputArtifactId, newGap);
      const revisionId = randomUUID();
      this.insertGapRevision(context, id, revisionId, before.outputArtifactId, before.revision + 1, newGap, effective);
      context.connection.prepare('UPDATE lineage_gaps SET current_revision_id = ?, revision = ? WHERE id = ?')
        .run(revisionId, before.revision + 1, id);
      const after = this.gap(id, context.connection);
      return { before, after, result: after };
    });
  }
  private insertGapRevision(context: MutationContext, id: string, revisionId: string, output: string, revision: number, gap: LineageGapInput, effective: boolean): void {
    context.connection.prepare(`INSERT INTO lineage_gap_revisions
      (id, gap_id, output_artifact_id, revision, gap_kind, input_artifact_id, clip_id, description, source_kind, is_effective, audit_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, id, output, revision,
        gap.kind, gap.inputArtifactId ?? null, gap.kind === 'playback' ? gap.clipId : null,
        gap.description, gap.sourceKind, effective ? 1 : 0, context.eventId);
  }
}
