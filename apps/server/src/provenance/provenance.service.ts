import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ClaimInput, ClaimRecord, ClaimRevision, CorrectClaimInput, NotRecordedClaim } from '@assetweave/contracts/production';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { DatabaseService, type MutationContext } from '../database/database.service.js';
import { requireArtifact } from '../lineage/lineage.service.js';
import { paginate } from '../queries/pagination.js';

const columns = `r.id, r.assertion_id AS assertionId, r.artifact_id AS artifactId, r.revision,
  r.state, r.value_json AS valueJson, r.source_kind AS sourceKind, r.source_detail AS sourceDetail,
  p.field, p.current_revision_id AS currentRevisionId, a.actor, a.recorded_at AS at`;
type ClaimRow = Omit<ClaimRecord, 'claim'> & {
  state: 'known' | 'unknown' | 'absent'; valueJson: string | null;
  sourceKind: string; sourceDetail: string | null; field: string;
};
function fromRow(row: ClaimRow): ClaimRecord {
  const source = { kind: row.sourceKind, ...(row.sourceDetail === null ? {} : { detail: row.sourceDetail }) };
  const claim: ClaimInput = row.state === 'known'
    ? { field: row.field, state: 'known', value: JSON.parse(row.valueJson!), source }
    : { field: row.field, state: row.state, source };
  return { id: row.id, assertionId: row.assertionId, artifactId: row.artifactId,
    revision: row.revision, currentRevisionId: row.currentRevisionId,
    claim, actor: row.actor, at: row.at };
}

@Injectable()
export class ProvenanceService {
  constructor(private readonly database: DatabaseService) {}

  private assertion(id: string, connection = this.database.connection): ClaimRecord {
    const row = connection.prepare(`SELECT ${columns} FROM provenance_assertions p
      JOIN provenance_revisions r ON r.id = p.current_revision_id
      JOIN audit_events a ON a.id = r.audit_event_id WHERE p.id = ?`).get(id) as ClaimRow | undefined;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Assertion was not found.' });
    return fromRow(row);
  }
  getAssertion(id: string): ClaimRecord { return this.assertion(id); }
  getClaim(artifactId: string, field: string): ClaimRecord | NotRecordedClaim {
    requireArtifact(this.database.connection, artifactId);
    const row = this.database.connection.prepare(`SELECT ${columns} FROM provenance_assertions p
      JOIN provenance_revisions r ON r.id = p.current_revision_id
      JOIN audit_events a ON a.id = r.audit_event_id WHERE p.artifact_id = ? AND p.field = ?`)
      .get(artifactId, field) as ClaimRow | undefined;
    return row ? fromRow(row) : { artifactId, field, state: 'not-recorded' };
  }
  listClaims(artifactId: string, input: PageInput): QueryPage<ClaimRecord> {
    requireArtifact(this.database.connection, artifactId);
    return paginate(this.database, input, ['artifacts', artifactId, 'claims'], (after, count) => {
      const rows = this.database.connection.prepare(`SELECT ${columns} FROM provenance_assertions p
        JOIN provenance_revisions r ON r.id = p.current_revision_id
        JOIN audit_events a ON a.id = r.audit_event_id
        WHERE p.artifact_id = ? ${after ? 'AND (p.field > ? OR (p.field = ? AND p.id > ?))' : ''}
        ORDER BY p.field, p.id LIMIT ?`)
        .all(artifactId, ...(after ? [after[0]!, after[0]!, after[1]!] : []), count) as unknown as ClaimRow[];
      return rows.map(fromRow);
    }, row => [row.claim.field, row.assertionId]);
  }
  assertionHistory(id: string, input: PageInput): QueryPage<ClaimRevision> {
    this.assertion(id);
    return paginate(this.database, input, ['assertions', id, 'history'], (after, count) => {
      const rows = this.database.connection.prepare(`SELECT ${columns} FROM provenance_assertions p
        JOIN provenance_revisions r ON r.assertion_id = p.id
        JOIN audit_events a ON a.id = r.audit_event_id
        WHERE p.id = ? ${after ? 'AND r.revision > ?' : ''}
        ORDER BY r.revision, r.id LIMIT ?`)
        .all(id, ...(after ? [Number(after[0])] : []), count) as unknown as ClaimRow[];
      return rows.map(row => {
        const { currentRevisionId: _current, ...history } = fromRow(row);
        return history;
      });
    }, row => [String(row.revision)]);
  }

  /** Add all supplied claims using the capture's event and transaction; absent fields stay not-recorded. */
  addClaimsInTransaction(context: MutationContext, artifactId: string, claims: readonly ClaimInput[]): ClaimRecord[] {
    requireArtifact(context.connection, artifactId);
    return claims.map(claim => {
      if (context.connection.prepare('SELECT 1 FROM provenance_assertions WHERE artifact_id = ? AND field = ?')
        .get(artifactId, claim.field)) {
        throw new ConflictException({ code: 'CONFLICT', message: `The ${claim.field} assertion already exists; correct it with its revision.` });
      }
      const assertionId = randomUUID();
      const revisionId = randomUUID();
      context.connection.prepare('INSERT INTO provenance_assertions(id, artifact_id, field, current_revision_id, revision) VALUES (?, ?, ?, ?, 1)')
        .run(assertionId, artifactId, claim.field, revisionId);
      this.insertRevision(context, assertionId, revisionId, artifactId, 1, claim);
      return this.assertion(assertionId, context.connection);
    });
  }
  addClaims(artifactId: string, claims: readonly ClaimInput[], actor: string): ClaimRecord[] {
    return this.database.mutate({ actor, targetType: 'artifact-claims', targetId: artifactId }, context => {
      const result = this.addClaimsInTransaction(context, artifactId, claims);
      return { before: null, after: result, result };
    });
  }
  correctAssertion(id: string, input: CorrectClaimInput, actor: string): ClaimRecord {
    return this.database.mutate({ actor, targetType: 'assertion', targetId: id,
      expected: [{ expectedRevision: input.expectedRevision, readCurrent: connection => this.assertion(id, connection) }],
    }, context => {
      const before = this.assertion(id, context.connection);
      if (input.claim.field !== before.claim.field) {
        throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A correction cannot change the assertion field.' });
      }
      const revisionId = randomUUID();
      this.insertRevision(context, id, revisionId, before.artifactId, before.revision + 1, input.claim);
      context.connection.prepare('UPDATE provenance_assertions SET current_revision_id = ?, revision = ? WHERE id = ?')
        .run(revisionId, before.revision + 1, id);
      const after = this.assertion(id, context.connection);
      return { before, after, result: after };
    });
  }
  private insertRevision(context: MutationContext, id: string, revisionId: string, artifactId: string, revision: number, claim: ClaimInput): void {
    context.connection.prepare(`INSERT INTO provenance_revisions
      (id, assertion_id, artifact_id, revision, state, value_json, source_kind, source_detail, audit_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, id, artifactId, revision,
        claim.state, claim.state === 'known' ? JSON.stringify(claim.value) : null,
        claim.source.kind, claim.source.detail ?? null, context.eventId);
  }
}
