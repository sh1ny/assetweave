import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyMigrations, RevisionConflict } from '../src/database/database.service.js';
import { startServer } from '../src/main.js';
import { createClipRevision, createStore, createStoredArtifact } from './helpers/store-fixture.js';

const windowsOnly = process.platform !== 'win32';

test('request intent and exact proposals remain distinct from actual inputs and an unreported outcome after restart (AE9)', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Character' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Idle sprite' }, 'human');
  const earlier = createStoredArtifact(store, asset.id);
  const next = createStoredArtifact(store, asset.id);
  const plannedClip = createClipRevision(store, earlier.artifactId);
  const actualClip = createClipRevision(store, next.artifactId);
  const request = store.requests.createRequest(project.id, asset.id, { intent: 'Explore the idle pose',
    proposedInputs: [{ artifactId: earlier.artifactId, clipId: plannedClip.clipId,
      playbackRevisionId: plannedClip.revisionId, role: 'starting artwork' }],
  }, 'agent');
  const result = createStoredArtifact(store, asset.id, { requestId: request.id });
  store.lineage.addInputs(result.artifactId, [{ artifactId: next.artifactId,
    clipId: actualClip.clipId, playbackRevisionId: actualClip.revisionId, role: 'actual starting artwork' }], 'agent');
  const newClip = createClipRevision(store, earlier.artifactId, { clipId: plannedClip.clipId });
  assert.notEqual(newClip.revisionId, plannedClip.revisionId);
  store.reopen();
  const retained = store.requests.getRequest(request.id);
  assert.equal(retained.intent, 'Explore the idle pose');
  assert.equal(retained.recordedBy, 'agent');
  assert.deepEqual(retained.outcome, { status: 'unknown' });
  assert.deepEqual(retained.capturedArtifacts.map(artifact => artifact.id), [result.artifactId]);
  assert.deepEqual(retained.proposedInputs.map(input => [input.artifactId, input.clipId, input.playbackRevisionId, input.role]),
    [[earlier.artifactId, plannedClip.clipId, plannedClip.revisionId, 'starting artwork']]);
  assert.deepEqual(store.lineage.listInputs(result.artifactId, { limit: 20 }).items.map(edge =>
    [edge.input.artifactId, edge.input.playbackRevisionId, edge.input.role]),
    [[next.artifactId, actualClip.revisionId, 'actual starting artwork']]);
  assert.throws(() => store.database.connection.prepare('UPDATE proposed_inputs SET role = ? WHERE request_id = ?')
    .run('rewritten', request.id), /proposed inputs are immutable/);
  assert.throws(() => store.database.connection.prepare('DELETE FROM requests WHERE id = ?')
    .run(request.id), /request intent is immutable/);
});

