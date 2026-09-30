import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { QueryPage, RevisionDetail, SearchHit, SearchInput, TextHit, TextSearchInput,
  LineagePage, LineageQuery, LineageStep } from '@assetweave/contracts/queries';
import { DatabaseService } from '../database/database.service.js';
import { requireArtifact } from '../lineage/lineage.service.js';
import { paginate } from './pagination.js';

type SqlValue = string | number | null;
interface SearchRow {
  id: string; projectId: string; assetId: string; kind: string; name: string; capturedAt: string;
  recordType: string | null; recordId: string | null; revisionId: string | null; revision: number | null;
}
interface FrontierStep {
  artifactId: string; depth: number; via: LineageStep['via'];
  expanding?: boolean; edgeAfter?: string; gapAfter?: string;
}

const placeholders = (values: readonly unknown[]) => values.map(() => '?').join(', ');
const textDestinations: Record<string, string> = {
  project: 'projects', asset: 'assets', slot: 'slots', artifact: 'artifacts',
  request: 'requests', outcome: 'requests', claim: 'assertions', clip: 'clips',
  input: 'inputs', gap: 'gaps', review: 'candidates', selection: 'slots',
  'stage-decision': 'assets',
};
function literalPhrase(text: string): string {
  // Recorded text is data, not executable FTS operators.
  return `"${text.replaceAll('"', '""')}"`;
}
function ranges(from: string | undefined, through: string | undefined): void {
  if (from && through && new Date(from).getTime() > new Date(through).getTime()) {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'The date range ends before it begins.' });
  }
}

@Injectable()
export class SearchService {
  constructor(private readonly database: DatabaseService) {
    // The entire projection runs in DatabaseService.mutate, after domain writes
    // and before COMMIT. A failed FTS insert rolls the record and clock back too.
    database.addProjection((event, connection) => {
      connection.prepare(`UPDATE search_documents SET current = 0 WHERE (record_type, record_id) IN
        (SELECT record_type, record_id FROM search_sources WHERE audit_event_id = ?)`).run(event.id);
      connection.prepare(`INSERT INTO search_documents(record_type, record_id, revision_id, revision, scope, scope_id, body, current)
        SELECT record_type, record_id, revision_id, revision, scope, scope_id, body, current
        FROM search_sources WHERE audit_event_id = ?`).run(event.id);
    });
  }

