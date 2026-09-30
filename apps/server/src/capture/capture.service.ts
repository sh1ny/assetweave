import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import * as z from 'zod';
import {
  captureMetadata, captureLimits, type CaptureDescriptor, type CaptureMetadata,
  type CaptureReceipt, type CaptureRecord, type CaptureRecovery, type StoredMember,
} from '@assetweave/contracts/capture';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { paginate } from '../queries/pagination.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { DatabaseService, type MutationContext } from '../database/database.service.js';
import { LineageService } from '../lineage/lineage.service.js';
import { ProvenanceService } from '../provenance/provenance.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { ContentStore, IncompleteContent, makeDescriptor, sameMembers, UnavailableContent, type CaptureStage } from './content-store.js';
import { reconcileCapture } from './reconcile.js';

interface ArtifactRow {
  id: string; operationId: string; projectId: string; assetId: string; requestId: string | null;
  kind: string; name: string; notes: string; capturedAt: string; recordedBy: string;
  fingerprint: string;
}
interface ReceiptRow { artifactId: string; fingerprint: string }
const artifactColumns = `a.id, a.operation_id AS operationId, a.project_id AS projectId, a.asset_id AS assetId,
  a.request_id AS requestId, a.kind, a.name, a.notes, a.captured_at AS capturedAt,
  a.recorded_by AS recordedBy, r.fingerprint`;
/** List content is metadata only; full detail GET performs byte verification. */
export interface ArtifactSummary extends Omit<CaptureRecord, 'content' | 'candidateId'> {
  content: 'not-checked';
  candidateCount: number;
  candidateId: string | null;
  detailUrl: string;
}
const id = z.uuid();
function invalid(message: string): never {
  throw new BadRequestException({ code: 'INVALID_REQUEST', message });
}
function unavailable(): never {
  throw new ServiceUnavailableException({ code: 'CONTENT_UNAVAILABLE', message: 'Captured content is unavailable; inspect capture recovery.' });
}
function incomplete(message: string): never {
  throw new BadRequestException({ code: 'INCOMPLETE_CAPTURE', message });
}
function receiptUrl(operationId: string): string { return `/api/captures/operations/${operationId}`; }

@Injectable()
export class CaptureService implements OnModuleInit {
  private readonly active = new Set<string>();
  constructor(
    private readonly database: DatabaseService,
    private readonly content: ContentStore,
    private readonly catalog: CatalogService,
    private readonly requests: RequestsService,
    private readonly provenance: ProvenanceService,
    private readonly lineage: LineageService,
  ) {}

  async onModuleInit(): Promise<void> {
    const report = await this.recovery();
    if (report.incompleteStaging.length || report.publishedOrphans.length || report.unavailableContent.length) {
      console.warn(`Capture recovery: ${report.incompleteStaging.length} incomplete staging, ` +
        `${report.publishedOrphans.length} published orphans, ${report.unavailableContent.length} unavailable registered captures. ` +
        'Inspect the authenticated /api/captures/recovery endpoint; nothing was changed automatically.');
    }
  }
  recovery(): Promise<CaptureRecovery> { return reconcileCapture(this.database.connection, this.content); }