test('distinct claim states, sourced corrections, nested metadata and recording history survive restart (AE10)', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Scene' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Backdrop' }, 'human');
  const { artifactId } = createStoredArtifact(store, asset.id);
  const beforeInvalidBatch = store.database.watermark;
  assert.throws(() => store.provenance.addClaims(artifactId, [
    { field: 'seed', state: 'unknown', source: { kind: 'artist' } },
    { field: 'seed', state: 'absent', source: { kind: 'artist' } },
  ], 'bridge'), /already exists/);
  assert.equal(store.database.watermark, beforeInvalidBatch);
  assert.deepEqual(store.provenance.listClaims(artifactId, { limit: 20 }).items, []);
  const claims = store.provenance.addClaims(artifactId, [
    { field: 'producer', state: 'known', value: 'external drawing program', source: { kind: 'human', detail: 'creator testimony' } },
    { field: 'seed', state: 'unknown', source: { kind: 'agent', detail: 'not exposed by external tool' } },
    { field: 'negativePrompt', state: 'absent', source: { kind: 'producer', detail: 'no negative prompt supplied' } },
    { field: 'parameters', state: 'known', value: { color: { values: ['red', 'blue'], weight: 0.8 } }, source: { kind: 'producer' } },
  ], 'bridge');
  const notRecorded = store.provenance.getClaim(artifactId, 'prompt');
  assert.deepEqual(notRecorded, { artifactId, field: 'prompt', state: 'not-recorded' });
  assert.deepEqual(claims.map(record => record.claim.state), ['known', 'unknown', 'absent', 'known']);
  assert.deepEqual(claims[3]!.claim, { field: 'parameters', state: 'known',
    value: { color: { values: ['red', 'blue'], weight: 0.8 } }, source: { kind: 'producer' } });
  const changed = store.provenance.correctAssertion(claims[1]!.assertionId, {
    expectedRevision: 1,
    claim: { field: 'seed', state: 'known', value: 42, source: { kind: 'human', detail: 'from original notes' } },
  }, 'browser');
  assert.equal(changed.revision, 2);
  assert.throws(() => store.provenance.correctAssertion(changed.assertionId,
    { expectedRevision: 1, claim: { field: 'seed', state: 'absent', source: { kind: 'human' } } }, 'browser'), RevisionConflict);
  const watermark = store.database.watermark;
  assert.throws(() => store.provenance.correctAssertion(changed.assertionId,
    { expectedRevision: 2, claim: { field: 'prompt', state: 'unknown', source: { kind: 'human' } } }, 'browser'),
  /cannot change the assertion field/);
  assert.equal(store.database.watermark, watermark);
  store.reopen();
  assert.equal(store.provenance.getAssertion(changed.assertionId).claim.state, 'known');
  assert.deepEqual(store.provenance.assertionHistory(changed.assertionId, { limit: 20 }).items.map(row =>
    [row.revision, row.claim.state, row.actor, Boolean(row.at)]),
    [[1, 'unknown', 'bridge', true], [2, 'known', 'browser', true]]);
  assert.deepEqual(store.provenance.getClaim(artifactId, 'prompt'),
    { artifactId, field: 'prompt', state: 'not-recorded' });
  const negativePrompt = store.provenance.getClaim(artifactId, 'negativePrompt');
  assert.ok('claim' in negativePrompt);
  assert.equal(negativePrompt.claim.state, 'absent');
  assert.throws(() => store.database.connection.prepare('DELETE FROM provenance_revisions WHERE assertion_id = ?')
    .run(changed.assertionId), /claim history is immutable/);
});

