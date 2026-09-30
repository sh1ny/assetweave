import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { CatalogRepository } from '../../src/catalog/catalog.repository.js';
import { CatalogService } from '../../src/catalog/catalog.service.js';
import { DatabaseService } from '../../src/database/database.service.js';
import { LineageService } from '../../src/lineage/lineage.service.js';
import { ProvenanceService } from '../../src/provenance/provenance.service.js';
import { SearchService } from '../../src/queries/search.service.js';
import { RequestsService } from '../../src/requests/requests.service.js';
import { ProfileService } from '../../src/runtime/profile.service.js';

export interface TestStore {
  readonly root: string;
  readonly profilePath: string;
  readonly profile: ProfileService;
  readonly database: DatabaseService;
  readonly catalog: CatalogService;
  readonly requests: RequestsService;
  readonly provenance: ProvenanceService;
  readonly lineage: LineageService;
  readonly search: SearchService;
  reopen(): void;
}

export function createStore(t: TestContext): TestStore {
  assert.ok(process.env.LOCALAPPDATA, 'Windows tests require LOCALAPPDATA.');
  const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'AssetWeave-Catalog-Test-'));
  const profilePath = join(root, 'private');
  let profile: ProfileService | undefined;
  let database: DatabaseService | undefined;
  let catalog: CatalogService | undefined;
  let requests: RequestsService | undefined;
  let provenance: ProvenanceService | undefined;
  let lineage: LineageService | undefined;
  let search: SearchService | undefined;
  try {
    profile = ProfileService.open(profilePath);
    database = new DatabaseService(profile);
    catalog = new CatalogService(database, new CatalogRepository(database));
    requests = new RequestsService(database);
    provenance = new ProvenanceService(database);
    lineage = new LineageService(database);
    search = new SearchService(database);
  } catch (error) {
    database?.close();
    profile?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const store: TestStore = {
    root, profilePath,
    get profile() { return profile!; },
    get database() { return database!; },
    get catalog() { return catalog!; },
    get requests() { return requests!; },
    get provenance() { return provenance!; },
    get lineage() { return lineage!; },
    get search() { return search!; },
    reopen() {
      database?.close();
      profile?.close();
      profile = ProfileService.open(profilePath);
      database = new DatabaseService(profile);
      catalog = new CatalogService(database, new CatalogRepository(database));
      requests = new RequestsService(database);
      provenance = new ProvenanceService(database);
      lineage = new LineageService(database);
      search = new SearchService(database);
    },
  };
  t.after(() => {
    try {
      database?.close();
      profile?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return store;
}

// Complete one-pixel PNG, not a fabricated artifact row. Distinct captures
// always receive distinct content directories and operation receipts.
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9RyCYAAAAASUVORK5CYII=', 'base64');

export function createStoredArtifact(store: TestStore, assetId: string, options: {
  bytes?: Buffer;
  requestId?: string;
  kind?: string;
  sourceName?: string;
  at?: string;
} = {}): { artifactId: string; operationId: string; contentPath: string; digest: string } {
  const asset = store.catalog.getAsset(assetId);
  const artifactId = randomUUID();
  const operationId = randomUUID();
  const bytes = options.bytes ?? onePixelPng;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const contentDirectory = artifactId;
  const path = join(store.profile.path, 'artwork', contentDirectory);
  mkdirSync(path);
  const contentPath = join(path, '0000.png');
  const handle = openSync(contentPath, 'wx');
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  writeFileSync(join(path, 'manifest.json'), JSON.stringify({
    artifactId, operationId,
    members: [{ ordinal: 0, storedName: '0000.png', sourceName: options.sourceName ?? 'image.png', byteCount: bytes.length, sha256: digest }],
  }));
  store.database.mutate({ actor: 'fixture', targetType: 'artifact', targetId: artifactId, at: options.at }, ({ connection, at }) => {
    connection.prepare('INSERT INTO artifacts(id, project_id, asset_id, request_id, operation_id, kind, name, content_directory, captured_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(artifactId, asset.projectId, assetId, options.requestId ?? null, operationId, options.kind ?? 'png', options.sourceName ?? 'image.png', contentDirectory, at, 'fixture');
    connection.prepare('INSERT INTO content_members(artifact_id, ordinal, stored_name, source_name, byte_count, sha256, media_type) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(artifactId, 0, '0000.png', options.sourceName ?? 'image.png', bytes.length, digest, 'image/png');
    connection.prepare('INSERT INTO capture_receipts(operation_id, artifact_id, fingerprint, recorded_at) VALUES (?, ?, ?, ?)')
      .run(operationId, artifactId, digest, at);
    return { before: null, after: { artifactId, operationId, digest }, result: undefined };
  });
  return { artifactId, operationId, contentPath, digest };
}

export function createClipRevision(store: TestStore, artifactId: string, options: {
  clipId?: string;
  name?: string;
  sourceKind?: string;
} = {}): { clipId: string; revisionId: string } {
  const clipId = options.clipId ?? randomUUID();
  const revisionId = randomUUID();
  store.database.mutate({ actor: 'fixture', targetType: 'clip', targetId: clipId }, ({ connection, at, eventId }) => {
    const existing = connection.prepare('SELECT revision FROM clips WHERE id = ? AND artifact_id = ?').get(clipId, artifactId) as { revision: number } | undefined;
    const revision = (existing?.revision ?? 0) + 1;
    if (!existing) {
      connection.prepare('INSERT INTO clips(id, artifact_id, name, normalized_name, current_revision_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(clipId, artifactId, options.name ?? 'Idle', (options.name ?? 'Idle').toLowerCase(), revisionId, revision, at);
    }
    connection.prepare('INSERT INTO playback_revisions(id, clip_id, artifact_id, revision, geometry_json, frames_json, timing_json, source_kind, audit_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(revisionId, clipId, artifactId, revision, JSON.stringify({
        kind: 'grid', memberOrdinal: 0, cellWidth: 1, cellHeight: 1, columns: 1, rows: 1,
      }), '[0]', '[100]', options.sourceKind ?? 'human', eventId);
    if (existing) connection.prepare('UPDATE clips SET current_revision_id = ?, revision = ? WHERE id = ?').run(revisionId, revision, clipId);
    return { before: existing ?? null, after: { clipId, artifactId, revisionId, revision }, result: undefined };
  });
  return { clipId, revisionId };
}