  private artifactRow(idValue: string, connection = this.database.connection): ArtifactRow {
    const row = connection.prepare(`SELECT ${artifactColumns} FROM artifacts a
      JOIN capture_receipts r ON r.operation_id = a.operation_id AND r.artifact_id = a.id WHERE a.id = ?`)
      .get(idValue) as ArtifactRow | undefined;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Artifact was not found.' });
    return row;
  }
  private members(artifactId: string, connection = this.database.connection): StoredMember[] {
    const rows = connection.prepare(`SELECT ordinal, stored_name AS storedName, source_name AS sourceName,
      byte_count AS byteCount, sha256, media_type AS mediaType FROM content_members WHERE artifact_id = ? ORDER BY ordinal`)
      .all(artifactId) as unknown as (Omit<StoredMember, 'mediaType'> & { mediaType: string | null })[];
    return rows.map(row => {
      const { mediaType, ...rest } = row;
      return { ...rest, ...(mediaType === null ? {} : { mediaType }) };
    });
  }
  async getArtifact(artifactId: string, verification: 'all' | 'metadata' = 'all'): Promise<CaptureRecord> {
    const row = this.artifactRow(id.parse(artifactId));
    const members = this.members(row.id);
    let content: CaptureRecord['content'] = 'available';
    let slotId: string | null = null;
    try {
      const descriptor = await this.content.readDescriptor(row.id);
      if (descriptor.fingerprint !== row.fingerprint || descriptor.operationId !== row.operationId ||
          descriptor.projectId !== row.projectId || descriptor.assetId !== row.assetId ||
          descriptor.requestId !== row.requestId || descriptor.kind !== row.kind ||
          descriptor.name !== row.name || descriptor.notes !== row.notes ||
          !sameMembers(descriptor.members, members)) throw new UnavailableContent();
      slotId = descriptor.slotId;
      if (verification === 'all') await this.content.verifyDescriptor(descriptor);
    } catch { content = 'unavailable'; }
    const candidate = slotId === null ? undefined : this.database.connection.prepare(
      'SELECT id FROM candidates WHERE artifact_id = ? AND slot_id = ? AND clip_id IS NULL',
    ).get(row.id, slotId) as { id: string } | undefined;
    return { id: row.id, operationId: row.operationId, projectId: row.projectId, assetId: row.assetId,
      requestId: row.requestId, kind: row.kind, name: row.name, notes: row.notes,
      capturedAt: row.capturedAt, recordedBy: row.recordedBy, members, content,
      candidateId: candidate?.id ?? null };
  }
  listArtifacts(assetId: string, input: PageInput): QueryPage<ArtifactSummary> {
    const asset = this.catalog.getAsset(id.parse(assetId));
    const connection = this.database.connection;
    return paginate(this.database, input, ['assets', asset.id, 'artifacts'], (after, count) => {
      const rows = connection.prepare(`SELECT ${artifactColumns},
        (SELECT COUNT(*) FROM candidates c WHERE c.artifact_id = a.id AND c.clip_id IS NULL) AS candidateCount,
        (SELECT c.id FROM candidates c WHERE c.artifact_id = a.id AND c.clip_id IS NULL ORDER BY c.slot_id, c.id LIMIT 1) AS candidateId
        FROM artifacts a JOIN capture_receipts r ON r.operation_id = a.operation_id AND r.artifact_id = a.id
        WHERE a.asset_id = ? AND (? IS NULL OR a.captured_at < ? OR (a.captured_at = ? AND a.id > ?))
        ORDER BY a.captured_at DESC, a.id LIMIT ?`)
        .all(asset.id, after?.[0] ?? null, after?.[0] ?? '', after?.[0] ?? '', after?.[1] ?? '', count) as unknown as
        (ArtifactRow & { candidateCount: number; candidateId: string | null })[];
      return rows.map(row => ({
        id: row.id, operationId: row.operationId, projectId: row.projectId, assetId: row.assetId,
        requestId: row.requestId, kind: row.kind, name: row.name, notes: row.notes,
        capturedAt: row.capturedAt, recordedBy: row.recordedBy, members: this.members(row.id, connection),
        content: 'not-checked' as const, candidateCount: row.candidateCount,
        candidateId: row.candidateCount === 1 ? row.candidateId : null,
        detailUrl: `/api/artifacts/${row.id}`,
      }));
    }, row => [row.capturedAt, row.id]);
  }
  async resolveMember(artifactId: string, ordinal: number): Promise<{ path: string; member: StoredMember }> {
    const record = await this.getArtifact(artifactId);
    if (record.content === 'unavailable') unavailable();
    const member = record.members[ordinal];
    if (!member || member.ordinal !== ordinal) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member was not found.' });
    try { return { path: await this.content.memberPath(record.id, member), member }; }
    catch { return unavailable(); }
  }
  private async orphan(operationId: string): Promise<CaptureDescriptor | undefined> {
    let found: CaptureDescriptor | undefined;
    for (const name of await this.content.listDirectories('artwork')) {
      if (!id.safeParse(name).success) continue;
      try {
        const descriptor = await this.content.readDescriptor(name);
        if (descriptor.operationId !== operationId) continue;
        if (found) throw new ConflictException({ code: 'CONFLICT', message: 'Multiple published directories claim this operation.' });
        found = descriptor;
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        // An invalid directory is reported by reconciliation, never trusted as a receipt.
      }
    }
    return found;
  }
  async receipt(operationId: string): Promise<CaptureReceipt> {
    const operation = id.parse(operationId);
    const url = receiptUrl(operation);
    // A completed transaction is authoritative even while its capture request is unwinding.
    const committed = this.database.connection.prepare('SELECT artifact_id AS artifactId, fingerprint FROM capture_receipts WHERE operation_id = ?')
      .get(operation) as ReceiptRow | undefined;
    if (!committed && this.active.has(operation)) return { status: 'in-progress', operationId: operation, receiptUrl: url };
    const stored = await this.receiptWhileActive(operation, committed ?? null);
    if (!stored) return { status: 'absent', operationId: operation, receiptUrl: url };
    if (stored.status === 'committed') return stored;
    return { status: stored.status, operationId: operation, artifactId: stored.artifactId, receiptUrl: url };
  }
  private register(context: MutationContext, descriptor: CaptureDescriptor, actor: string): void {
    const asset = context.connection.prepare('SELECT project_id AS projectId FROM assets WHERE id = ?')
      .get(descriptor.assetId) as { projectId: string } | undefined;
    if (!asset) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Asset was not found.' });
    if (asset.projectId !== descriptor.projectId) invalid('The asset belongs to a different project.');
    if (descriptor.requestId) this.requests.requireAssociation(context.connection, descriptor.requestId,
      descriptor.projectId, descriptor.assetId);
    context.connection.prepare(`INSERT INTO artifacts
      (id, project_id, asset_id, request_id, operation_id, kind, name, notes, content_directory, captured_at, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(descriptor.artifactId, descriptor.projectId,
        descriptor.assetId, descriptor.requestId, descriptor.operationId, descriptor.kind, descriptor.name,
        descriptor.notes, descriptor.artifactId, context.at, actor);
    for (const member of descriptor.members) {
      context.connection.prepare(`INSERT INTO content_members
        (artifact_id, ordinal, stored_name, source_name, byte_count, sha256, media_type)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(descriptor.artifactId, member.ordinal, member.storedName,
          member.sourceName, member.byteCount, member.sha256, member.mediaType ?? null);
    }
    this.provenance.addClaimsInTransaction(context, descriptor.artifactId, descriptor.claims);
    this.lineage.addInputsInTransaction(context, descriptor.artifactId, descriptor.inputs);
    this.lineage.addGapsInTransaction(context, descriptor.artifactId, descriptor.gaps);
    if (descriptor.slotId) this.catalog.placeCandidateInTransaction(context, randomUUID(), descriptor.slotId,
      { artifactId: descriptor.artifactId });
    context.connection.prepare('INSERT INTO capture_receipts(operation_id, artifact_id, fingerprint, recorded_at) VALUES (?, ?, ?, ?)')
      .run(descriptor.operationId, descriptor.artifactId, descriptor.fingerprint, context.at);
  }
  private committed(descriptor: CaptureDescriptor, actor: string): CaptureReceipt {
    this.database.mutate({ actor, targetType: 'capture', targetId: descriptor.artifactId }, context => {
      this.register(context, descriptor, actor);
      return { before: null, after: { artifactId: descriptor.artifactId, operationId: descriptor.operationId,
        fingerprint: descriptor.fingerprint }, result: undefined };
    });
    return { status: 'committed', operationId: descriptor.operationId, artifactId: descriptor.artifactId,
      fingerprint: descriptor.fingerprint, receiptUrl: receiptUrl(descriptor.operationId) };
  }

