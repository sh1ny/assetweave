import { ConflictException } from '@nestjs/common';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RevisionConflict } from '../src/database/database.service.js';
import { createClipRevision, createStore, createStoredArtifact } from './helpers/store-fixture.js';

const windowsOnly = process.platform !== 'win32';

test('three exact inputs across assets preserve roles and do not change rejected source decisions (AE7)', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Actors' }, 'human');
  const body = store.catalog.createAsset(project.id, { name: 'Body' }, 'human');
  const prop = store.catalog.createAsset(project.id, { name: 'Prop' }, 'human');
  const setting = store.catalog.createAsset(project.id, { name: 'Setting' }, 'human');
  const bodySource = createStoredArtifact(store, body.id);
  const propSource = createStoredArtifact(store, prop.id);
  const settingSource = createStoredArtifact(store, setting.id);
  const propClip = createClipRevision(store, propSource.artifactId);
  const slot = store.catalog.createSlot(body.id, { name: 'Pose' }, 'human');
  const rejected = store.catalog.placeCandidate(slot.id, { artifactId: bodySource.artifactId }, 'human');
  store.database.mutate({ actor: 'fixture', targetType: 'candidate-review', targetId: rejected.id }, ({ connection }) => {
    connection.prepare('UPDATE candidates SET review_state = ?, revision = 2 WHERE id = ?').run('rejected', rejected.id);
    return { before: 'unreviewed', after: 'rejected', result: undefined };
  });
  const output = createStoredArtifact(store, body.id);
  const edges = store.lineage.addInputs(output.artifactId, [
    { artifactId: bodySource.artifactId, role: 'starting artwork' },
    { artifactId: propSource.artifactId, clipId: propClip.clipId, playbackRevisionId: propClip.revisionId, role: 'visual reference' },
    { artifactId: settingSource.artifactId },
  ], 'bridge');
  assert.equal(edges.length, 3);
  assert.deepEqual(store.lineage.listInputs(output.artifactId, { limit: 20 }).items.map(edge =>
    [edge.input.artifactId, edge.input.playbackRevisionId, edge.input.role]).sort(), [
    [bodySource.artifactId, null, 'starting artwork'],
    [propSource.artifactId, propClip.revisionId, 'visual reference'],
    [settingSource.artifactId, null, null],
  ].sort());
  assert.equal(store.catalog.getCandidate(rejected.id).reviewState, 'rejected');
  const correctedClip = createClipRevision(store, propSource.artifactId, { clipId: propClip.clipId });
  assert.notEqual(correctedClip.revisionId, propClip.revisionId);
  store.reopen();
  assert.deepEqual(store.search.traverse(output.artifactId, { direction: 'inputs', limit: 20 }).items
    .map(step => step.artifactId).sort(),
  [bodySource.artifactId, propSource.artifactId, settingSource.artifactId, output.artifactId].sort());
  assert.deepEqual(store.search.traverse(bodySource.artifactId, { direction: 'dependents', limit: 20 }).items
    .map(step => step.artifactId).sort(), [bodySource.artifactId, output.artifactId].sort());
  assert.equal(store.lineage.getInput(edges[1]!.edgeId).input.playbackRevisionId, propClip.revisionId);
  assert.equal(store.catalog.getCandidate(rejected.id).reviewState, 'rejected');
});

