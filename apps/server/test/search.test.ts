import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, DatabaseService } from '../src/database/database.service.js';
import { SearchService } from '../src/queries/search.service.js';
import { ProfileService } from '../src/runtime/profile.service.js';
import { lineageQuery } from '@assetweave/contracts/queries';
import type { QueryPage, SearchHit, TextHit, LineagePage } from '@assetweave/contracts/queries';
import type { CandidateRecord, SlotRecord } from '@assetweave/contracts/catalog';
import { createStore, createStoredArtifact } from './helpers/store-fixture.js';
import { auth, captureFixtures, mediaServer } from './helpers/media-fixture.js';

const skip = process.platform !== 'win32';
const instruction = 'The artist asked me to record this specific choice.';

async function get<T>(origin: string, bearer: string, path: string): Promise<T> {
  const response = await fetch(origin + path, { headers: auth(bearer) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<T>;
}
async function change<T>(origin: string, bearer: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(origin + path, { method: 'PATCH',
    headers: { ...auth(bearer), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<T>;
}
function searchUrl(filters: object = {}, extra: Record<string, string> = {}): string {
  return '/api/queries/search?' + new URLSearchParams({ filters: JSON.stringify(filters), ...extra }).toString();
}

// Every relationship here is a committed fact in an isolated private store; the
// query never reads fixture filenames to infer ownership, placement or lineage.
test('AE6/AE8: AND/OR facts, branches after reselection, explicit gaps and keyset continuation', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Actors', notes: 'Playable characters' }, 'human');
  const knight = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const sword = store.catalog.createAsset(project.id, { name: 'Sword' }, 'human');
  const otherProject = store.catalog.createProject({ name: 'Other' }, 'human');
  const otherAsset = store.catalog.createAsset(otherProject.id, { name: 'Knight' }, 'human');
  const concept = store.catalog.createSlot(knight.id, { name: 'Concept' }, 'human');
  const sprite = store.catalog.createSlot(knight.id, { name: 'Sprite' }, 'human');
  const at = '2026-09-01T10:00:00.000Z';
  const g003 = createStoredArtifact(store, knight.id, { at, sourceName: 'G003.png' }).artifactId;
  const g005 = createStoredArtifact(store, knight.id, { at, sourceName: 'G005.png' }).artifactId;
  const s004 = createStoredArtifact(store, knight.id, { at, sourceName: 'S004.png' }).artifactId;
  const w002 = createStoredArtifact(store, knight.id, { at, sourceName: 'W002.png' }).artifactId;
  const a006 = createStoredArtifact(store, knight.id, { at, sourceName: 'A006.png' }).artifactId;
  const borrowed = createStoredArtifact(store, sword.id, { sourceName: 'Older sword.png' }).artifactId;
  const elsewhere = createStoredArtifact(store, otherAsset.id).artifactId;
  const orphan = store.requests.createRequest(project.id, knight.id,
    { intent: 'Unfulfilled copper visor experiment' }, 'agent');
  store.lineage.addInputs(s004, [{ artifactId: g003, role: 'starting artwork' },
    { artifactId: borrowed, role: 'visual reference' }], 'human');
  store.lineage.addInputs(w002, [{ artifactId: s004 }], 'human');
  store.lineage.addInputs(a006, [{ artifactId: w002 }], 'human');
  store.lineage.addGaps(s004, [{ kind: 'upstream', description: 'Lost original ink sheet', sourceKind: 'human' }], 'human');
  store.provenance.addClaims(g003, [
    { field: 'producer', state: 'known', value: 'OpenAI', source: { kind: 'human' } },
    { field: 'productionTime', state: 'known', value: '2025-06-01T10:00:00.000Z', source: { kind: 'human' } },
  ], 'human');
  store.provenance.addClaims(g005, [{ field: 'productionTime', state: 'unknown', source: { kind: 'human' } }], 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    const place = async (slot: SlotRecord, artifactId: string): Promise<CandidateRecord> => {
      const response = await fetch(`${server.origin}/api/slots/${slot.id}/candidates`, {
        method: 'POST', headers: { ...auth(bearer), 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json() as Promise<CandidateRecord>;
    };
    const old = await place(concept, g003);
    const next = await place(concept, g005);
    const foreign = await place(concept, borrowed);
    const child = await place(sprite, s004);
    const oldSprite = await place(sprite, g003);
    const nextSprite = await place(sprite, g005);
    await change(server.origin, bearer, `/api/assets/${knight.id}/stage`,
      { expectedAssetRevision: 1, stage: 'Exploring', instruction });
    await change(server.origin, bearer, `/api/candidates/${old.id}/review`,
      { expectedCandidateRevision: 1, nextState: 'rejected', instruction });
    await change(server.origin, bearer, `/api/candidates/${child.id}/review`,
      { expectedCandidateRevision: 1, nextState: 'approved', instruction });
    await change(server.origin, bearer, `/api/candidates/${oldSprite.id}/review`,
      { expectedCandidateRevision: 1, nextState: 'approved', instruction });
    await change(server.origin, bearer, `/api/candidates/${nextSprite.id}/review`,
      { expectedCandidateRevision: 1, nextState: 'approved', instruction });
    await change(server.origin, bearer, `/api/slots/${concept.id}/selection`,
      { expectedSlotRevision: 1, nextCandidateId: old.id, expectedCandidateRevision: 2, instruction });
    await change(server.origin, bearer, `/api/slots/${concept.id}/selection`,
      { expectedSlotRevision: 2, nextCandidateId: next.id, expectedCandidateRevision: 1, instruction });
    const gif = await captureFixtures(server, bearer, project.id, knight.id, ['variable-disposal.gif'], { kind: 'gif' });
    const orphanHits = await get<QueryPage<TextHit>>(server.origin, bearer,
      '/api/queries/text?text=Unfulfilled%20copper%20visor%20experiment');
    assert.deepEqual(orphanHits.items.map(hit => [hit.type, hit.recordId, hit.recordUrl]),
      [['request', orphan.id, `/api/requests/${orphan.id}`]]);
    const ids = async (filters: object): Promise<Set<string>> => new Set((await get<QueryPage<SearchHit>>(
      server.origin, bearer, searchUrl(filters, { limit: '50' }))).items.map(hit => hit.artifactId));
    assert.deepEqual(await ids({ projectIds: [otherProject.id] }), new Set([elsewhere]));
    assert.deepEqual(await ids({ assetIds: [knight.id], slotIds: [concept.id] }), new Set([g003, g005]));
    assert.deepEqual(await ids({ slotIds: [concept.id], assetIds: [sword.id] }), new Set([borrowed]));
    assert.deepEqual(await ids({ assetIds: [knight.id], unslotted: true }), new Set([w002, a006, gif]));
    assert.deepEqual(await ids({ slotIds: [sprite.id], unslotted: true, assetIds: [knight.id] }),
      new Set([g003, g005, s004, w002, a006, gif]));
    assert.deepEqual(await ids({ slotIds: [sprite.id], reviews: ['rejected'] }), new Set(),
      'a rejection in Concept must not count as a rejection of its Sprite placement');
    assert.deepEqual(await ids({ slotIds: [sprite.id], selection: ['selected'] }), new Set(),
      'a Concept selection must not count as selection in Sprite');
    assert.deepEqual(await ids({ reviews: ['approved'], selection: ['selected'] }), new Set(),
      'review and selection must describe the same slot candidate');
    assert.deepEqual(await ids({ stages: ['Exploring'], kinds: ['gif'] }), new Set([gif]));
    assert.deepEqual(await ids({ stageNone: true, projectIds: [project.id] }), new Set([borrowed]));
    assert.deepEqual(await ids({ reviews: ['rejected'] }), new Set([g003]));
    assert.deepEqual(await ids({ reviews: ['approved'] }), new Set([g003, g005, s004]));
    assert.deepEqual(await ids({ selection: ['formerly-selected'] }), new Set([g003]));
    assert.deepEqual(await ids({ selection: ['selected'] }), new Set([g005]));
    assert.deepEqual(await ids({ producers: ['OpenAI'] }), new Set([g003]));
    assert.deepEqual(await ids({ captured: { from: at, through: at }, assetIds: [knight.id] }),
      new Set([g003, g005, s004, w002, a006]));
    assert.deepEqual(await ids({ produced: { from: '2025-01-01T00:00:00.000Z' } }), new Set([g003]));
    assert.deepEqual(await ids({ assetIds: [knight.id], unknownProductionDate: true }),
      new Set([g005, s004, w002, a006, gif]));
    assert.deepEqual(await ids({ ancestorOf: [a006] }), new Set([g003, borrowed, s004, w002]));
    assert.deepEqual(await ids({ descendantOf: [g003] }), new Set([s004, w002, a006]));
    assert.deepEqual(await ids({ assetIds: [knight.id], stages: ['Exploring'],
      reviews: ['rejected'], descendantOf: [borrowed] }), new Set());
    const first = await get<QueryPage<SearchHit>>(server.origin, bearer,
      searchUrl({ captured: { from: at, through: at } }, { limit: '2' }));
    const seen = new Set<string>();
    let page = first;
    do {
      for (const hit of page.items) assert.equal(seen.has(hit.artifactId), false, 'no duplicate at equal timestamps');
      for (const hit of page.items) seen.add(hit.artifactId);
      if (!page.nextCursor) break;
      page = await get(server.origin, bearer, searchUrl({ captured: { from: at, through: at } },
        { limit: '2', cursor: page.nextCursor }));
    } while (true);
    assert.deepEqual(seen, new Set([g003, g005, s004, w002, a006]));
    const mismatch = await fetch(`${server.origin}${searchUrl({ stages: ['Exploring'] },
      { limit: '2', cursor: first.nextCursor! })}`, { headers: auth(bearer) });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json() as { code: string }).code, 'CONFLICT');
    const tree = await get<LineagePage>(server.origin, bearer,
      `/api/queries/lineage/${g003}?direction=dependents&limit=2`);
    const found = new Set(tree.items.map(item => item.artifactId));
    let cursor = tree.nextCursor;
    while (cursor) {
      const nextPage = await get<LineagePage>(server.origin, bearer,
        `/api/queries/lineage/${g003}?direction=dependents&limit=2&cursor=${encodeURIComponent(cursor)}`);
      nextPage.items.forEach(item => found.add(item.artifactId));
      cursor = nextPage.nextCursor;
    }
    assert.deepEqual(found, new Set([g003, s004, w002, a006]));
    const gapPage = await get<LineagePage>(server.origin, bearer,
      `/api/queries/lineage/${s004}?direction=inputs&limit=1`);
    assert.equal(gapPage.encounteredGaps[0]?.description, 'Lost original ink sheet');
    const missing = await fetch(`${server.origin}/api/queries/lineage/${g003}?direction=inputs&limit=1&cursor=${encodeURIComponent(tree.nextCursor!)}`,
      { headers: auth(bearer) });
    assert.equal(missing.status, 409, 'continuation binds direction');
    const newProject = await fetch(`${server.origin}/api/projects`, { method: 'POST',
      headers: { ...auth(bearer), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'More' }) });
    assert.equal(newProject.status, 201);
    const stale = await fetch(`${server.origin}${searchUrl({ captured: { from: at, through: at } },
      { limit: '2', cursor: first.nextCursor! })}`, { headers: auth(bearer) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, 'CONFLICT');
    assert.equal(foreign.artifactId, borrowed);
  } finally { await server.close(); }
});

test('R36: a wide lineage branch pages every input and explicit gap without hiding the frontier', { skip }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Wide branch' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Background' }, 'human');
  const output = createStoredArtifact(store, asset.id).artifactId;
  const sources = Array.from({ length: 52 }, () => createStoredArtifact(store, asset.id).artifactId);
  const edges = store.lineage.addInputs(output,
    sources.map((artifactId, index) => ({ artifactId, role: `source layer ${index}` })), 'human');
  const gaps = store.lineage.addGaps(output,
    Array.from({ length: 52 }, (_, index) => ({
      kind: 'upstream' as const, description: `Unrecorded source ${index}`, sourceKind: 'human',
    })), 'human');
  const links = new Set<string>();
  const foundGaps = new Set<string>();
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = store.search.traverse(output, { direction: 'inputs', limit: 5,
      ...(cursor ? { cursor } : {}) });
    assert.ok(page.items.length <= 5);
    for (const step of page.items) {
      visited.add(step.artifactId);
      for (const link of step.links) {
        assert.equal(links.has(link.id), false, 'no repeated edge when expanding a wide node');
        links.add(link.id);
      }
      for (const gap of step.gaps) {
        assert.equal(foundGaps.has(gap.id), false, 'no repeated gap when expanding a wide node');
        foundGaps.add(gap.id);
      }
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor) assert.ok(page.frontier.length > 0);
  } while (cursor);
  assert.deepEqual(links, new Set(edges.map(edge => edge.edgeId)));
  assert.deepEqual(foundGaps, new Set(gaps.map(gap => gap.gapId)));
  assert.deepEqual(visited, new Set([output, ...sources]));
});

test('R36: signed lineage continuation exhausts a legal 500+ ancestor branch', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Large lineage' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Sources' }, 'human');
  const origin = createStoredArtifact(store, asset.id).artifactId;
  const branches = Array.from({ length: 4 }, () => createStoredArtifact(store, asset.id).artifactId);
  const ancestors = Array.from({ length: 512 }, () => createStoredArtifact(store, asset.id).artifactId);
  const rootEdges = store.lineage.addInputs(origin, branches.map(artifactId => ({ artifactId })), 'human');
  const branchEdges = branches.flatMap((branch, index) =>
    store.lineage.addInputs(branch,
      ancestors.slice(index * 128, (index + 1) * 128).map((artifactId, sourceIndex) =>
        ({ artifactId: index === 3 && sourceIndex === 127 ? ancestors[0]! : artifactId })), 'human'));
  const expectedArtifacts = new Set([origin, ...branches, ...ancestors.slice(0, -1)]);
  const expectedEdges = new Set([...rootEdges, ...branchEdges].map(row => row.edgeId));
  const { server, bearer } = await mediaServer(store);
  try {
    const path = `/api/queries/lineage/${origin}?direction=inputs&limit=20`;
    const first = await get<LineagePage>(server.origin, bearer, path);
    assert.deepEqual(await get<LineagePage>(server.origin, bearer, path), first,
      'a stable catalog must replay the same breadth-first order');
    const visited = new Set<string>();
    const links = new Set<string>();
    let page = first;
    let pages = 0;
    do {
      assert.ok(page.items.length > 0 && page.items.length <= 20);
      assert.ok(page.visitedCount <= expectedArtifacts.size);
      for (const step of page.items) {
        visited.add(step.artifactId);
        for (const link of step.links) {
          assert.equal(links.has(link.id), false, 'every edge is emitted once despite shared ancestors');
          links.add(link.id);
        }
      }
      pages++;
      if (!page.nextCursor) break;
      assert.ok(page.frontierCount > 0);
      assert.ok(page.nextCursor.length <= 65_536, 'continuation must fit the public query contract');
      assert.equal(lineageQuery.safeParse({ direction: 'inputs', limit: 20, cursor: page.nextCursor }).success, true);
      page = await get<LineagePage>(server.origin, bearer,
        `${path}&cursor=${encodeURIComponent(page.nextCursor)}`);
    } while (true);
    assert.ok(pages > 20);
    assert.deepEqual(visited, expectedArtifacts);
    assert.deepEqual(links, expectedEdges);
    assert.equal(page.visitedCount, expectedArtifacts.size);
    assert.equal(page.nextCursor, null);
  } finally { await server.close(); }
});

