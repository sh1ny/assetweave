import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateRequestInput, OutcomeReport, ProposedInputRecord, ReportOutcomeInput, RequestRecord,
} from '@assetweave/contracts/production';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { paginate } from '../queries/pagination.js';
import { DatabaseService, RevisionConflict, type MutationContext } from '../database/database.service.js';
import { requireExactInput } from '../lineage/lineage.service.js';

interface RequestRow {
  id: string; projectId: string; assetId: string; slotId: string | null;
  intent: string; notes: string; recordedBy: string; recordedAt: string; outcomeRevision: number;
}
const requestColumns = `id, project_id AS projectId, asset_id AS assetId, slot_id AS slotId,
  intent, notes, recorded_by AS recordedBy, recorded_at AS recordedAt, outcome_revision AS outcomeRevision`;

/** Collections carry counts and a full-detail link, never an apparently complete nested array. */
export interface RequestSummary extends Omit<RequestRecord, 'proposedInputs' | 'capturedArtifacts'> {
  proposedInputCount: number;
  capturedArtifactCount: number;
  detailUrl: string;
}

@Injectable()
export class RequestsService {
  constructor(private readonly database: DatabaseService) {}

  /** Reject a capture's request from another project or asset before receipt registration. */
  requireAssociation(connection: DatabaseSync, requestId: string, projectId: string, assetId: string): void {
    const row = connection.prepare('SELECT project_id AS projectId, asset_id AS assetId FROM requests WHERE id = ?')
      .get(requestId) as { projectId: string; assetId: string } | undefined;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request was not found.' });
    if (row.projectId !== projectId || row.assetId !== assetId) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'The request belongs to a different project or asset.' });
    }
  }
  private requestRow(id: string, connection: DatabaseSync): RequestRow {
    const row = connection.prepare(`SELECT ${requestColumns} FROM requests WHERE id = ?`).get(id) as RequestRow | undefined;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Request was not found.' });
    return row;
  }
  private hydrate(row: RequestRow, connection: DatabaseSync): RequestRecord {
    const proposedInputs = connection.prepare(`SELECT id, request_id AS requestId, ordinal,
      artifact_id AS artifactId, clip_id AS clipId, playback_revision_id AS playbackRevisionId, role
      FROM proposed_inputs WHERE request_id = ? ORDER BY ordinal`).all(row.id) as unknown as ProposedInputRecord[];
    const outcome = row.outcomeRevision === 0 ? { status: 'unknown' as const } : this.currentOutcome(row.id, connection);
    const capturedArtifacts = connection.prepare('SELECT id, captured_at AS capturedAt FROM artifacts WHERE request_id = ? ORDER BY captured_at, id')
      .all(row.id) as unknown as { id: string; capturedAt: string }[];
    return { ...row, proposedInputs, outcome, capturedArtifacts };
  }
  getRequest(id: string): RequestRecord {
    const connection = this.database.connection;
    return this.hydrate(this.requestRow(id, connection), connection);
  }
  listRequests(assetId: string, input: PageInput): QueryPage<RequestSummary> {
    const connection = this.database.connection;
    if (!connection.prepare('SELECT 1 FROM assets WHERE id = ?').get(assetId)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset was not found.' });
    }
    return paginate(this.database, input, ['assets', assetId, 'requests'], (after, count) => {
      const rows = connection.prepare(`SELECT ${requestColumns},
        (SELECT COUNT(*) FROM proposed_inputs p WHERE p.request_id = requests.id) AS proposedInputCount,
        (SELECT COUNT(*) FROM artifacts a WHERE a.request_id = requests.id) AS capturedArtifactCount
        FROM requests WHERE asset_id = ?
          AND (? IS NULL OR recorded_at < ? OR (recorded_at = ? AND id > ?))
        ORDER BY recorded_at DESC, id LIMIT ?`)
        .all(assetId, after?.[0] ?? null, after?.[0] ?? '', after?.[0] ?? '', after?.[1] ?? '', count) as unknown as
        (RequestRow & Pick<RequestSummary, 'proposedInputCount' | 'capturedArtifactCount'>)[];
      return rows.map(row => {
        const { proposedInputCount, capturedArtifactCount, ...record } = row;
        return { ...record, proposedInputCount, capturedArtifactCount,
          outcome: row.outcomeRevision === 0 ? { status: 'unknown' as const } : this.currentOutcome(row.id, connection),
          detailUrl: `/api/requests/${row.id}` };
      });
    }, row => [row.recordedAt, row.id]);
  }
  private currentOutcome(id: string, connection: DatabaseSync): OutcomeReport {
    const row = connection.prepare(`SELECT o.id, o.request_id AS requestId, o.revision, o.status, o.notes,
      a.actor, a.recorded_at AS at FROM request_outcomes o JOIN audit_events a ON a.id = o.audit_event_id
      JOIN requests r ON r.id = o.request_id AND r.outcome_revision = o.revision WHERE o.request_id = ?`)
      .get(id) as OutcomeReport | undefined;
    if (!row) throw new Error('A reported request outcome is missing its current revision.');
    return row;
  }
  outcomeHistory(id: string, input: PageInput): QueryPage<OutcomeReport> {
    this.requestRow(id, this.database.connection);
    return paginate(this.database, input, ['requests', id, 'outcomes'], (after, count) =>
      this.database.connection.prepare(`SELECT o.id, o.request_id AS requestId, o.revision, o.status, o.notes,
        a.actor, a.recorded_at AS at FROM request_outcomes o JOIN audit_events a ON a.id = o.audit_event_id
        WHERE o.request_id = ? AND o.revision > ? ORDER BY o.revision LIMIT ?`)
        .all(id, Number(after?.[0] ?? 0), count) as unknown as OutcomeReport[], row => [String(row.revision)]);
  }

  createRequest(projectId: string, assetId: string, input: CreateRequestInput, actor: string): RequestRecord {
    const id = randomUUID();
    return this.database.mutate({ actor, targetType: 'request', targetId: id }, context => {
      const result = this.createRequestInTransaction(context, id, projectId, assetId, input, actor);
      return { before: null, after: result, result };
    });
  }
  /** Can join an existing mutation; owner supplies a unique request id and the recording actor. */
  createRequestInTransaction(context: MutationContext, id: string, projectId: string, assetId: string,
    input: CreateRequestInput, actor: string): RequestRecord {
    const asset = context.connection.prepare('SELECT project_id AS projectId FROM assets WHERE id = ?')
      .get(assetId) as { projectId: string } | undefined;
    if (!asset) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset was not found.' });
    if (asset.projectId !== projectId) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Asset does not belong to the specified project.' });
    }
    if (input.slotId && !context.connection.prepare('SELECT 1 FROM slots WHERE id = ? AND asset_id = ?')
      .get(input.slotId, assetId)) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Destination slot does not belong to the request asset.' });
    }
    for (const proposed of input.proposedInputs ?? []) requireExactInput(context.connection, proposed);
    context.connection.prepare(`INSERT INTO requests
      (id, project_id, asset_id, slot_id, intent, notes, recorded_by, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, assetId, input.slotId ?? null,
        input.intent, input.notes ?? '', actor, context.at);
    for (const [ordinal, proposed] of (input.proposedInputs ?? []).entries()) {
      context.connection.prepare(`INSERT INTO proposed_inputs
        (id, request_id, ordinal, artifact_id, clip_id, playback_revision_id, role)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, ordinal, proposed.artifactId,
          proposed.clipId ?? null, proposed.playbackRevisionId ?? null, proposed.role ?? null);
    }
    return this.hydrate(this.requestRow(id, context.connection), context.connection);
  }

  reportOutcome(id: string, input: ReportOutcomeInput, actor: string): RequestRecord {
    return this.database.mutate({ actor, targetType: 'request-outcome', targetId: id,
      expected: [{ expectedRevision: input.expectedRevision, readCurrent: connection =>
        ({ revision: this.requestRow(id, connection).outcomeRevision }) }],
    }, context => {
      const before = this.hydrate(this.requestRow(id, context.connection), context.connection);
      const after = this.reportOutcomeInTransaction(context, id, input);
      return { before, after, result: after };
    });
  }
  /** Outcome reporting never changes on capture; every report appends a separate revision. */
  reportOutcomeInTransaction(context: MutationContext, id: string, input: ReportOutcomeInput): RequestRecord {
    const before = this.requestRow(id, context.connection);
    if (before.outcomeRevision !== input.expectedRevision) {
      throw new RevisionConflict(input.expectedRevision, { revision: before.outcomeRevision });
    }
    const revision = before.outcomeRevision + 1;
    context.connection.prepare('INSERT INTO request_outcomes(id, request_id, revision, status, notes, audit_event_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), id, revision, input.status, input.notes ?? '', context.eventId);
    context.connection.prepare('UPDATE requests SET outcome_revision = ? WHERE id = ?').run(revision, id);
    return this.hydrate(this.requestRow(id, context.connection), context.connection);
  }
}
