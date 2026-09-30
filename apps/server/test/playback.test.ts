import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MediaDescription } from '@assetweave/contracts/media';
import type { ClipRecord, PlaybackRevision } from '@assetweave/contracts/playback';
import type { QueryPage } from '@assetweave/contracts/queries';
import type { InputEdgeRecord, InputEdgeRevision } from '@assetweave/contracts/production';
import { createStore } from './helpers/store-fixture.js';
import { auth, captureFixtures, fixture, mediaServer } from './helpers/media-fixture.js';

const skip = process.platform !== 'win32';
const source = { kind: 'human', detail: 'Inspected sprite export and supplied the timing.' };
const grid = { kind: 'grid' as const, memberOrdinal: 0, cellWidth: 2, cellHeight: 2, columns: 4, rows: 2 };

async function json(origin: string, bearer: string, path: string, method: 'POST' | 'PATCH', body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, { method, headers: { ...auth(bearer), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('AE11/AE12/AE14: two named clips on one sheet retain old revision and actual-input pin on correction', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Playback examples' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight animations' }, 'human');
  const slot = store.catalog.createSlot(asset.id, { name: 'Walk / north' }, 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    const artifactId = await captureFixtures(server, bearer, project.id, asset.id, ['eight-cell-grid.png']);
    const initial = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(initial.playback, 'unconfigured');
    assert.equal(initial.members[0]!.preview, 'available');
    const invalid = await json(server.origin, bearer, `/api/artifacts/${artifactId}/clips`, 'POST', {
      name: 'Bad grid', geometry: { ...grid, cellWidth: 3 }, frames: [0, 1], durationsMs: [125, 125], source });
    assert.equal(invalid.status, 400);
    assert.deepEqual((await (await fetch(`${server.origin}/api/artifacts/${artifactId}/clips`,
      { headers: auth(bearer) })).json() as QueryPage<ClipRecord>).items, []);
    const missingTiming = await json(server.origin, bearer, `/api/artifacts/${artifactId}/clips`, 'POST', {
      name: 'No invented FPS', geometry: grid, frames: [0, 1], durationsMs: [125], source });
    assert.equal(missingTiming.status, 400);
    const zeroTiming = await json(server.origin, bearer, `/api/artifacts/${artifactId}/clips`, 'POST', {
      name: 'Zero is unknown', geometry: grid, frames: [0, 1], durationsMs: [125, 0], source });
    assert.equal(zeroTiming.status, 400);
    const walkResponse = await json(server.origin, bearer, `/api/artifacts/${artifactId}/clips`, 'POST', {
      name: 'Walk', geometry: grid, frames: [0, 1, 2, 3], durationsMs: [125, 125, 125, 125], source });
    assert.equal(walkResponse.status, 201, await walkResponse.clone().text());
    const walk = await walkResponse.json() as ClipRecord;
    assert.deepEqual(walk.current.cumulativeMs, [125, 250, 375, 500]);
    assert.equal(walk.current.cycleMs, 500);
    assert.equal(walk.current.framesPerSecond, 8);
    assert.equal(walk.current.description.source.kind, 'human');
    const attackResponse = await json(server.origin, bearer, `/api/artifacts/${artifactId}/clips`, 'POST', {
      name: 'Attack', geometry: grid, frames: [4, 5, 6, 7], durationsMs: [100, 100, 100, 100], source: { kind: 'agent', detail: 'Artist supplied timing' } });
    assert.equal(attackResponse.status, 201, await attackResponse.clone().text());
    const attack = await attackResponse.json() as ClipRecord;
    assert.equal(attack.current.cycleMs, 400);
    assert.equal(attack.current.framesPerSecond, 10);
    const firstClipPage = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/clips?limit=1`,
      { headers: auth(bearer) })).json() as QueryPage<ClipRecord>;
    assert.deepEqual(firstClipPage.items.map(item => item.name), ['Attack']);
    assert.ok(firstClipPage.nextCursor);
    const secondClipPage = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/clips?limit=1&cursor=${firstClipPage.nextCursor}`,
      { headers: auth(bearer) })).json() as QueryPage<ClipRecord>;
    assert.deepEqual(secondClipPage.items.map(item => item.name), ['Walk']);
    assert.equal(secondClipPage.nextCursor, null);
    const conflictingName = await json(server.origin, bearer, `/api/artifacts/${artifactId}/clips`, 'POST', {
      name: '  WALK  ', geometry: grid, frames: [0], durationsMs: [200], source });
    assert.equal(conflictingName.status, 409);
    const candidateResponse = await json(server.origin, bearer, `/api/slots/${slot.id}/candidates`, 'POST',
      { artifactId, clipId: walk.id });
    assert.equal(candidateResponse.status, 201);
    const candidate = await candidateResponse.json() as { id: string; clipId: string; reviewState: string };
    assert.equal(candidate.clipId, walk.id);
    const outputId = await captureFixtures(server, bearer, project.id, asset.id, ['sequence-0.png']);
    const inputResponse = await json(server.origin, bearer, `/api/artifacts/${outputId}/inputs`, 'POST',
      { inputs: [{ artifactId, clipId: walk.id, playbackRevisionId: walk.current.id, role: 'exact walk animation' }] });
    assert.equal(inputResponse.status, 201, await inputResponse.clone().text());
    const correction = await json(server.origin, bearer, `/api/clips/${walk.id}`, 'PATCH', {
      expectedRevision: 1, geometry: grid, frames: [3, 2, 1, 0], durationsMs: [200, 200, 200, 200],
      source: { kind: 'human', detail: 'Corrected the walk order.' } });
    assert.equal(correction.status, 200, await correction.clone().text());
    const current = await correction.json() as ClipRecord;
    assert.equal(current.id, walk.id);
    assert.equal(current.current.cycleMs, 800);
    assert.equal(current.current.framesPerSecond, 5);
    assert.deepEqual(current.current.description.frames, [3, 2, 1, 0]);
    const history = await (await fetch(`${server.origin}/api/clips/${walk.id}/history`,
      { headers: auth(bearer) })).json() as QueryPage<PlaybackRevision>;
    assert.deepEqual(history.items.map(revision => revision.cycleMs), [500, 800]);
    assert.deepEqual(history.items.map(revision => revision.actor), ['bridge', 'bridge']);
    const firstRevisionPage = await (await fetch(`${server.origin}/api/clips/${walk.id}/history?limit=1`,
      { headers: auth(bearer) })).json() as QueryPage<PlaybackRevision>;
    assert.equal(firstRevisionPage.items[0]?.id, walk.current.id);
    assert.ok(firstRevisionPage.nextCursor);
    const secondRevisionPage = await (await fetch(`${server.origin}/api/clips/${walk.id}/history?limit=1&cursor=${firstRevisionPage.nextCursor}`,
      { headers: auth(bearer) })).json() as QueryPage<PlaybackRevision>;
    assert.equal(secondRevisionPage.items[0]?.id, current.current.id);
    assert.equal(secondRevisionPage.nextCursor, null);
    assert.equal((await fetch(`${server.origin}/api/artifacts/${artifactId}/clips?limit=1&cursor=${firstClipPage.nextCursor}`,
      { headers: auth(bearer) })).status, 409);
    const old = await (await fetch(`${server.origin}/api/playback-revisions/${walk.current.id}`, { headers: auth(bearer) })).json() as PlaybackRevision;
    assert.equal(old.cycleMs, 500);
    const pinnedPreview = await fetch(`${server.origin}${old.memberPreviewUrls[0]!.url}`, { headers: auth(bearer) });
    assert.deepEqual(Buffer.from(await pinnedPreview.arrayBuffer()), fixture('eight-cell-grid.png'));
    const recordedInputs = await (await fetch(`${server.origin}/api/artifacts/${outputId}/inputs?limit=1`,
      { headers: auth(bearer) })).json() as QueryPage<InputEdgeRecord>;
    assert.equal(recordedInputs.nextCursor, null);
    const pinnedInput = await (await fetch(`${server.origin}/api/inputs/${recordedInputs.items[0]!.edgeId}/history?limit=1`,
      { headers: auth(bearer) })).json() as QueryPage<InputEdgeRevision>;
    assert.equal(pinnedInput.items[0]!.input.playbackRevisionId, old.id);
    assert.equal(pinnedInput.nextCursor, null);
    const candidateAfter = await (await fetch(`${server.origin}/api/candidates/${candidate.id}`, { headers: auth(bearer) })).json() as { clipId: string; reviewState: string };
    assert.equal(candidateAfter.clipId, walk.id);
    assert.equal(candidateAfter.reviewState, 'unreviewed');
    const stale = await json(server.origin, bearer, `/api/clips/${walk.id}`, 'PATCH', {
      expectedRevision: 1, geometry: grid, frames: [0], durationsMs: [100], source });
    assert.equal(stale.status, 409);
    const afterStale = await (await fetch(`${server.origin}/api/clips/${walk.id}/history`,
      { headers: auth(bearer) })).json() as QueryPage<PlaybackRevision>;
    assert.equal(afterStale.items.length, 2);
    assert.equal((await (await fetch(`${server.origin}/api/clips/${walk.id}`,
      { headers: auth(bearer) })).json() as ClipRecord).currentRevisionId, current.currentRevisionId);
    assert.equal((await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`,
      { headers: auth(bearer) })).json() as MediaDescription).playback, 'configured');
    writeFileSync(join(store.profilePath, 'artwork', artifactId, '0000.bin'), 'content replaced after revision');
    const afterLoss = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(afterLoss.content, 'unavailable');
    assert.equal(afterLoss.playback, 'unavailable');
    assert.equal((await fetch(`${server.origin}${current.current.memberPreviewUrls[0]!.url}`, { headers: auth(bearer) })).status, 503);
    const retained = await (await fetch(`${server.origin}/api/clips/${walk.id}/history`,
      { headers: auth(bearer) })).json() as QueryPage<PlaybackRevision>;
    assert.deepEqual(retained.items.map(revision => revision.cycleMs), [500, 800]);
  } finally { await server.close(); }
});

test('AE13: sequence order is explicit, dimensions verified, and historical playback survives missing bytes', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Frame sequences' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Run' }, 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    const sequenceId = await captureFixtures(server, bearer, project.id, asset.id,
      ['sequence-0.png', 'sequence-1.png', 'sequence-2.png']);
    const before = await (await fetch(`${server.origin}/api/artifacts/${sequenceId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(before.playback, 'unconfigured');
    const wrong = await json(server.origin, bearer, `/api/artifacts/${sequenceId}/clips`, 'POST', {
      name: 'Invalid sequence', geometry: { kind: 'sequence', width: 3, height: 2 },
      frames: [2, 0, 1], durationsMs: [40, 60, 100], source });
    assert.equal(wrong.status, 400);
    const invalidOrdinal = await json(server.origin, bearer, `/api/artifacts/${sequenceId}/clips`, 'POST', {
      name: 'Out of range', geometry: { kind: 'sequence', width: 2, height: 2 },
      frames: [3], durationsMs: [40], source });
    assert.equal(invalidOrdinal.status, 400);
    const created = await json(server.origin, bearer, `/api/artifacts/${sequenceId}/clips`, 'POST', {
      name: 'Run loop', geometry: { kind: 'sequence', width: 2, height: 2 },
      frames: [2, 0, 1], durationsMs: [40, 60, 100], source });
    assert.equal(created.status, 201, await created.clone().text());
    const clip = await created.json() as ClipRecord;
    assert.deepEqual(clip.current.description.frames, [2, 0, 1]);
    assert.deepEqual(clip.current.cumulativeMs, [40, 100, 200]);
    assert.equal(clip.current.framesPerSecond, null);
    assert.deepEqual(clip.current.memberPreviewUrls.map(row => row.ordinal), [2, 0, 1]);
    for (const [index, row] of clip.current.memberPreviewUrls.entries()) {
      const image = await fetch(`${server.origin}${row.url}`, { headers: auth(bearer) });
      assert.equal(image.status, 200);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), fixture(`sequence-${[2, 0, 1][index]}.png`));
    }
    const unrelated = await fetch(`${server.origin}/api/playback-revisions/${clip.current.id}/members/5/preview`, { headers: auth(bearer) });
    assert.equal(unrelated.status, 404);
    const gridOnSequence = await json(server.origin, bearer, `/api/artifacts/${sequenceId}/clips`, 'POST', {
      name: 'Wrong form', geometry: grid, frames: [0], durationsMs: [100], source });
    assert.equal(gridOnSequence.status, 400);
    writeFileSync(join(store.profilePath, 'artwork', sequenceId, '0001.bin'),
      Buffer.alloc(fixture('sequence-1.png').length));
    assert.equal((await fetch(`${server.origin}${clip.current.memberPreviewUrls[0]!.url}`,
      { headers: auth(bearer) })).status, 200);
    assert.equal((await fetch(`${server.origin}${clip.current.memberPreviewUrls[2]!.url}`,
      { headers: auth(bearer) })).status, 503);
    const brokenSequence = await (await fetch(`${server.origin}/api/artifacts/${sequenceId}/media`,
      { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(brokenSequence.content, 'unavailable');
    const atlasId = await captureFixtures(server, bearer, project.id, asset.id, ['irregular-atlas.png'], { kind: 'irregular-atlas' });
    const atlas = await (await fetch(`${server.origin}/api/artifacts/${atlasId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(atlas.playback, 'unconfigured');
    assert.equal(atlas.members[0]!.preview, 'available');
    const atlasGrid = await json(server.origin, bearer, `/api/artifacts/${atlasId}/clips`, 'POST', {
      name: 'Incorrect grid', geometry: { kind: 'grid', memberOrdinal: 0, cellWidth: 2, cellHeight: 2, columns: 3, rows: 2 },
      frames: [0, 1], durationsMs: [100, 100], source });
    assert.equal(atlasGrid.status, 400);
    const gifId = await captureFixtures(server, bearer, project.id, asset.id, ['variable-disposal.gif'], { kind: 'gif' });
    const gifGrid = await json(server.origin, bearer, `/api/artifacts/${gifId}/clips`, 'POST', {
      name: 'Wrong encoding', geometry: grid, frames: [0], durationsMs: [100], source });
    assert.equal(gifGrid.status, 400);
    const zeroId = await captureFixtures(server, bearer, project.id, asset.id, ['zero-delay.gif'], { kind: 'gif' });
    const zero = await (await fetch(`${server.origin}/api/artifacts/${zeroId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(zero.members[0]!.encodedTiming?.status, 'unknown');
    assert.equal(zero.playback, 'unconfigured');
    const missingId = await captureFixtures(server, bearer, project.id, asset.id, ['missing-delay.gif'], { kind: 'gif' });
    const missing = await (await fetch(`${server.origin}/api/artifacts/${missingId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(missing.members[0]!.encodedTiming?.status, 'unknown');
    assert.equal(missing.playback, 'unconfigured');
  } finally { await server.close(); }
});