test('correction, retraction, cycles and self-links leave exact earlier edges and failed writes atomic (AE14)', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Variants' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Portrait' }, 'human');
  const first = createStoredArtifact(store, asset.id);
  const second = createStoredArtifact(store, asset.id);
  const third = createStoredArtifact(store, asset.id);
  const edge = store.lineage.addInputs(third.artifactId, [{ artifactId: first.artifactId, role: 'draft' }], 'agent')[0]!;
  const revised = store.lineage.correctInput(edge.edgeId, { expectedRevision: 1,
    input: { artifactId: second.artifactId, role: 'revised sketch' },
  }, 'human');
  assert.equal(revised.revision, 2);
  assert.deepEqual(store.search.traverse(third.artifactId, { direction: 'inputs', limit: 20 }).items
    .map(step => step.artifactId).sort(), [second.artifactId, third.artifactId].sort());
  const retracted = store.lineage.retractInput(edge.edgeId, 2, 'human');
  assert.equal(retracted.effective, false);
  assert.deepEqual(store.lineage.listInputs(third.artifactId, { limit: 20 }).items, []);
  assert.deepEqual(store.lineage.listInputHistory(third.artifactId, { limit: 20 }).items.map(row => row.edgeId),
    [edge.edgeId]);
  assert.deepEqual(store.lineage.inputHistory(edge.edgeId, { limit: 20 }).items.map(row => row.effective),
    [true, true, false]);
  assert.throws(() => store.lineage.correctInput(edge.edgeId, { expectedRevision: 1,
    input: { artifactId: first.artifactId } }, 'agent'), RevisionConflict);
  const restored = store.lineage.correctInput(edge.edgeId, { expectedRevision: 3,
    input: { artifactId: second.artifactId, role: 'reused' } }, 'human');
  assert.equal(restored.revision, 4);
  const watermark = store.database.watermark;
  assert.throws(() => store.lineage.addInputs(second.artifactId,
    [{ artifactId: first.artifactId }, { artifactId: third.artifactId }], 'agent'), /lineage cycle/);
  assert.equal(store.database.watermark, watermark);
  assert.deepEqual(store.lineage.listInputs(second.artifactId, { limit: 20 }).items, []);
  assert.throws(() => store.lineage.addInputs(second.artifactId, [{ artifactId: second.artifactId }], 'agent'), /own input/);
  assert.equal(store.database.watermark, watermark);
  store.lineage.addInputs(first.artifactId, [{ artifactId: third.artifactId }], 'human');
  const beforeCorrection = store.database.watermark;
  assert.throws(() => store.lineage.correctInput(edge.edgeId, {
    expectedRevision: 4, input: { artifactId: first.artifactId, role: 'cycle' },
  }, 'agent'), /lineage cycle/);
  assert.equal(store.database.watermark, beforeCorrection);
  assert.equal(store.lineage.getInput(edge.edgeId).input.artifactId, second.artifactId);
  store.reopen();
  const firstHistoryPage = store.lineage.inputHistory(edge.edgeId, { limit: 2 });
  assert.ok(firstHistoryPage.nextCursor);
  const secondHistoryPage = store.lineage.inputHistory(edge.edgeId,
    { limit: 2, cursor: firstHistoryPage.nextCursor });
  assert.equal(secondHistoryPage.nextCursor, null);
  assert.deepEqual([...firstHistoryPage.items, ...secondHistoryPage.items].map(row =>
    [row.revision, row.input.artifactId, row.effective, row.actor, Boolean(row.at)]), [
    [1, first.artifactId, true, 'agent', true],
    [2, second.artifactId, true, 'human', true],
    [3, second.artifactId, false, 'human', true],
    [4, second.artifactId, true, 'human', true],
  ]);
  assert.deepEqual(store.lineage.listInputs(third.artifactId, { limit: 20 }).items.map(item => item.input.artifactId),
    [second.artifactId]);
  assert.throws(() => store.database.connection.prepare('DELETE FROM input_edge_revisions WHERE edge_id = ?')
    .run(edge.edgeId), /input history is immutable/);
});

