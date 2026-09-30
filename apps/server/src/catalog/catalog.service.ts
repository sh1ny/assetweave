import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeSlotName,
  type ProjectRecord, type AssetRecord, type SlotRecord, type CandidateRecord,
  type CreateProjectInput, type UpdateProjectInput, type CreateAssetInput, type UpdateAssetInput,
  type CreateSlotInput, type UpdateSlotInput, type PlaceCandidateInput,
} from '@assetweave/contracts/catalog';
import { DatabaseService, type MutationContext } from '../database/database.service.js';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { paginate } from '../queries/pagination.js';
import { CatalogRepository, type CatalogHistoryEntry } from './catalog.repository.js';

export class CatalogConflict extends Error {
  constructor(readonly current: unknown, message: string) { super(message); }
}

function required<T>(record: T | undefined, kind: string): T {
  if (!record) throw new NotFoundException({ code: 'NOT_FOUND', message: `${kind} was not found.` });
  return record;
}

@Injectable()
export class CatalogService {
  constructor(private readonly database: DatabaseService, private readonly catalog: CatalogRepository) {}

  listProjects(input: PageInput): QueryPage<ProjectRecord> {
    return paginate(this.database, input, ['projects'], (after, count) => this.catalog.listProjects(after, count),
      row => [row.name, row.id]);
  }
  getProject(id: string): ProjectRecord { return required(this.catalog.getProject(id), 'Project'); }
  projectHistory(id: string, input: PageInput): QueryPage<CatalogHistoryEntry> {
    this.getProject(id);
    return paginate(this.database, input, ['projects', id, 'history'],
      (after, count) => this.catalog.projectHistory(id, after, count), row => [String(row.revision)]);
  }
  createProject(input: CreateProjectInput, actor: string): ProjectRecord {
    const id = randomUUID();
    return this.database.mutate({ actor, targetType: 'project', targetId: id }, context => {
      const record: ProjectRecord = { id, name: input.name, notes: input.notes ?? '', revision: 1,
        createdAt: context.at, updatedAt: context.at };
      this.catalog.insertProject(context.connection, record, context.eventId);
      return { before: null, after: record, result: record };
    });
  }
  updateProject(id: string, input: UpdateProjectInput, actor: string): ProjectRecord {
    return this.database.mutate({ actor, targetType: 'project', targetId: id,
      expected: [{ expectedRevision: input.expectedRevision, readCurrent: connection => this.catalog.getProject(id, connection) }],
    }, context => {
      const before = required(this.catalog.getProject(id, context.connection), 'Project');
      const after: ProjectRecord = { ...before, name: input.name ?? before.name,
        notes: input.notes ?? before.notes, revision: before.revision + 1, updatedAt: context.at };
      this.catalog.updateProject(context.connection, after, context.eventId);
      return { before, after, result: after };
    });
  }

  listAssets(input: PageInput, projectId?: string): QueryPage<AssetRecord> {
    if (projectId) this.getProject(projectId);
    return paginate(this.database, input, ['assets', projectId ?? null],
      (after, count) => this.catalog.listAssets(projectId, after, count), row => [row.name, row.id]);
  }
  getAsset(id: string): AssetRecord { return required(this.catalog.getAsset(id), 'Asset'); }
  assetHistory(id: string, input: PageInput): QueryPage<CatalogHistoryEntry> {
    this.getAsset(id);
    return paginate(this.database, input, ['assets', id, 'history'],
      (after, count) => this.catalog.assetHistory(id, after, count), row => [String(row.revision)]);
  }
  createAsset(projectId: string, input: CreateAssetInput, actor: string): AssetRecord {
    this.getProject(projectId);
    const id = randomUUID();
    return this.database.mutate({ actor, targetType: 'asset', targetId: id }, context => {
      const record: AssetRecord = { id, projectId, name: input.name, notes: input.notes ?? '', stage: null,
        revision: 1, createdAt: context.at, updatedAt: context.at };
      this.catalog.insertAsset(context.connection, record, context.eventId);
      return { before: null, after: record, result: record };
    });
  }
  updateAsset(id: string, input: UpdateAssetInput, actor: string): AssetRecord {
    return this.database.mutate({ actor, targetType: 'asset', targetId: id,
      expected: [{ expectedRevision: input.expectedRevision, readCurrent: connection => this.catalog.getAsset(id, connection) }],
    }, context => {
      const before = required(this.catalog.getAsset(id, context.connection), 'Asset');
      const after: AssetRecord = { ...before, name: input.name ?? before.name,
        notes: input.notes ?? before.notes, revision: before.revision + 1, updatedAt: context.at };
      this.catalog.updateAsset(context.connection, after, context.eventId);
      return { before, after, result: after };
    });
  }