  search(input: SearchInput): QueryPage<SearchHit> {
    const { filters: f } = input;
    ranges(f.captured?.from, f.captured?.through);
    ranges(f.produced?.from, f.produced?.through);
    if (input.scope === 'history' && !input.text) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Historical search requires text.' });
    }
    const predicates: string[] = [];
    const params: SqlValue[] = [];
    const category = (field: string, values: readonly string[] | undefined) => {
      if (values?.length) { predicates.push(`${field} IN (${placeholders(values)})`); params.push(...values); }
    };
    category('a.project_id', f.projectIds);
    category('a.asset_id', f.assetIds);
    category('a.kind', f.kinds);
    // Slot, review and selection describe one placement, never three unrelated
    // candidates which happen to share the same captured artifact.
    if (f.slotIds?.length || f.reviews?.length || f.selection?.length) {
      const candidate: string[] = ['c.artifact_id = a.id'];
      if (f.slotIds?.length) {
        candidate.push(`c.slot_id IN (${placeholders(f.slotIds)})`);
        params.push(...f.slotIds);
      }
      if (f.reviews?.length) {
        candidate.push(`c.review_state IN (${placeholders(f.reviews)})`);
        params.push(...f.reviews);
      }
      if (f.selection?.length) {
        const states: string[] = [];
        if (f.selection.includes('selected')) states.push('s.selected_candidate_id = c.id');
        if (f.selection.includes('not-selected')) states.push('s.selected_candidate_id IS NOT c.id');
        if (f.selection.includes('formerly-selected')) states.push(`(
          s.selected_candidate_id IS NOT c.id AND
          EXISTS (SELECT 1 FROM slot_selections h WHERE h.slot_id = s.id AND h.previous_candidate_id = c.id))`);
        candidate.push(`(${states.join(' OR ')})`);
      }
      const placed = `EXISTS (SELECT 1 FROM candidates c JOIN slots s ON s.id = c.slot_id
        WHERE ${candidate.join(' AND ')})`;
      const allowUnslotted = (f.unslotted || f.selection?.includes('not-selected')) &&
        !f.reviews?.length && (!f.selection?.length || f.selection.includes('not-selected')) &&
        (!f.slotIds?.length || f.unslotted);
      predicates.push(allowUnslotted
        ? `(${placed} OR NOT EXISTS (SELECT 1 FROM candidates c WHERE c.artifact_id = a.id))` : placed);
    } else if (f.unslotted) {
      predicates.push('NOT EXISTS (SELECT 1 FROM candidates c WHERE c.artifact_id = a.id)');
    }
    if (f.stages?.length || f.stageNone) {
      const alternatives: string[] = [];
      if (f.stages?.length) { alternatives.push(`owner.stage IN (${placeholders(f.stages)})`); params.push(...f.stages); }
      if (f.stageNone) alternatives.push('owner.stage IS NULL');
      predicates.push(`(${alternatives.join(' OR ')})`);
    }
    if (f.producers?.length) {
      predicates.push(`EXISTS (SELECT 1 FROM provenance_assertions p JOIN provenance_revisions r ON r.id = p.current_revision_id
        JOIN json_tree(r.value_json) j WHERE p.artifact_id = a.id AND p.field = 'producer' AND r.state = 'known'
        AND j.type = 'text' AND CAST(j.atom AS TEXT) IN (${placeholders(f.producers)}))`);
      params.push(...f.producers);
    }
    if (f.captured?.from) { predicates.push('a.captured_at >= ?'); params.push(f.captured.from); }
    if (f.captured?.through) { predicates.push('a.captured_at <= ?'); params.push(f.captured.through); }
    if (f.produced || f.unknownProductionDate) {
      const date = `SELECT julianday(json_extract(r.value_json, '$')) FROM provenance_assertions p
        JOIN provenance_revisions r ON r.id = p.current_revision_id WHERE p.artifact_id = a.id
        AND p.field = 'productionTime' AND r.state = 'known' AND json_type(r.value_json) = 'text'`;
      const known: string[] = [`(${date}) IS NOT NULL`];
      if (f.produced?.from) { known.push(`(${date}) >= julianday(?)`); params.push(f.produced.from); }
      if (f.produced?.through) { known.push(`(${date}) <= julianday(?)`); params.push(f.produced.through); }
      const match = known.join(' AND ');
      predicates.push(f.unknownProductionDate ? f.produced ? `((${match}) OR (${date}) IS NULL)` : `(${date}) IS NULL` : `(${match})`);
    }
    if (f.ancestorOf?.length) {
      predicates.push(`a.id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (
        WITH RECURSIVE reach(id) AS (SELECT value FROM json_each(?) UNION
          SELECT r.input_artifact_id FROM reach JOIN input_edges e ON e.output_artifact_id = reach.id
          JOIN input_edge_revisions r ON r.id = e.current_revision_id WHERE r.is_effective = 1)
        SELECT 1 FROM reach WHERE id = a.id)`);
      params.push(JSON.stringify(f.ancestorOf), JSON.stringify(f.ancestorOf));
    }
    if (f.descendantOf?.length) {
      predicates.push(`a.id NOT IN (SELECT value FROM json_each(?)) AND EXISTS (
        WITH RECURSIVE reach(id) AS (SELECT value FROM json_each(?) UNION
          SELECT e.output_artifact_id FROM reach JOIN input_edge_revisions r ON r.input_artifact_id = reach.id
          JOIN input_edges e ON e.current_revision_id = r.id WHERE r.is_effective = 1)
        SELECT 1 FROM reach WHERE id = a.id)`);
      params.push(JSON.stringify(f.descendantOf), JSON.stringify(f.descendantOf));
    }
    const columns = `a.id, a.project_id AS projectId, a.asset_id AS assetId, a.kind, a.name,
      a.captured_at AS capturedAt`;
    const text = input.text;
    if (text) {
      const phrase = literalPhrase(text);
      const associated = `(d.scope = 'artifact' AND d.scope_id = a.id OR
        d.scope = 'asset' AND d.scope_id = a.asset_id OR
        d.scope = 'project' AND d.scope_id = a.project_id OR
        d.scope = 'request' AND d.scope_id = a.request_id OR
        d.scope = 'slot' AND EXISTS (SELECT 1 FROM candidates c WHERE c.artifact_id = a.id AND c.slot_id = d.scope_id))`;
      if (input.scope === 'history') {
        // Historical identity belongs to the exact matched document, not the artifact's current fields.
        return paginate(this.database, input, ['artifact-search', f, text, input.scope, 'captured-desc-id-revision'], (after, count) => {
          const keyset = after ? `AND (a.captured_at < ? OR (a.captured_at = ? AND (a.id > ? OR
            (a.id = ? AND (d.record_type > ? OR (d.record_type = ? AND d.revision_id > ?))))))` : '';
          const sql = `SELECT ${columns}, d.record_type AS recordType, d.record_id AS recordId,
            d.revision_id AS revisionId, d.revision FROM artifacts a JOIN assets owner ON owner.id = a.asset_id
            JOIN search_documents d ON ${associated} JOIN search_fts ON search_fts.rowid = d.id
            WHERE search_fts MATCH ? AND (${predicates.join(' AND ') || '1 = 1'}) ${keyset}
            ORDER BY a.captured_at DESC, a.id, d.record_type, d.revision_id LIMIT ?`;
          const args = [phrase, ...params, ...(after ? [after[0]!, after[0]!, after[1]!, after[1]!, after[2]!, after[2]!, after[3]!] : []), count];
          return (this.database.connection.prepare(sql).all(...args) as unknown as SearchRow[]).map(row => this.hit(row));
        }, row => [row.capturedAt, row.artifactId, row.matchedRevision!.type, row.matchedRevision!.revisionId]);
      }
      predicates.push(`EXISTS (SELECT 1 FROM search_documents d JOIN search_fts ON search_fts.rowid = d.id
        WHERE search_fts MATCH ? AND ${associated} AND d.current = 1)`);
      params.push(phrase);
    }
    const where = predicates.length ? predicates.join(' AND ') : '1 = 1';
    return paginate(this.database, input, ['artifact-search', f, text ?? null, input.scope, 'captured-desc-id'], (after, count) => {
      const keyset = after ? ' AND (a.captured_at < ? OR (a.captured_at = ? AND a.id > ?))' : '';
      const sql = `SELECT ${columns}, NULL AS recordType, NULL AS recordId, NULL AS revisionId, NULL AS revision
        FROM artifacts a JOIN assets owner ON owner.id = a.asset_id WHERE ${where}${keyset}
        ORDER BY a.captured_at DESC, a.id LIMIT ?`;
      const args = [...params, ...(after ? [after[0]!, after[0]!, after[1]!] : []), count];
      return (this.database.connection.prepare(sql).all(...args) as unknown as SearchRow[]).map(row => this.hit(row));
    }, row => [row.capturedAt, row.artifactId]);
  }

  private hit(row: SearchRow): SearchHit {
    return { artifactId: row.id, projectId: row.projectId, assetId: row.assetId,
      kind: row.kind, name: row.name, capturedAt: row.capturedAt,
      recordUrl: `/api/artifacts/${row.id}`,
      matchedRevision: row.revisionId === null ? null : {
        type: row.recordType!, recordId: row.recordId!, revisionId: row.revisionId,
        revision: row.revision!, url: `/api/queries/revisions/${row.recordType}/${encodeURIComponent(row.revisionId)}`,
      } };
  }

  /** Includes standalone records such as requests made before any output exists. */
  searchText(input: TextSearchInput): QueryPage<TextHit> {
    const connection = this.database.connection;
    const phrase = literalPhrase(input.text);
    interface Row {
      id: number; recordType: string; recordId: string; revisionId: string; revision: number;
      scope: TextHit['scope']; scopeId: string; excerpt: string; excerptTruncated: number;
    }
    const page = paginate(this.database, input, ['text-corpus', input.text, input.scope, 'document-id'], (after, count) => {
      const rows = connection.prepare(`SELECT d.id, d.record_type AS recordType, d.record_id AS recordId,
        d.revision_id AS revisionId, d.revision, d.scope, d.scope_id AS scopeId,
        substr(d.body, 1, 512) AS excerpt, (length(d.body) > 512) AS excerptTruncated
        FROM search_fts JOIN search_documents d ON d.id = search_fts.rowid
        WHERE search_fts MATCH ? ${input.scope === 'current' ? 'AND d.current = 1' : ''}
          AND d.id > ? ORDER BY d.id LIMIT ?`)
        .all(phrase, Number(after?.[0] ?? 0), count) as unknown as Row[];
      return rows.map(row => ({
        id: row.id, type: row.recordType, recordId: row.recordId, revisionId: row.revisionId,
        revision: row.revision, scope: row.scope, scopeId: row.scopeId, excerpt: row.excerpt,
        excerptTruncated: row.excerptTruncated === 1,
        recordUrl: `/api/${textDestinations[row.recordType]}/${encodeURIComponent(row.recordId)}`,
        revisionUrl: `/api/queries/revisions/${row.recordType}/${encodeURIComponent(row.revisionId)}`,
      }));
    }, row => [String(row.id)]);
    return { ...page, items: page.items.map(({ id: _documentId, ...hit }) => hit) };
  }

  /** Open the exact revision named by a historical hit; normal artifact details remain effective. */
  getRevision(type: string, revisionId: string): RevisionDetail {
    const connection = this.database.connection;
    const doc = connection.prepare(`SELECT record_id AS recordId, revision, current FROM search_documents
      WHERE record_type = ? AND revision_id = ?`).get(type, revisionId) as
      { recordId: string; revision: number; current: number } | undefined;
    if (!doc) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recorded revision was not found.' });
    const revisions: Record<string, { table: string; column: string; composite?: string }> = {
      project: { table: 'project_revisions', column: 'project_id', composite: 'revision' },
      asset: { table: 'asset_revisions', column: 'asset_id', composite: 'revision' },
      slot: { table: 'slot_revisions', column: 'slot_id', composite: 'revision' },
      artifact: { table: 'artifacts', column: 'id' },
      request: { table: 'requests', column: 'id' },
      outcome: { table: 'request_outcomes', column: 'id' },
      claim: { table: 'provenance_revisions', column: 'id' },
      clip: { table: 'playback_revisions', column: 'id' },
      input: { table: 'input_edge_revisions', column: 'id' },
      gap: { table: 'lineage_gap_revisions', column: 'id' },
      review: { table: 'candidate_reviews', column: 'id' },
      selection: { table: 'slot_selections', column: 'id' },
      'stage-decision': { table: 'asset_stage_decisions', column: 'id' },
    };
    const source = revisions[type];
    if (!source) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recorded revision was not found.' });
    const record = source.composite
      ? connection.prepare(`SELECT * FROM ${source.table} WHERE ${source.column} = ? AND revision = ?`).get(doc.recordId, doc.revision)
      : connection.prepare(`SELECT * FROM ${source.table} WHERE ${source.column} = ?`).get(revisionId);
    const row = connection.prepare(`SELECT audit_event_id AS auditEventId FROM search_sources
      WHERE record_type = ? AND revision_id = ?`).get(type, revisionId) as { auditEventId: number } | undefined;
    const audit = row ? connection.prepare('SELECT actor, recorded_at AS at FROM audit_events WHERE id = ?')
      .get(row.auditEventId) as { actor: string; at: string } | undefined : undefined;
    if (!record || !audit) throw new Error('A search revision is missing its retained source or audit event.');
    return { type, recordId: doc.recordId, revisionId, revision: doc.revision,
      current: doc.current === 1, actor: audit.actor, at: audit.at, record };
  }

  /** Replay the stable breadth-first order up to a signed position, without storing a growing frontier in the cursor. */
  traverse(originArtifactId: string, input: LineageQuery): LineagePage {
    const connection = this.database.connection;
    requireArtifact(connection, originArtifactId);
    // Version the identity so signed cursors carrying the former compressed frontier conflict cleanly.
    const identity = ['lineage', 'position-v2', originArtifactId, input.direction, input.limit];
    const origin: FrontierStep = { artifactId: originArtifactId, depth: 0, via: null };
    let final: { visited: string[]; visitedCount: number; frontier: string[];
      frontierCount: number; gapCount: number } | undefined;
    const page = paginate(this.database, input, identity,
      (after, count) => {
        if (after && (after.length !== 1 || !/^[1-9]\d*$/.test(after[0]!) ||
            !Number.isSafeInteger(Number(after[0])))) {
          throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid lineage continuation position.' });
        }
        const start = after ? Number(after[0]) : 0;
        const seen = new Set<string>();
        const visitedTail: string[] = [];
        const pending: FrontierStep[] = [origin];
        const pendingIds = new Set([originArtifactId]);
        const steps: { step: LineageStep; position: number }[] = [];
        let position = 0;
        let gapCount = 0;
        const snapshot = () => {
          final = { visited: visitedTail.slice(), visitedCount: seen.size,
            frontier: pending.slice(0, input.limit).map(node => node.artifactId),
            frontierCount: pending.length, gapCount };
        };
        while (pending.length && steps.length < count) {
          const node = pending.shift()!;
          pendingIds.delete(node.artifactId);
          if (seen.has(node.artifactId)) {
            if (!node.expanding) continue;
          } else {
            seen.add(node.artifactId);
            visitedTail.push(node.artifactId);
            if (visitedTail.length > input.limit) visitedTail.shift();
          }
          const gapRows = connection.prepare(`SELECT r.gap_id AS id, r.id AS revisionId,
            substr(r.description, 1, 512) AS description,
            (length(r.description) > 512) AS descriptionTruncated, r.gap_kind AS kind
            FROM lineage_gaps g JOIN lineage_gap_revisions r ON r.id = g.current_revision_id
            WHERE g.output_artifact_id = ? AND r.is_effective = 1 ${node.gapAfter ? 'AND g.id > ?' : ''}
            ORDER BY g.id LIMIT ?`)
            .all(node.artifactId, ...(node.gapAfter ? [node.gapAfter] : []), input.limit + 1) as unknown as
            (Omit<LineageStep['gaps'][number], 'descriptionTruncated' | 'url'> & { descriptionTruncated: number })[];
          const localGapCount = Math.min(gapRows.length, input.limit);
          gapCount += localGapCount;
          const linkRows = connection.prepare(input.direction === 'inputs'
            ? `SELECT e.id, r.id AS revisionId, r.input_artifact_id AS inputArtifactId,
                 e.output_artifact_id AS outputArtifactId, r.role, r.input_artifact_id AS next
               FROM input_edges e JOIN input_edge_revisions r ON r.id = e.current_revision_id
               WHERE e.output_artifact_id = ? AND r.is_effective = 1 ${node.edgeAfter ? 'AND e.id > ?' : ''}
               ORDER BY e.id LIMIT ?`
            : `SELECT e.id, r.id AS revisionId, r.input_artifact_id AS inputArtifactId,
                 e.output_artifact_id AS outputArtifactId, r.role, e.output_artifact_id AS next
               FROM input_edge_revisions r JOIN input_edges e ON e.current_revision_id = r.id
               WHERE r.input_artifact_id = ? AND r.is_effective = 1 ${node.edgeAfter ? 'AND e.id > ?' : ''}
               ORDER BY e.id LIMIT ?`)
            .all(node.artifactId, ...(node.edgeAfter ? [node.edgeAfter] : []), input.limit + 1) as unknown as (NonNullable<LineageStep['via']> & { next: string })[];
          const localLinkCount = Math.min(linkRows.length, input.limit);
          for (let index = 0; index < localLinkCount; index++) {
            const link = linkRows[index]!;
            if (!seen.has(link.next) && !pendingIds.has(link.next)) {
              pending.push({ artifactId: link.next, depth: node.depth + 1,
                via: { id: link.id, revisionId: link.revisionId, inputArtifactId: link.inputArtifactId,
                  outputArtifactId: link.outputArtifactId, role: link.role, url: `/api/inputs/${link.id}` } });
              pendingIds.add(link.next);
            }
          }
          if (gapRows.length > input.limit || linkRows.length > input.limit) {
            pending.unshift({ ...node, expanding: true,
              edgeAfter: linkRows[localLinkCount - 1]?.id ?? node.edgeAfter,
              gapAfter: gapRows[localGapCount - 1]?.id ?? node.gapAfter });
            pendingIds.add(node.artifactId);
          }
          // Expanding a wide node emits multiple steps; positions count steps, not just unique artifacts.
          position++;
          if (position <= start) continue;
          const step: LineageStep = { artifactId: node.artifactId, artifactUrl: `/api/artifacts/${node.artifactId}`,
            depth: node.depth, via: node.via,
            links: linkRows.slice(0, localLinkCount).map(link => ({ id: link.id, revisionId: link.revisionId,
              inputArtifactId: link.inputArtifactId, outputArtifactId: link.outputArtifactId,
              role: link.role, url: `/api/inputs/${link.id}` })),
            gaps: gapRows.slice(0, localGapCount).map(gap => ({
              ...gap, descriptionTruncated: gap.descriptionTruncated === 1, url: `/api/gaps/${gap.id}`,
            })) };
          steps.push({ step, position });
          if (steps.length === input.limit) snapshot();
        }
        if (steps.length && !final) snapshot();
        return steps;
      }, row => [String(row.position)]);
    const visited = final?.visited ?? [];
    const frontier = final?.frontier ?? (input.cursor ? [] : [originArtifactId]);
    const pageGaps = page.items.flatMap(row => row.step.gaps);
    return { originArtifactId, direction: input.direction, watermark: page.watermark,
      items: page.items.map(row => row.step), nextCursor: page.nextCursor,
      visited, visitedCount: final?.visitedCount ?? 0,
      visitedTruncated: (final?.visitedCount ?? 0) > input.limit,
      frontier, frontierCount: final?.frontierCount ?? frontier.length,
      frontierTruncated: (final?.frontierCount ?? frontier.length) > input.limit,
      encounteredGaps: pageGaps.slice(0, input.limit),
      encounteredGapCount: final?.gapCount ?? 0,
      encounteredGapsTruncated: pageGaps.length > input.limit };
  }
}