test('request association errors are atomic; outcome reports remain separate from later capture (AE9)', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Sprites' }, 'human');
  const anotherProject = store.catalog.createProject({ name: 'Other' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Fox' }, 'human');
  const other = store.catalog.createAsset(anotherProject.id, { name: 'Owl' }, 'human');
  const foreignSlot = store.catalog.createSlot(other.id, { name: 'Stand' }, 'human');
  const foreignInput = createStoredArtifact(store, other.id);
  const ownInput = createStoredArtifact(store, asset.id);
  const foreignClip = createClipRevision(store, foreignInput.artifactId);
  const current = store.database.watermark;
  assert.throws(() => store.requests.createRequest(anotherProject.id, asset.id, { intent: 'Wrong project' }, 'agent'),
    /does not belong/);
  assert.throws(() => store.requests.createRequest(project.id, asset.id,
    { intent: 'Wrong slot', slotId: foreignSlot.id }, 'agent'), /does not belong/);
  assert.throws(() => store.requests.createRequest(project.id, asset.id,
    { intent: 'Wrong playback', proposedInputs: [{ artifactId: ownInput.artifactId,
      clipId: foreignClip.clipId, playbackRevisionId: foreignClip.revisionId }] }, 'agent'),
  /does not belong/);
  assert.equal(store.database.watermark, current);
  const request = store.requests.createRequest(project.id, asset.id,
    { intent: 'Try a new pose', proposedInputs: [{ artifactId: foreignInput.artifactId, role: 'reference' }] }, 'agent');
  assert.throws(() => store.requests.requireAssociation(store.database.connection, request.id, anotherProject.id, other.id),
    /different project or asset/);
  const failed = store.requests.reportOutcome(request.id, { expectedRevision: 0, status: 'failed', notes: 'Tool timed out' }, 'agent');
  assert.equal(failed.outcome.status, 'failed');
  const result = createStoredArtifact(store, asset.id, { requestId: request.id });
  assert.equal(store.requests.getRequest(request.id).outcome.status, 'failed');
  assert.deepEqual(store.requests.getRequest(request.id).capturedArtifacts.map(a => a.id), [result.artifactId]);
  const cancelled = store.requests.reportOutcome(request.id, { expectedRevision: 1, status: 'cancelled' }, 'human');
  assert.equal(cancelled.outcome.status, 'cancelled');
  const later = createStoredArtifact(store, asset.id, { requestId: request.id });
  assert.equal(store.requests.getRequest(request.id).outcome.status, 'cancelled');
  assert.deepEqual(store.requests.getRequest(request.id).capturedArtifacts.map(a => a.id).sort(),
    [result.artifactId, later.artifactId].sort());
  assert.throws(() => store.requests.reportOutcome(request.id, { expectedRevision: 1, status: 'succeeded' }, 'agent'), RevisionConflict);
  store.reopen();
  assert.deepEqual(store.requests.outcomeHistory(request.id, { limit: 20 }).items.map(outcome =>
    [outcome.status, outcome.actor, outcome.notes]),
    [['failed', 'agent', 'Tool timed out'], ['cancelled', 'human', '']]);
  assert.equal(store.requests.getRequest(request.id).outcome.status, 'cancelled');
  assert.throws(() => store.database.connection.prepare('UPDATE request_outcomes SET status = ? WHERE request_id = ?')
    .run('succeeded', request.id), /outcome history is immutable/);
});

test('HTTP routes expose real durable request, claim, lineage and history records through bridge authorization', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'HTTP art' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Potion' }, 'human');
  const { artifactId } = createStoredArtifact(store, asset.id);
  store.database.close();
  store.profile.close();
  const webDist = join(store.root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html>private test shell</html>');
  const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
  try {
    const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
    const headers = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' };
    const requestResponse = await fetch(`${server.origin}/api/projects/${project.id}/assets/${asset.id}/requests`, {
      method: 'POST', headers, body: JSON.stringify({ intent: 'Draw a potion' }),
    });
    assert.equal(requestResponse.status, 201);
    const request = await requestResponse.json() as { id: string; outcome: { status: string } };
    assert.equal(request.outcome.status, 'unknown');
    const claims = await fetch(`${server.origin}/api/artifacts/${artifactId}/claims`, {
      method: 'POST', headers, body: JSON.stringify({ claims: [
        { field: 'producer', state: 'known', value: 'artist', source: { kind: 'human' } },
        { field: 'seed', state: 'unknown', source: { kind: 'human' } },
      ] }),
    });
    assert.equal(claims.status, 201);
    const claimRows = await claims.json() as { assertionId: string }[];
    assert.equal((await fetch(`${server.origin}/api/artifacts/${artifactId}/claims/prompt`, { headers })).status, 200);
    const outcome = await fetch(`${server.origin}/api/requests/${request.id}/outcomes`, {
      method: 'POST', headers, body: JSON.stringify({ expectedRevision: 0, status: 'failed' }),
    });
    assert.equal(outcome.status, 201);
    assert.equal((await fetch(`${server.origin}/api/assertions/${claimRows[0]!.assertionId}/history`, { headers })).status, 200);
    const inputs = await fetch(`${server.origin}/api/artifacts/${artifactId}/inputs`, { headers });
    assert.equal(inputs.status, 200);
    assert.deepEqual((await inputs.json() as { items: unknown[] }).items, []);
    const gaps = await fetch(`${server.origin}/api/artifacts/${artifactId}/gaps`, { headers });
    assert.equal(gaps.status, 200);
    assert.deepEqual((await gaps.json() as { items: unknown[] }).items, []);
    const invalid = await fetch(`${server.origin}/api/projects/${project.id}/assets/${asset.id}/requests`, {
      method: 'POST', headers, body: JSON.stringify({ intent: 'Unexpected', hidden: 'no' }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await server.close();
  }
});

test('forward 002 migration preserves populated 001 revision pointers and permits shared-event history', { skip: windowsOnly }, t => {
  let legacy: DatabaseSync | undefined;
  t.after(() => legacy?.close());
  const store = createStore(t);
  const filename = join(store.profile.path, 'legacy-migration.sqlite');
  legacy = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  const first = readFileSync(new URL('../src/database/migrations/001-domain.sql', import.meta.url), 'utf8');
  const second = readFileSync(new URL('../src/database/migrations/002-domain-integrity.sql', import.meta.url), 'utf8');
  legacy.exec('PRAGMA foreign_keys = ON');
  applyMigrations(legacy, [{ version: 1, sql: first }]);
  const projectId = randomUUID(), assetId = randomUUID(), sourceId = randomUUID(), resultId = randomUUID();
  const claimId = randomUUID(), claimRevisionId = randomUUID();
  const edgeId = randomUUID(), edgeRevisionId = randomUUID();
  const gapId = randomUUID(), gapRevisionId = randomUUID();
  const clipId = randomUUID(), playbackId = randomUUID();
  legacy.exec('BEGIN IMMEDIATE');
  try {
    legacy.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES (?, 'Existing', 'before', 'before')")
      .run(projectId);
    legacy.prepare("INSERT INTO assets(id,project_id,name,created_at,updated_at) VALUES (?, ?, 'Art', 'before', 'before')")
      .run(assetId, projectId);
    for (const [index, id] of [sourceId, resultId].entries()) {
      legacy.prepare(`INSERT INTO artifacts
        (id,project_id,asset_id,operation_id,kind,name,content_directory,captured_at,recorded_by)
        VALUES (?,?,?,?, 'png','stored',?,'before','agent')`)
        .run(id, projectId, assetId, randomUUID(), `pre-002-${index}`);
    }
    for (const id of [1, 2, 3, 4]) {
      legacy.prepare(`INSERT INTO audit_events
        (id,actor,recorded_at,target_type,target_id,before_json,after_json)
        VALUES (?,'agent','before','artifact',?,'null','null')`).run(id, resultId);
    }
    legacy.prepare('INSERT INTO provenance_assertions(id,artifact_id,field,current_revision_id,revision) VALUES (?,?,?, ?,1)')
      .run(claimId, resultId, 'prompt', claimRevisionId);
    legacy.prepare(`INSERT INTO provenance_revisions
      (id,assertion_id,artifact_id,revision,state,value_json,source_kind,audit_event_id)
      VALUES (?,?,?,1,'known','\"draw ship\"','agent',1)`).run(claimRevisionId, claimId, resultId);
    legacy.prepare('INSERT INTO input_edges(id,output_artifact_id,current_revision_id,revision) VALUES (?,?,?,1)')
      .run(edgeId, resultId, edgeRevisionId);
    legacy.prepare(`INSERT INTO input_edge_revisions
      (id,edge_id,output_artifact_id,revision,input_artifact_id,is_effective,audit_event_id)
      VALUES (?,?,?,1,?,1,2)`).run(edgeRevisionId, edgeId, resultId, sourceId);
    legacy.prepare('INSERT INTO lineage_gaps(id,output_artifact_id,current_revision_id,revision) VALUES (?,?,?,1)')
      .run(gapId, resultId, gapRevisionId);
    legacy.prepare(`INSERT INTO lineage_gap_revisions
      (id,gap_id,output_artifact_id,revision,gap_kind,description,source_kind,is_effective,audit_event_id)
      VALUES (?,?,?,1,'upstream','missing','human',1,3)`).run(gapRevisionId, gapId, resultId);
    legacy.prepare(`INSERT INTO clips
      (id,artifact_id,name,normalized_name,current_revision_id,revision,created_at)
      VALUES (?,?,'Idle','idle',?,1,'before')`).run(clipId, sourceId, playbackId);
    legacy.prepare(`INSERT INTO playback_revisions
      (id,clip_id,artifact_id,revision,geometry_json,frames_json,timing_json,source_kind,audit_event_id)
      VALUES (?,?,?,1,'{}','[]','{}','human',4)`).run(playbackId, clipId, sourceId);
    legacy.exec('COMMIT');
  } catch (error) {
    legacy.exec('ROLLBACK');
    throw error;
  }

  applyMigrations(legacy, [{ version: 1, sql: first }, { version: 2, sql: second }]);
  assert.equal((legacy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  assert.equal((legacy.prepare('SELECT current_revision_id AS revision FROM provenance_assertions WHERE id = ?')
    .get(claimId) as { revision: string }).revision, claimRevisionId);
  assert.equal((legacy.prepare('SELECT current_revision_id AS revision FROM input_edges WHERE id = ?')
    .get(edgeId) as { revision: string }).revision, edgeRevisionId);
  assert.equal((legacy.prepare('SELECT current_revision_id AS revision FROM lineage_gaps WHERE id = ?')
    .get(gapId) as { revision: string }).revision, gapRevisionId);
  assert.equal((legacy.prepare('SELECT current_revision_id AS revision FROM clips WHERE id = ?')
    .get(clipId) as { revision: string }).revision, playbackId);
  legacy.exec('BEGIN IMMEDIATE');
  try {
    legacy.prepare('INSERT INTO provenance_assertions(id,artifact_id,field,current_revision_id,revision) VALUES (?,?,?, ?,1)')
      .run(randomUUID(), resultId, 'seed', randomUUID());
    const extraClaim = legacy.prepare('SELECT id, current_revision_id AS revision FROM provenance_assertions WHERE artifact_id = ? AND field = ?')
      .get(resultId, 'seed') as { id: string; revision: string };
    legacy.prepare(`INSERT INTO provenance_revisions
      (id,assertion_id,artifact_id,revision,state,source_kind,audit_event_id)
      VALUES (?,?,?,1,'unknown','agent',1)`).run(extraClaim.revision, extraClaim.id, resultId);
    const extraEdge = randomUUID(), extraEdgeRevision = randomUUID();
    legacy.prepare('INSERT INTO input_edges(id,output_artifact_id,current_revision_id,revision) VALUES (?,?,?,1)')
      .run(extraEdge, resultId, extraEdgeRevision);
    legacy.prepare(`INSERT INTO input_edge_revisions
      (id,edge_id,output_artifact_id,revision,input_artifact_id,is_effective,audit_event_id)
      VALUES (?,?,?,1,?,1,2)`).run(extraEdgeRevision, extraEdge, resultId, sourceId);
    const extraGap = randomUUID(), extraGapRevision = randomUUID();
    legacy.prepare('INSERT INTO lineage_gaps(id,output_artifact_id,current_revision_id,revision) VALUES (?,?,?,1)')
      .run(extraGap, resultId, extraGapRevision);
    legacy.prepare(`INSERT INTO lineage_gap_revisions
      (id,gap_id,output_artifact_id,revision,gap_kind,description,source_kind,is_effective,audit_event_id)
      VALUES (?,?,?,1,'upstream','older unknown','human',1,3)`).run(extraGapRevision, extraGap, resultId);
    const otherClip = randomUUID(), otherRevision = randomUUID();
    legacy.prepare(`INSERT INTO clips
      (id,artifact_id,name,normalized_name,current_revision_id,revision,created_at)
      VALUES (?,?,'Walk','walk',?,1,'after')`).run(otherClip, sourceId, otherRevision);
    legacy.prepare(`INSERT INTO playback_revisions
      (id,clip_id,artifact_id,revision,geometry_json,frames_json,timing_json,source_kind,audit_event_id)
      VALUES (?,?,?,1,'{}','[]','{}','human',4)`).run(otherRevision, otherClip, sourceId);
    const slotId = randomUUID(), candidateId = randomUUID(), authorityId = randomUUID();
    legacy.prepare(`INSERT INTO slots(id,asset_id,name,normalized_name,created_at,updated_at)
      VALUES (?,?,'Choice','choice','after','after')`).run(slotId, assetId);
    legacy.prepare(`INSERT INTO candidates(id,slot_id,artifact_id,clip_id,placed_at)
      VALUES (?,?,?,?,'after')`).run(candidateId, slotId, sourceId, clipId);
    legacy.prepare(`INSERT INTO authorities(id,channel,instruction,recorded_by,recorded_at)
      VALUES (?,'browser','select clip','human','after')`).run(authorityId);
    legacy.prepare(`INSERT INTO audit_events
      (id,actor,recorded_at,target_type,target_id,before_json,after_json)
      VALUES (5,'human','after','slot',?,'null','null')`).run(slotId);
    legacy.prepare(`INSERT INTO slot_selections
      (id,slot_id,revision,next_candidate_id,next_clip_id,next_playback_revision_id,authority_id,audit_event_id)
      VALUES (?,?,1,?,?,?,?,5)`).run(randomUUID(), slotId, candidateId, clipId, playbackId, authorityId);
    legacy.exec('COMMIT');
  } catch (error) {
    legacy.exec('ROLLBACK');
    throw error;
  }
  assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
  for (const table of ['provenance_revisions', 'input_edge_revisions', 'lineage_gap_revisions', 'playback_revisions']) {
    assert.equal((legacy.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 2);
  }
});

test('forward 005 migration protects populated project history and retained exact search links', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const connection = new DatabaseSync(join(store.profile.path, 'pre-project-history.sqlite'), {
    enableForeignKeyConstraints: true,
  });
  try {
    connection.exec('PRAGMA foreign_keys = ON');
    const migrations = ['001-domain.sql', '002-domain-integrity.sql', '003-decisions.sql',
      '004-search.sql', '005-project-history.sql'].map((filename, index) => ({
      version: index + 1,
      sql: readFileSync(new URL(`../src/database/migrations/${filename}`, import.meta.url), 'utf8'),
    }));
    applyMigrations(connection, migrations.slice(0, 3));
    const projectId = randomUUID();
    connection.prepare(`INSERT INTO audit_events
      (id, actor, recorded_at, target_type, target_id, before_json, after_json)
      VALUES (1, 'human', 'before', 'project', ?, 'null', '{}')`).run(projectId);
    connection.prepare(`INSERT INTO audit_events
      (id, actor, recorded_at, target_type, target_id, before_json, after_json)
      VALUES (2, 'human', 'after', 'project', ?, '{}', '{}')`).run(projectId);
    connection.prepare(`INSERT INTO projects(id, name, notes, revision, created_at, updated_at)
      VALUES (?, 'New project', 'new notes', 2, 'before', 'after')`).run(projectId);
    connection.prepare(`INSERT INTO project_revisions(project_id, revision, name, notes, audit_event_id)
      VALUES (?, 1, 'Original project', 'original notes', 1)`).run(projectId);
    connection.prepare(`INSERT INTO project_revisions(project_id, revision, name, notes, audit_event_id)
      VALUES (?, 2, 'New project', 'new notes', 2)`).run(projectId);
    applyMigrations(connection, migrations.slice(0, 4));
    const revisionId = `${projectId}:1`;
    const historicalLink = connection.prepare(`SELECT revision_id AS revisionId, current
      FROM search_documents WHERE record_type = 'project' AND revision_id = ?`);
    assert.deepEqual({ ...historicalLink.get(revisionId) }, { revisionId, current: 0 });
    const previousVersion = connection.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(previousVersion.user_version, 4);

    applyMigrations(connection, migrations);
    const currentVersion = connection.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(currentVersion.user_version, 5);
    assert.throws(() => connection.prepare(`UPDATE project_revisions SET name = 'Rewritten'
      WHERE project_id = ? AND revision = 1`).run(projectId), /project history is immutable/);
    assert.throws(() => connection.prepare(`DELETE FROM project_revisions
      WHERE project_id = ? AND revision = 1`).run(projectId), /project history is immutable/);
    assert.deepEqual({ ...connection.prepare(`SELECT name, notes FROM project_revisions
      WHERE project_id = ? AND revision = 1`).get(projectId) },
    { name: 'Original project', notes: 'original notes' });
    assert.deepEqual({ ...historicalLink.get(revisionId) }, { revisionId, current: 0 });
    assert.deepEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    connection.close();
  }
});