  listSlots(assetId: string, input: PageInput): QueryPage<SlotRecord> {
    this.getAsset(assetId);
    return paginate(this.database, input, ['assets', assetId, 'slots'],
      (after, count) => this.catalog.listSlots(assetId, after, count), row => [row.name, row.id]);
  }
  getSlot(id: string): SlotRecord { return required(this.catalog.getSlot(id), 'Slot'); }
  slotHistory(id: string, input: PageInput): QueryPage<CatalogHistoryEntry> {
    this.getSlot(id);
    return paginate(this.database, input, ['slots', id, 'history'],
      (after, count) => this.catalog.slotHistory(id, after, count), row => [String(row.revision)]);
  }
  createSlot(assetId: string, input: CreateSlotInput, actor: string): SlotRecord {
    this.getAsset(assetId);
    const id = randomUUID();
    const normalizedName = normalizeSlotName(input.name);
    return this.database.mutate({ actor, targetType: 'slot', targetId: id }, context => {
      const duplicate = this.catalog.getSlotByNormalizedName(assetId, normalizedName, context.connection);
      if (duplicate) throw new CatalogConflict(duplicate, 'This asset already has a slot with the same normalized name.');
      const record: SlotRecord = { id, assetId, name: input.name, normalizedName,
        notes: input.notes ?? '', selectedCandidateId: null, revision: 1,
        createdAt: context.at, updatedAt: context.at };
      this.catalog.insertSlot(context.connection, record, context.eventId);
      return { before: null, after: record, result: record };
    });
  }
  updateSlot(id: string, input: UpdateSlotInput, actor: string): SlotRecord {
    return this.database.mutate({ actor, targetType: 'slot', targetId: id,
      expected: [{ expectedRevision: input.expectedRevision, readCurrent: connection => this.catalog.getSlot(id, connection) }],
    }, context => {
      const before = required(this.catalog.getSlot(id, context.connection), 'Slot');
      const normalizedName = input.name === undefined ? before.normalizedName : normalizeSlotName(input.name);
      const duplicate = this.catalog.getSlotByNormalizedName(before.assetId, normalizedName, context.connection);
      if (duplicate && duplicate.id !== id) throw new CatalogConflict(duplicate, 'This asset already has a slot with the same normalized name.');
      const after: SlotRecord = { ...before, name: input.name ?? before.name,
        normalizedName, notes: input.notes ?? before.notes, revision: before.revision + 1, updatedAt: context.at };
      this.catalog.updateSlot(context.connection, after, context.eventId);
      return { before, after, result: after };
    });
  }

  listCandidates(slotId: string, input: PageInput): QueryPage<CandidateRecord> {
    this.getSlot(slotId);
    return paginate(this.database, input, ['slots', slotId, 'candidates'],
      (after, count) => this.catalog.listCandidates(slotId, after, count), row => [row.placedAt, row.id]);
  }
  getCandidate(id: string): CandidateRecord { return required(this.catalog.getCandidate(id), 'Candidate'); }
  placeCandidate(slotId: string, input: PlaceCandidateInput, actor: string): CandidateRecord {
    this.getSlot(slotId);
    const id = randomUUID();
    return this.database.mutate({ actor, targetType: 'candidate', targetId: id }, context => {
      const record = this.placeCandidateInTransaction(context, id, slotId, input);
      return { before: null, after: record, result: record };
    });
  }

  /** Capture joins a slot placement to the same receipt transaction. */
  placeCandidateInTransaction(context: MutationContext, id: string, slotId: string, input: PlaceCandidateInput): CandidateRecord {
    const slot = context.connection.prepare('SELECT id FROM slots WHERE id = ?').get(slotId);
    if (!slot) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Slot was not found.' });
    const artifact = context.connection.prepare('SELECT id FROM artifacts WHERE id = ?').get(input.artifactId);
    if (!artifact) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Artifact was not found.' });
    if (input.clipId && !this.clipBelongsToArtifact(context.connection, input.clipId, input.artifactId)) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'The clip does not belong to the specified artifact.' });
    }
    const duplicate = this.catalog.findCandidate(slotId, input.artifactId, input.clipId ?? null, context.connection);
    if (duplicate) throw new CatalogConflict(duplicate, 'This target is already a candidate in this slot.');
    const record: CandidateRecord = { id, slotId, artifactId: input.artifactId, clipId: input.clipId ?? null,
      reviewState: 'unreviewed', revision: 1, placedAt: context.at };
    this.catalog.insertCandidate(context.connection, record);
    return record;
  }

  private clipBelongsToArtifact(connection: DatabaseSync, clipId: string, artifactId: string): boolean {
    return connection.prepare('SELECT 1 FROM clips WHERE id = ? AND artifact_id = ?').get(clipId, artifactId) !== undefined;
  }
}