  /** The metadata field must arrive before any file, and every ordered member must match its declaration. */
  async capture(request: FastifyRequest, actor: string): Promise<CaptureReceipt> {
    if (!request.isMultipart()) invalid('Use multipart/form-data with a metadata field first.');
    const signal = new AbortController();
    const abort = () => { if (!request.raw.complete) signal.abort(); };
    request.raw.once('aborted', abort);
    request.raw.once('close', abort);
    const deadline = setTimeout(() => {
      signal.abort();
      request.raw.destroy(new Error('Capture transfer timed out.'));
    }, captureLimits.transferMs);
    let stage: CaptureStage | undefined;
    let operation: string | undefined;
    let claimed = false;
    try {
      const iterator = request.parts({ limits: {
        fields: 1, files: captureLimits.members, parts: captureLimits.members + 1,
        fileSize: captureLimits.memberBytes, fieldSize: captureLimits.metadataBytes,
        fieldNameSize: 64, headerPairs: 32,
      } });
      const first = await iterator.next();
      if (first.done || first.value.type !== 'field' || first.value.fieldname !== 'metadata' ||
          first.value.fieldnameTruncated || first.value.valueTruncated || typeof first.value.value !== 'string' ||
          Buffer.byteLength(first.value.value, 'utf8') > captureLimits.metadataBytes) invalid('A complete metadata field must come first.');
      let metadataValue: unknown;
      try { metadataValue = JSON.parse(first.value.value); }
      catch { return invalid('Capture metadata must be valid JSON.'); }
      const parsed = captureMetadata.safeParse(metadataValue);
      if (!parsed.success) invalid('Capture metadata is invalid: ' + parsed.error.issues.map(issue => issue.path.join('.')).join(', '));
      const metadata: CaptureMetadata = parsed.data;
      operation = metadata.operationId;
      if (this.active.has(operation)) return { status: 'in-progress', operationId: operation, receiptUrl: receiptUrl(operation) };
      this.active.add(operation);
      claimed = true;
      const existing = await this.receiptWhileActive(operation);
      if (existing?.status === 'unavailable') unavailable();
      const artifactId = existing ? existing.artifactId : randomUUID();
      if (!existing) stage = await this.content.prepare(artifactId, operation);
      const members: StoredMember[] = [];
      let aggregate = 0;
      for (const [ordinal, declared] of metadata.members.entries()) {
        const next = await iterator.next();
        if (next.done) incomplete(`Missing ordered file part member${ordinal}.`);
        if (next.value.type !== 'file' || next.value.fieldname !== `member${ordinal}`) {
          invalid(`Expected the ordered file part member${ordinal}.`);
        }
        const member = await this.content.writeMember(stage ?? null, ordinal, declared, next.value.file, signal.signal);
        aggregate += member.byteCount;
        if (aggregate > captureLimits.aggregateBytes) invalid('Capture exceeds the aggregate content limit.');
        members.push(member);
      }
      if (!(await iterator.next()).done) invalid('Unexpected extra multipart part.');
      if (signal.signal.aborted || !request.raw.complete) throw new IncompleteContent('The capture transfer was interrupted.');
      const descriptor = makeDescriptor(metadata, artifactId, members);
      if (existing) {
        const preserved = await this.content.readDescriptor(existing.artifactId);
        if (descriptor.fingerprint !== preserved.fingerprint || existing.fingerprint &&
            descriptor.fingerprint !== existing.fingerprint) {
          throw new ConflictException({ code: 'CONFLICT', message: 'The operation already identifies different bytes or context.' });
        }
        try { await this.content.verifyDescriptor(preserved); }
        catch { unavailable(); }
        if (existing.status === 'committed') return existing;
        return this.committed(preserved, actor);
      }
      await this.content.finish(stage!, descriptor);
      await this.content.publish(stage!);
      stage = undefined; // Publication consumed the reservation; failed commits retain the published orphan.
      return this.committed(descriptor, actor);
    } catch (error) {
      if (error instanceof IncompleteContent) incomplete(error.message);
      if (error instanceof UnavailableContent) unavailable();
      if (signal.signal.aborted) incomplete('The capture transfer was interrupted or timed out.');
      if (error && typeof error === 'object' && 'statusCode' in error && (error.statusCode === 400 || error.statusCode === 413)) {
        invalid('Malformed, truncated, or oversized multipart content.');
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      request.raw.off('aborted', abort);
      request.raw.off('close', abort);
      if (stage) await this.content.release(stage);
      if (claimed) this.active.delete(operation!);
    }
  }
  private async receiptWhileActive(operation: string, knownReceipt?: ReceiptRow | null): Promise<
    | { status: 'committed'; artifactId: string; fingerprint: string; operationId: string; receiptUrl: string }
    | { status: 'orphan'; artifactId: string; fingerprint: null }
    | { status: 'unavailable'; artifactId: string } | undefined> {
    const row = knownReceipt === undefined
      ? this.database.connection.prepare('SELECT artifact_id AS artifactId, fingerprint FROM capture_receipts WHERE operation_id = ?')
        .get(operation) as ReceiptRow | undefined
      : knownReceipt;
    if (row) {
      const artifact = await this.getArtifact(row.artifactId);
      if (artifact.content === 'unavailable') return { status: 'unavailable', artifactId: row.artifactId };
      return { status: 'committed', artifactId: row.artifactId, fingerprint: row.fingerprint,
        operationId: operation, receiptUrl: receiptUrl(operation) };
    }
    const orphan = await this.orphan(operation);
    if (!orphan) return undefined;
    try { await this.content.verifyDescriptor(orphan); }
    catch { return { status: 'unavailable', artifactId: orphan.artifactId }; }
    return { status: 'orphan', artifactId: orphan.artifactId, fingerprint: null };
  }
}
