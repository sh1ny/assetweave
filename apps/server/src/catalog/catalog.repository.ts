import { Injectable } from '@nestjs/common';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectRecord, AssetRecord, SlotRecord, CandidateRecord } from '@assetweave/contracts/catalog';
import { DatabaseService } from '../database/database.service.js';

export interface CatalogHistoryEntry {
  revision: number;
  actor: string;
  at: string;
  before: unknown;
  after: unknown;
  authorityId: string | null;
  rationale: string | null;
}

const projectColumns = 'id, name, notes, revision, created_at AS createdAt, updated_at AS updatedAt';
const assetColumns = 'id, project_id AS projectId, name, notes, stage, revision, created_at AS createdAt, updated_at AS updatedAt';
const slotColumns = 'id, asset_id AS assetId, name, normalized_name AS normalizedName, notes, selected_candidate_id AS selectedCandidateId, revision, created_at AS createdAt, updated_at AS updatedAt';
const candidateColumns = 'id, slot_id AS slotId, artifact_id AS artifactId, clip_id AS clipId, review_state AS reviewState, revision, placed_at AS placedAt';

@Injectable()
export class CatalogRepository {
  constructor(private readonly database: DatabaseService) {}

  getProject(id: string, connection = this.database.connection): ProjectRecord | undefined {
    return connection.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(id) as ProjectRecord | undefined;
  }
  listProjects(after: readonly string[] | null, count: number): ProjectRecord[] {
    return this.database.connection.prepare(`SELECT ${projectColumns} FROM projects
      WHERE (? IS NULL OR (name, id) > (?, ?)) ORDER BY name, id LIMIT ?`)
      .all(after?.[0] ?? null, after?.[0] ?? '', after?.[1] ?? '', count) as unknown as ProjectRecord[];
  }
  insertProject(connection: DatabaseSync, record: ProjectRecord, eventId: number): void {
    connection.prepare('INSERT INTO projects(id, name, notes, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.name, record.notes, record.revision, record.createdAt, record.updatedAt);
    this.recordProjectRevision(connection, record, eventId);
  }
  updateProject(connection: DatabaseSync, record: ProjectRecord, eventId: number): void {
    connection.prepare('UPDATE projects SET name = ?, notes = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(record.name, record.notes, record.revision, record.updatedAt, record.id);
    this.recordProjectRevision(connection, record, eventId);
  }
  private recordProjectRevision(connection: DatabaseSync, record: ProjectRecord, eventId: number): void {
    connection.prepare('INSERT INTO project_revisions(project_id, revision, name, notes, audit_event_id) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.revision, record.name, record.notes, eventId);
  }

  getAsset(id: string, connection = this.database.connection): AssetRecord | undefined {
    return connection.prepare(`SELECT ${assetColumns} FROM assets WHERE id = ?`).get(id) as AssetRecord | undefined;
  }
  listAssets(projectId: string | undefined, after: readonly string[] | null, count: number): AssetRecord[] {
    return this.database.connection.prepare(`SELECT ${assetColumns} FROM assets
      WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR (name, id) > (?, ?))
      ORDER BY name, id LIMIT ?`)
      .all(projectId ?? null, projectId ?? null, after?.[0] ?? null, after?.[0] ?? '', after?.[1] ?? '', count) as unknown as AssetRecord[];
  }
  insertAsset(connection: DatabaseSync, record: AssetRecord, eventId: number): void {
    connection.prepare('INSERT INTO assets(id, project_id, name, notes, stage, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.projectId, record.name, record.notes, record.stage, record.revision, record.createdAt, record.updatedAt);
    this.recordAssetRevision(connection, record, eventId);
  }
  updateAsset(connection: DatabaseSync, record: AssetRecord, eventId: number): void {
    connection.prepare('UPDATE assets SET name = ?, notes = ?, stage = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(record.name, record.notes, record.stage, record.revision, record.updatedAt, record.id);
    this.recordAssetRevision(connection, record, eventId);
  }
  private recordAssetRevision(connection: DatabaseSync, record: AssetRecord, eventId: number): void {
    connection.prepare('INSERT INTO asset_revisions(asset_id, revision, name, notes, stage, audit_event_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.id, record.revision, record.name, record.notes, record.stage, eventId);
  }

  getSlot(id: string, connection = this.database.connection): SlotRecord | undefined {
    return connection.prepare(`SELECT ${slotColumns} FROM slots WHERE id = ?`).get(id) as SlotRecord | undefined;
  }
  listSlots(assetId: string, after: readonly string[] | null, count: number): SlotRecord[] {
    return this.database.connection.prepare(`SELECT ${slotColumns} FROM slots
      WHERE asset_id = ? AND (? IS NULL OR (name, id) > (?, ?)) ORDER BY name, id LIMIT ?`)
      .all(assetId, after?.[0] ?? null, after?.[0] ?? '', after?.[1] ?? '', count) as unknown as SlotRecord[];
  }
  getSlotByNormalizedName(assetId: string, normalizedName: string, connection = this.database.connection): SlotRecord | undefined {
    return connection.prepare(`SELECT ${slotColumns} FROM slots WHERE asset_id = ? AND normalized_name = ?`)
      .get(assetId, normalizedName) as SlotRecord | undefined;
  }
  insertSlot(connection: DatabaseSync, record: SlotRecord, eventId: number): void {
    connection.prepare('INSERT INTO slots(id, asset_id, name, normalized_name, notes, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.assetId, record.name, record.normalizedName, record.notes, record.revision, record.createdAt, record.updatedAt);
    this.recordSlotRevision(connection, record, eventId);
  }
  updateSlot(connection: DatabaseSync, record: SlotRecord, eventId: number): void {
    connection.prepare('UPDATE slots SET name = ?, normalized_name = ?, notes = ?, selected_candidate_id = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(record.name, record.normalizedName, record.notes, record.selectedCandidateId, record.revision, record.updatedAt, record.id);
    this.recordSlotRevision(connection, record, eventId);
  }
  private recordSlotRevision(connection: DatabaseSync, record: SlotRecord, eventId: number): void {
    connection.prepare('INSERT INTO slot_revisions(slot_id, revision, name, normalized_name, notes, selected_candidate_id, audit_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.revision, record.name, record.normalizedName, record.notes, record.selectedCandidateId, eventId);
  }

  getCandidate(id: string, connection = this.database.connection): CandidateRecord | undefined {
    return connection.prepare(`SELECT ${candidateColumns} FROM candidates WHERE id = ?`).get(id) as CandidateRecord | undefined;
  }
  listCandidates(slotId: string, after: readonly string[] | null, count: number): CandidateRecord[] {
    return this.database.connection.prepare(`SELECT ${candidateColumns} FROM candidates
      WHERE slot_id = ? AND (? IS NULL OR (placed_at, id) > (?, ?)) ORDER BY placed_at, id LIMIT ?`)
      .all(slotId, after?.[0] ?? null, after?.[0] ?? '', after?.[1] ?? '', count) as unknown as CandidateRecord[];
  }
  findCandidate(slotId: string, artifactId: string, clipId: string | null, connection = this.database.connection): CandidateRecord | undefined {
    return connection.prepare(`SELECT ${candidateColumns} FROM candidates WHERE slot_id = ? AND artifact_id = ? AND clip_id IS ?`)
      .get(slotId, artifactId, clipId) as CandidateRecord | undefined;
  }
  insertCandidate(connection: DatabaseSync, record: CandidateRecord): void {
    connection.prepare('INSERT INTO candidates(id, slot_id, artifact_id, clip_id, review_state, revision, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.slotId, record.artifactId, record.clipId, record.reviewState, record.revision, record.placedAt);
  }
  updateCandidate(connection: DatabaseSync, record: CandidateRecord): void {
    connection.prepare('UPDATE candidates SET review_state = ?, revision = ? WHERE id = ?')
      .run(record.reviewState, record.revision, record.id);
  }

  projectHistory(id: string, after: readonly string[] | null, count: number): CatalogHistoryEntry[] {
    return this.history('project_revisions', 'project_id', id, after, count);
  }
  assetHistory(id: string, after: readonly string[] | null, count: number): CatalogHistoryEntry[] {
    return this.history('asset_revisions', 'asset_id', id, after, count);
  }
  slotHistory(id: string, after: readonly string[] | null, count: number): CatalogHistoryEntry[] {
    return this.history('slot_revisions', 'slot_id', id, after, count);
  }

  private history(table: 'project_revisions' | 'asset_revisions' | 'slot_revisions',
    key: 'project_id' | 'asset_id' | 'slot_id', id: string, after: readonly string[] | null, count: number): CatalogHistoryEntry[] {
    const rows = this.database.connection.prepare(`SELECT revision, actor, recorded_at AS at, before_json AS beforeJson, after_json AS afterJson, authority_id AS authorityId, rationale FROM ${table} JOIN audit_events ON audit_events.id = ${table}.audit_event_id WHERE ${table}.${key} = ? AND revision > ? ORDER BY revision LIMIT ?`)
      .all(id, Number(after?.[0] ?? 0), count) as { revision: number; actor: string; at: string; beforeJson: string; afterJson: string; authorityId: string | null; rationale: string | null }[];
    return rows.map(row => ({ revision: row.revision, actor: row.actor, at: row.at,
      before: JSON.parse(row.beforeJson) as unknown, after: JSON.parse(row.afterJson) as unknown,
      authorityId: row.authorityId, rationale: row.rationale }));
  }
}