test('R23: transactional FTS current/history nested values, rollback and exact revision link', { skip }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Ledger', notes: 'Notebook terminology' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const artifactId = createStoredArtifact(store, asset.id).artifactId;
  const [prompt, params] = store.provenance.addClaims(artifactId, [
    { field: 'prompt', state: 'known', value: 'obsolete blue plume', source: { kind: 'human' } },
    { field: 'parameters', state: 'known', value: { sampler: { label: 'precise dithering' } }, source: { kind: 'producer' } },
  ], 'human');
  assert.ok(prompt && params);
  const revised = store.provenance.correctAssertion(prompt.assertionId, { expectedRevision: 1,
    claim: { field: 'prompt', state: 'known', value: 'corrected scarlet plume', source: { kind: 'human' } } }, 'human');
  assert.equal(store.search.search({ limit: 20, filters: {}, scope: 'current', text: 'obsolete blue plume' }).items.length, 0);
  assert.equal(store.search.search({ limit: 20, filters: {}, scope: 'current', text: 'precise dithering' }).items[0]?.artifactId, artifactId);
  const historical = store.search.search({ limit: 20, filters: {}, scope: 'history', text: 'obsolete blue plume' });
  assert.equal(store.search.searchText({ limit: 20, scope: 'history', text: 'obsolete blue plume' })
    .items[0]?.revisionId, prompt.id);
  assert.equal(historical.items[0]?.matchedRevision?.revisionId, prompt.id);
  assert.equal(store.search.getRevision('claim', prompt.id).current, false);
  assert.equal(store.search.getRevision('claim', revised.id).current, true);
  assert.equal(store.search.search({ limit: 20, filters: {}, scope: 'current', text: 'corrected scarlet plume' }).items[0]?.artifactId, artifactId);
  const watermark = store.database.watermark;
  store.database.addProjection(() => { throw new Error('projection failure'); });
  assert.throws(() => store.catalog.updateProject(project.id,
    { expectedRevision: 1, name: 'Ghostly term' }, 'human'), /projection failure/);
  assert.equal(store.database.watermark, watermark);
  store.reopen();
  assert.equal(store.catalog.getProject(project.id).name, 'Ledger');
  assert.equal(store.search.search({ limit: 20, filters: {}, scope: 'current', text: 'Ghostly term' }).items.length, 0);
});