test('explicit upstream and playback gaps preserve unknown history without fictional inputs (AE14)', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Cutouts' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Walk' }, 'human');
  const source = createStoredArtifact(store, asset.id);
  const output = createStoredArtifact(store, asset.id);
  const clip = createClipRevision(store, source.artifactId);
  assert.throws(() => store.lineage.addGaps(output.artifactId, [{ kind: 'playback', inputArtifactId: source.artifactId,
    clipId: clip.clipId, description: 'Unknown old timing', sourceKind: 'human' }], 'bridge'),
  /artifact-level input/);
  store.lineage.addInputs(output.artifactId, [{ artifactId: source.artifactId, role: 'known input, unknown playback revision' }], 'bridge');
  const gaps = store.lineage.addGaps(output.artifactId, [
    { kind: 'upstream', description: 'Pre-digital drawing, no original file', sourceKind: 'human' },
    { kind: 'playback', inputArtifactId: source.artifactId, clipId: clip.clipId,
      description: 'Old playback timing not retained', sourceKind: 'producer' },
  ], 'bridge');
  assert.deepEqual(store.lineage.listGaps(output.artifactId, { limit: 20 }).items.map(item => item.gap.kind).sort(),
    ['playback', 'upstream']);
  assert.equal(store.lineage.listInputs(output.artifactId, { limit: 20 }).items[0]!.input.playbackRevisionId, null);
  const traversal = store.search.traverse(output.artifactId, { direction: 'inputs', limit: 20 });
  assert.deepEqual(traversal.items.map(step => step.artifactId).sort(), [output.artifactId, source.artifactId].sort());
  assert.deepEqual(traversal.encounteredGaps.map(gap => gap.id).sort(), gaps.map(gap => gap.gapId).sort());
  const corrected = store.lineage.correctGap(gaps[0]!.gapId, { expectedRevision: 1,
    gap: { kind: 'upstream', description: 'Original ink sheet unavailable', sourceKind: 'human' } }, 'human');
  store.lineage.retractGap(corrected.gapId, 2, 'human');
  store.reopen();
  assert.deepEqual(store.lineage.listGaps(output.artifactId, { limit: 20 }).items.map(item => item.gapId),
    [gaps[1]!.gapId]);
  assert.deepEqual(store.lineage.listGapHistory(output.artifactId, { limit: 20 }).items.map(item => item.gapId).sort(),
    gaps.map(gap => gap.gapId).sort());
  assert.deepEqual(store.lineage.gapHistory(corrected.gapId, { limit: 20 }).items.map(item =>
    [item.revision, item.gap.description, item.effective, item.actor]), [
    [1, 'Pre-digital drawing, no original file', true, 'bridge'],
    [2, 'Original ink sheet unavailable', true, 'human'],
    [3, 'Original ink sheet unavailable', false, 'human'],
  ]);
  assert.throws(() => store.database.connection.prepare('UPDATE lineage_gap_revisions SET description = ? WHERE gap_id = ?')
    .run('lost', corrected.gapId), /gap history is immutable/);
});

test('playback gaps keep an effective artifact-level input until explicitly corrected or retracted', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Gap support' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Frame' }, 'human');
  const source = createStoredArtifact(store, asset.id);
  const replacement = createStoredArtifact(store, asset.id);
  const output = createStoredArtifact(store, asset.id);
  const clip = createClipRevision(store, source.artifactId);
  const first = store.lineage.addInputs(output.artifactId, [{ artifactId: source.artifactId }], 'bridge')[0]!;
  const gapInput = { kind: 'playback' as const, inputArtifactId: source.artifactId,
    clipId: clip.clipId, description: 'Original playback unknown', sourceKind: 'producer' };
  const gap = store.lineage.addGaps(output.artifactId, [gapInput], 'bridge')[0]!;

  const expectAtomicConflict = (change: () => unknown, edgeId: string, revision: number) => {
    const watermark = store.database.watermark;
    assert.throws(change, (error: unknown) =>
      error instanceof ConflictException && (error.getResponse() as { code?: string }).code === 'CONFLICT');
    assert.equal(store.database.watermark, watermark);
    assert.equal(store.lineage.getInput(edgeId).revision, revision);
    assert.equal(store.lineage.inputHistory(edgeId, { limit: 20 }).items.length, revision);
  };
  expectAtomicConflict(() => store.lineage.correctInput(first.edgeId, { expectedRevision: 1,
    input: { artifactId: replacement.artifactId } }, 'human'), first.edgeId, 1);
  expectAtomicConflict(() => store.lineage.correctInput(first.edgeId, { expectedRevision: 1,
    input: { artifactId: source.artifactId, clipId: clip.clipId, playbackRevisionId: clip.revisionId } }, 'human'),
  first.edgeId, 1);
  expectAtomicConflict(() => store.lineage.retractInput(first.edgeId, 1, 'human'), first.edgeId, 1);
  assert.equal(store.lineage.getGap(gap.gapId).effective, true);

  const roleChange = store.lineage.correctInput(first.edgeId, { expectedRevision: 1,
    input: { artifactId: source.artifactId, role: 'original line art' } }, 'human');
  assert.equal(roleChange.revision, 2);
  const alternate = store.lineage.addInputs(output.artifactId, [{ artifactId: source.artifactId }], 'bridge')[0]!;
  store.lineage.retractInput(first.edgeId, 2, 'human');
  assert.equal(store.lineage.listInputs(output.artifactId, { limit: 20 }).items[0]!.edgeId, alternate.edgeId);
  expectAtomicConflict(() => store.lineage.correctInput(alternate.edgeId, { expectedRevision: 1,
    input: { artifactId: replacement.artifactId } }, 'human'), alternate.edgeId, 1);

  store.lineage.correctGap(gap.gapId, { expectedRevision: 1,
    gap: { kind: 'upstream', description: 'Original image unavailable', sourceKind: 'producer' } }, 'human');
  store.lineage.correctInput(alternate.edgeId, { expectedRevision: 1,
    input: { artifactId: replacement.artifactId } }, 'human');
  assert.deepEqual(store.lineage.gapHistory(gap.gapId, { limit: 20 }).items.map(row => row.gap.kind),
    ['playback', 'upstream']);
  assert.deepEqual(store.lineage.inputHistory(first.edgeId, { limit: 20 }).items.map(row => row.effective),
    [true, true, false]);

  const replacementClip = createClipRevision(store, replacement.artifactId);
  const replacementGap = store.lineage.addGaps(output.artifactId, [{ ...gapInput,
    inputArtifactId: replacement.artifactId, clipId: replacementClip.clipId }], 'bridge')[0]!;
  expectAtomicConflict(() => store.lineage.retractInput(alternate.edgeId, 2, 'human'), alternate.edgeId, 2);
  store.lineage.retractGap(replacementGap.gapId, 1, 'human');
  store.lineage.retractInput(alternate.edgeId, 2, 'human');
  assert.deepEqual(store.lineage.gapHistory(replacementGap.gapId, { limit: 20 }).items.map(row => row.effective),
    [true, false]);
  assert.deepEqual(store.lineage.listInputs(output.artifactId, { limit: 20 }).items, []);
});