test('R23: schema-3 profile upgrades and backfills current, superseded and nested text', { skip }, t => {
  assert.ok(process.env.LOCALAPPDATA, 'Windows tests require LOCALAPPDATA.');
  const root = mkdtempSync(join(process.env.LOCALAPPDATA, 'AssetWeave-Upgrade-Test-'));
  const profilePath = join(root, 'private');
  let profile: ProfileService | undefined;
  let database: DatabaseService | undefined;
  t.after(() => {
    try {
      database?.close();
      profile?.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  profile = ProfileService.open(profilePath);
  const old = new DatabaseSync(join(profile.path, 'catalog.sqlite'), {
    allowExtension: false, enableForeignKeyConstraints: true,
  });
  const projectId = randomUUID();
  const assetId = randomUUID();
  const artifactId = randomUUID();
  const operationId = randomUUID();
  const promptId = randomUUID();
  const original = randomUUID();
  const corrected = randomUUID();
  const parametersId = randomUUID();
  const parametersRevision = randomUUID();
  const at = '2026-09-29T00:00:00.000Z';
  try {
    old.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
    // Start from the actual released schema, with no 004 object ever created.
    const migrations = ['001-domain.sql', '002-domain-integrity.sql', '003-decisions.sql']
      .map((filename, index) => ({
        version: index + 1,
        sql: readFileSync(new URL(`../src/database/migrations/${filename}`, import.meta.url), 'utf8'),
      }));
    applyMigrations(old, migrations);
    assert.equal((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);

    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9RyCYAAAAASUVORK5CYII=', 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const artworkPath = join(profile.path, 'artwork', artifactId);
    mkdirSync(artworkPath);
    writeFileSync(join(artworkPath, '0000.png'), bytes);

    old.exec('BEGIN IMMEDIATE');
    try {
      const event = old.prepare(`INSERT INTO audit_events
        (id, actor, recorded_at, target_type, target_id, before_json, after_json)
        VALUES (?, 'human', ?, ?, ?, 'null', '{}')`);
      for (const [id, type, target] of [
        [1, 'project', projectId], [2, 'asset', assetId], [3, 'capture', artifactId],
        [4, 'claim', promptId], [5, 'claim', promptId], [6, 'claim', parametersId],
      ] as const) event.run(id, at, type, target);
      old.prepare('UPDATE mutation_clock SET watermark = 6 WHERE id = 1').run();
      old.prepare(`INSERT INTO projects(id, name, notes, created_at, updated_at)
        VALUES (?, 'Ledger', 'Notebook terminology', ?, ?)`).run(projectId, at, at);
      old.prepare(`INSERT INTO project_revisions(project_id, revision, name, notes, audit_event_id)
        VALUES (?, 1, 'Ledger', 'Notebook terminology', 1)`).run(projectId);
      old.prepare(`INSERT INTO assets(id, project_id, name, created_at, updated_at)
        VALUES (?, ?, 'Knight', ?, ?)`).run(assetId, projectId, at, at);
      old.prepare(`INSERT INTO asset_revisions(asset_id, revision, name, notes, stage, audit_event_id)
        VALUES (?, 1, 'Knight', '', NULL, 2)`).run(assetId);
      old.prepare(`INSERT INTO artifacts
        (id, project_id, asset_id, operation_id, kind, name, content_directory, captured_at, recorded_by)
        VALUES (?, ?, ?, ?, 'image', 'Knight sheet', ?, ?, 'human')`)
        .run(artifactId, projectId, assetId, operationId, artifactId, at);
      old.prepare(`INSERT INTO content_members
        (artifact_id, ordinal, stored_name, source_name, byte_count, sha256, media_type)
        VALUES (?, 0, '0000.png', 'knight.png', ?, ?, 'image/png')`).run(artifactId, bytes.length, digest);
      old.prepare(`INSERT INTO capture_receipts(operation_id, artifact_id, fingerprint, recorded_at)
        VALUES (?, ?, ?, ?)`).run(operationId, artifactId, digest, at);
      old.prepare(`INSERT INTO provenance_assertions
        (id, artifact_id, field, current_revision_id, revision)
        VALUES (?, ?, 'prompt', ?, 2)`).run(promptId, artifactId, corrected);
      old.prepare(`INSERT INTO provenance_assertions
        (id, artifact_id, field, current_revision_id, revision)
        VALUES (?, ?, 'parameters', ?, 1)`).run(parametersId, artifactId, parametersRevision);
      const revision = old.prepare(`INSERT INTO provenance_revisions
        (id, assertion_id, artifact_id, revision, state, value_json, source_kind, audit_event_id)
        VALUES (?, ?, ?, ?, 'known', ?, ?, ?)`);
      revision.run(original, promptId, artifactId, 1, JSON.stringify('obsolete blue plume'), 'human', 4);
      revision.run(corrected, promptId, artifactId, 2, JSON.stringify('corrected scarlet plume'), 'human', 5);
      revision.run(parametersRevision, parametersId, artifactId, 1,
        JSON.stringify({ sampler: { label: 'precise dithering' } }), 'producer', 6);
      old.exec('COMMIT');
    } catch (error) {
      old.exec('ROLLBACK');
      throw error;
    }
  } finally {
    old.close();
  }

  profile.close();
  profile = ProfileService.open(profilePath);
  database = new DatabaseService(profile);
  const search = new SearchService(database);
  const version = database.connection.prepare('PRAGMA user_version').get();
  assert.ok(version && typeof version === 'object' && 'user_version' in version);
  assert.equal(version.user_version, 5);
  assert.equal(search.search({ limit: 20, filters: {}, scope: 'current', text: 'obsolete blue plume' }).items.length, 0);
  assert.equal(search.search({ limit: 20, filters: {}, scope: 'current', text: 'corrected scarlet plume' }).items[0]?.artifactId, artifactId);
  assert.equal(search.search({ limit: 20, filters: {}, scope: 'current', text: 'precise dithering' }).items[0]?.artifactId, artifactId);
  assert.equal(search.search({ limit: 20, filters: {}, scope: 'history', text: 'obsolete blue plume' }).items[0]?.matchedRevision?.revisionId, original);
  assert.equal(search.search({ limit: 20, filters: {}, scope: 'current', text: 'Notebook terminology' }).items[0]?.artifactId, artifactId);
});