test('composition on an existing capture stores multiple claims, input branches and gaps in one atomic event', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Brushwork' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Ship' }, 'human');
  const a = createStoredArtifact(store, asset.id);
  const b = createStoredArtifact(store, asset.id);
  const output = createStoredArtifact(store, asset.id);
  // The helper has already captured and indexed this artifact; this event adds facts, not a second capture.
  const eventId = store.database.mutate({ actor: 'bridge', targetType: 'artifact-composition', targetId: output.artifactId }, context => {
    const claims = store.provenance.addClaimsInTransaction(context, output.artifactId, [
      { field: 'prompt', state: 'known', value: 'old ship', source: { kind: 'producer' } },
      { field: 'seed', state: 'unknown', source: { kind: 'producer' } },
    ]);
    const edges = store.lineage.addInputsInTransaction(context, output.artifactId, [
      { artifactId: a.artifactId, role: 'underpainting' },
      { artifactId: b.artifactId, role: 'shape reference' },
    ]);
    const gaps = store.lineage.addGapsInTransaction(context, output.artifactId, [
      { kind: 'upstream', description: 'Sketch not retained', sourceKind: 'human' },
    ]);
    assert.deepEqual([claims.length, edges.length, gaps.length], [2, 2, 1]);
    return { before: null, after: { artifactId: output.artifactId }, result: context.eventId };
  });
  const revisions = store.database.connection.prepare(`SELECT audit_event_id AS eventId FROM provenance_revisions
    WHERE artifact_id = ? UNION ALL SELECT audit_event_id FROM input_edge_revisions WHERE output_artifact_id = ?
    UNION ALL SELECT audit_event_id FROM lineage_gap_revisions WHERE output_artifact_id = ?`)
    .all(output.artifactId, output.artifactId, output.artifactId) as unknown as { eventId: number }[];
  assert.equal(revisions.length, 5);
  assert.ok(revisions.every(row => row.eventId === eventId));
  store.reopen();
  assert.deepEqual(store.provenance.listClaims(output.artifactId, { limit: 20 }).items.map(row => row.claim.state).sort(),
    ['known', 'unknown']);
  assert.deepEqual(store.lineage.listInputs(output.artifactId, { limit: 20 }).items.map(row => row.input.artifactId).sort(),
    [a.artifactId, b.artifactId].sort());
  assert.deepEqual(store.lineage.listGaps(output.artifactId, { limit: 20 }).items.map(row => row.gap.description),
    ['Sketch not retained']);
});
