import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssetRecord, CandidateRecord } from '@assetweave/contracts/catalog';
import type {
  AssetStageDecision, CandidateReviewDecision, ReviewResult, SelectionResult, SlotDecisionState, SlotSelectionDecision,
} from '@assetweave/contracts/decisions';
import type { ClipRecord, PlaybackRevision } from '@assetweave/contracts/playback';
import type { LineagePage, QueryPage } from '@assetweave/contracts/queries';
import type { InputEdgeRecord, InputEdgeRevision } from '@assetweave/contracts/production';
import { createStore, createStoredArtifact } from './helpers/store-fixture.js';
import { auth, captureFixtures, mediaServer } from './helpers/media-fixture.js';

const skip = process.platform !== 'win32';
const instruction = 'The artist explicitly instructed me to record this creative choice.';

async function change(origin: string, headers: Record<string, string>, path: string, method: 'POST' | 'PATCH', body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function result<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<T>;
}
async function read<T>(origin: string, headers: Record<string, string>, path: string): Promise<T> {
  return result<T>(await fetch(`${origin}${path}`, { headers }));
}
async function place(origin: string, headers: Record<string, string>, slotId: string, artifactId: string, clipId?: string): Promise<CandidateRecord> {
  return result<CandidateRecord>(await change(origin, headers, `/api/slots/${slotId}/candidates`, 'POST', {
    artifactId, ...(clipId ? { clipId } : {}),
  }), 201);
}
async function pair(origin: string, profilePath: string): Promise<Record<string, string>> {
  const { launcherToken } = JSON.parse(readFileSync(join(profilePath, 'launcher.json'), 'utf8')) as { launcherToken: string };
  const issued = await result<{ capability: string }>(await fetch(`${origin}/__local/pair-capability`, {
    method: 'POST', headers: { Authorization: `Bearer ${launcherToken}` },
  }), 201);
  const paired = await fetch(`${origin}/api/pair`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capability: issued.capability }) });
  assert.equal(paired.status, 201);
  const cookie = paired.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  const { csrfToken } = await read<{ csrfToken: string }>(origin, { Cookie: cookie }, '/api/session');
  return { Cookie: cookie, Origin: origin, 'x-assetweave-csrf': csrfToken };
}

test('AE3/AE5: multiple per-slot approvals, absent selection, stage only by instruction, and foreign asset placement', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Actors' }, 'human');
  const owner = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const borrower = store.catalog.createAsset(project.id, { name: 'Royal portrait' }, 'human');
  const concept = store.catalog.createSlot(owner.id, { name: 'Concept' }, 'human');
  const portrait = store.catalog.createSlot(owner.id, { name: 'Portrait' }, 'human');
  const borrowed = store.catalog.createSlot(borrower.id, { name: 'Reference' }, 'human');
  const first = createStoredArtifact(store, owner.id);
  const second = createStoredArtifact(store, owner.id);
  const { server, bearer } = await mediaServer(store);
  const bridge = auth(bearer);
  let foreignId: string | undefined;
  try {
    const a = await place(server.origin, bridge, concept.id, first.artifactId);
    const b = await place(server.origin, bridge, concept.id, second.artifactId);
    const p = await place(server.origin, bridge, portrait.id, first.artifactId);
    const foreign = await place(server.origin, bridge, borrowed.id, first.artifactId);
    foreignId = foreign.id;
    const before = await read<SlotDecisionState>(server.origin, bridge, `/api/slots/${concept.id}/decision`);
    assert.equal(before.selected, null);
    assert.equal((await read<AssetRecord>(server.origin, bridge, `/api/assets/${owner.id}`)).stage, null);
    assert.equal((await read<{ assetId: string }>(server.origin, bridge, `/api/artifacts/${first.artifactId}`)).assetId, owner.id);
    assert.deepEqual((await read<QueryPage<CandidateReviewDecision>>(server.origin, bridge,
      `/api/candidates/${a.id}/reviews`)).items, []);
    assert.equal((await change(server.origin, bridge, `/api/candidates/${a.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'approved' })).status, 400);
    assert.equal((await change(server.origin, bridge, `/api/slots/${concept.id}/selection`, 'PATCH',
      { expectedSlotRevision: 1, nextCandidateId: a.id, expectedCandidateRevision: 1 })).status, 400);
    assert.equal((await change(server.origin, bridge, `/api/assets/${owner.id}/stage`, 'PATCH',
      { expectedAssetRevision: 1, stage: 'Exploring' })).status, 400);
    const browser = await pair(server.origin, store.profilePath);
    const approved = await result<ReviewResult>(await change(server.origin, browser, `/api/candidates/${a.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'approved', rationale: 'Fits the Concept direction.' }));
    assert.equal(approved.decision.authority.channel, 'browser');
    assert.match(approved.decision.authority.instruction, /review candidate.*approved/);
    assert.equal(approved.decision.rationale, 'Fits the Concept direction.');
    assert.equal(approved.decision.previousState, 'unreviewed');
    assert.equal(approved.decision.actor, 'browser');
    await result<ReviewResult>(await change(server.origin, bridge, `/api/candidates/${b.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'approved', instruction }));
    await result<ReviewResult>(await change(server.origin, bridge, `/api/candidates/${p.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'rejected', instruction }));
    await result<ReviewResult>(await change(server.origin, bridge, `/api/candidates/${foreign.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'reviewed-undecided', instruction }));
    const candidates = await read<{ items: CandidateRecord[]; nextCursor: string | null; watermark: number }>(
      server.origin, bridge, `/api/slots/${concept.id}/candidates`);
    assert.deepEqual(candidates.items.map(candidate => candidate.reviewState), ['approved', 'approved']);
    assert.equal((await read<CandidateRecord>(server.origin, bridge, `/api/candidates/${p.id}`)).reviewState, 'rejected');
    assert.equal((await read<CandidateRecord>(server.origin, bridge, `/api/candidates/${foreign.id}`)).reviewState, 'reviewed-undecided');
    assert.equal((await read<{ assetId: string }>(server.origin, bridge, `/api/artifacts/${first.artifactId}`)).assetId, owner.id);
    const stage = await result<{ decision: AssetStageDecision }>(await change(server.origin, browser,
      `/api/assets/${owner.id}/stage`, 'PATCH', { expectedAssetRevision: 1, stage: 'Exploring' }));
    assert.deepEqual([stage.decision.previousStage, stage.decision.nextStage], [null, 'Exploring']);
    assert.equal(stage.decision.authority.channel, 'browser');
    await read<unknown>(server.origin, bridge, `/api/artifacts/${first.artifactId}/media`);
    assert.equal((await change(server.origin, bridge, `/api/assets/${owner.id}/stage`, 'PATCH',
      { expectedAssetRevision: 1, stage: 'Final', instruction })).status, 409);
    assert.equal((await change(server.origin, bridge, `/api/candidates/${a.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'rejected', instruction })).status, 409);
    await read<unknown>(server.origin, bridge, `/api/slots/${concept.id}/candidates`);
    assert.equal((await read<QueryPage<CandidateReviewDecision>>(server.origin, bridge,
      `/api/candidates/${a.id}/reviews`)).items.length, 1);
    assert.deepEqual((await read<QueryPage<SlotSelectionDecision>>(server.origin, bridge,
      `/api/slots/${concept.id}/selection-history`)).items, []);
    assert.equal((await read<SlotDecisionState>(server.origin, bridge, `/api/slots/${concept.id}/decision`)).selected, null);
    assert.equal((await read<QueryPage<AssetStageDecision>>(server.origin, bridge,
      `/api/assets/${owner.id}/stage-history`)).items.length, 1);
    assert.equal((await read<AssetRecord>(server.origin, bridge, `/api/assets/${owner.id}`)).stage, 'Exploring');
    const clearedStage = await result<{ decision: AssetStageDecision }>(await change(server.origin, bridge,
      `/api/assets/${owner.id}/stage`, 'PATCH', { expectedAssetRevision: 2, stage: null, instruction }));
    assert.deepEqual([clearedStage.decision.previousStage, clearedStage.decision.nextStage], ['Exploring', null]);
    assert.equal(clearedStage.decision.authority.channel, 'reported');
    assert.equal((await read<QueryPage<AssetStageDecision>>(server.origin, bridge,
      `/api/assets/${owner.id}/stage-history`)).items.length, 2);
  } finally { await server.close(); }
  store.reopen();
  assert.equal(store.catalog.getAsset(owner.id).stage, null);
  assert.equal(store.catalog.getAsset(borrower.id).stage, null);
  assert.ok(foreignId);
  assert.equal(store.catalog.getCandidate(foreignId).slotId, borrowed.id);
});

test('AE4/AE8: selected rejection keep, clear, replace are atomic; wrong-slot candidate and descendants stay intact', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'History' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const concept = store.catalog.createSlot(asset.id, { name: 'Concept' }, 'human');
  const other = store.catalog.createSlot(asset.id, { name: 'Portrait' }, 'human');
  const sprite = store.catalog.createSlot(asset.id, { name: 'Base sprite' }, 'human');
  const g003 = createStoredArtifact(store, asset.id).artifactId;
  const g005 = createStoredArtifact(store, asset.id).artifactId;
  const s004 = createStoredArtifact(store, asset.id).artifactId;
  const w002 = createStoredArtifact(store, asset.id).artifactId;
  const a006 = createStoredArtifact(store, asset.id).artifactId;
  store.lineage.addInputs(s004, [{ artifactId: g003 }], 'fixture');
  store.lineage.addInputs(w002, [{ artifactId: s004 }], 'fixture');
  store.lineage.addInputs(a006, [{ artifactId: w002 }], 'fixture');
  const { server, bearer } = await mediaServer(store);
  const headers = auth(bearer);
  let descendantId: string | undefined;
  try {
    const old = await place(server.origin, headers, concept.id, g003);
    const next = await place(server.origin, headers, concept.id, g005);
    const wrong = await place(server.origin, headers, other.id, g005);
    const descendant = await place(server.origin, headers, sprite.id, s004);
    descendantId = descendant.id;
    const descendantReview = await result<ReviewResult>(await change(server.origin, headers,
      `/api/candidates/${descendant.id}/review`, 'PATCH', { expectedCandidateRevision: 1, nextState: 'approved', instruction }));
    await result<SelectionResult>(await change(server.origin, headers, `/api/slots/${sprite.id}/selection`, 'PATCH',
      { expectedSlotRevision: 1, nextCandidateId: descendant.id, expectedCandidateRevision: 2, instruction }));
    const browser = await pair(server.origin, store.profilePath);
    const selected = await result<SelectionResult>(await change(server.origin, browser, `/api/slots/${concept.id}/selection`, 'PATCH',
      { expectedSlotRevision: 1, nextCandidateId: old.id, expectedCandidateRevision: 1 }));
    assert.equal(selected.selection.selected?.candidate.reviewState, 'unreviewed');
    assert.equal(selected.decision.authority.channel, 'browser');
    const missing = await change(server.origin, headers, `/api/candidates/${old.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'rejected', expectedSlotRevision: 2, instruction });
    assert.equal(missing.status, 400);
    const wrongSlot = await change(server.origin, headers, `/api/candidates/${old.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'rejected', expectedSlotRevision: 2,
        disposition: 'replace', replacementCandidateId: wrong.id, expectedReplacementCandidateRevision: 1, instruction });
    assert.equal(wrongSlot.status, 409);
    assert.equal((await read<CandidateRecord>(server.origin, headers, `/api/candidates/${old.id}`)).revision, 1);
    assert.equal((await read<SlotDecisionState>(server.origin, headers, `/api/slots/${concept.id}/decision`)).slot.revision, 2);
    assert.equal((await change(server.origin, headers, `/api/slots/${concept.id}/selection`, 'PATCH',
      { expectedSlotRevision: 1, nextCandidateId: next.id, expectedCandidateRevision: 1, instruction })).status, 409);
    assert.deepEqual((await read<QueryPage<CandidateReviewDecision>>(server.origin, headers,
      `/api/candidates/${old.id}/reviews`)).items, []);
    const keep = await result<ReviewResult>(await change(server.origin, headers, `/api/candidates/${old.id}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'rejected', expectedSlotRevision: 2, disposition: 'keep', instruction }));
    assert.equal(keep.selection?.slot.selectedCandidateId, old.id);
    assert.equal(keep.selection?.slot.revision, 2);
    assert.equal(keep.decision.selectionDisposition, 'keep');
    assert.equal(keep.selectionDecision, null);
    const cleared = await result<ReviewResult>(await change(server.origin, headers, `/api/candidates/${old.id}/review`, 'PATCH',
      { expectedCandidateRevision: 2, nextState: 'rejected', expectedSlotRevision: 2, disposition: 'clear', instruction }));
    assert.equal(cleared.selection?.selected, null);
    assert.equal(cleared.selection?.slot.revision, 3);
    assert.equal(cleared.selectionDecision?.auditEventId, cleared.decision.auditEventId);
    const again = await result<SelectionResult>(await change(server.origin, headers, `/api/slots/${concept.id}/selection`, 'PATCH',
      { expectedSlotRevision: 3, nextCandidateId: old.id, expectedCandidateRevision: 3, instruction }));
    assert.equal(again.selection.selected?.candidate.reviewState, 'rejected');
    const replaced = await result<ReviewResult>(await change(server.origin, headers, `/api/candidates/${old.id}/review`, 'PATCH',
      { expectedCandidateRevision: 3, nextState: 'rejected', expectedSlotRevision: 4,
        disposition: 'replace', replacementCandidateId: next.id, expectedReplacementCandidateRevision: 1, instruction }));
    assert.equal(replaced.selection?.slot.selectedCandidateId, next.id);
    assert.equal(replaced.selectionDecision?.auditEventId, replaced.decision.auditEventId);
    const reviews = (await read<QueryPage<CandidateReviewDecision>>(server.origin, headers,
      `/api/candidates/${old.id}/reviews`)).items;
    assert.deepEqual(reviews.map(review => review.selectionDisposition), ['keep', 'clear', 'replace']);
    const selections = (await read<QueryPage<SlotSelectionDecision>>(server.origin, headers,
      `/api/slots/${concept.id}/selection-history`)).items;
    assert.deepEqual(selections.map(selection => [selection.previous?.candidateId ?? null, selection.next?.candidateId ?? null]),
      [[null, old.id], [old.id, null], [null, old.id], [old.id, next.id]]);
    assert.deepEqual((await read<LineagePage>(server.origin, headers,
      `/api/queries/lineage/${g003}?direction=dependents`)).items.map(step => step.artifactId).sort(),
    [a006, g003, s004, w002].sort());
    assert.equal((await read<CandidateRecord>(server.origin, headers, `/api/candidates/${descendant.id}`)).reviewState, 'approved');
    assert.equal((await read<SlotDecisionState>(server.origin, headers, `/api/slots/${sprite.id}/decision`)).slot.selectedCandidateId,
      descendant.id);
    assert.equal(descendantReview.decision.revision, 2);
  } finally { await server.close(); }
  store.reopen();
  assert.equal(store.lineage.listInputs(s004, { limit: 20 }).items[0]!.input.artifactId, g003);
  assert.ok(descendantId);
  assert.equal(store.catalog.getSlot(sprite.id).selectedCandidateId, descendantId);
});

test('AE14: clip decision pins observed playback while current selection follows corrections and production input stays pinned', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Frames' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight walk' }, 'human');
  const slot = store.catalog.createSlot(asset.id, { name: 'Walk / north' }, 'human');
  const { server, bearer } = await mediaServer(store);
  const headers = auth(bearer);
  const geometry = { kind: 'grid' as const, memberOrdinal: 0, cellWidth: 2, cellHeight: 2, columns: 4, rows: 2 };
  let candidateId: string | undefined;
  try {
    const image = await captureFixtures(server, bearer, project.id, asset.id, ['eight-cell-grid.png']);
    const clip = await result<ClipRecord>(await change(server.origin, headers, `/api/artifacts/${image}/clips`, 'POST', {
      name: 'Walk', geometry, frames: [0, 1, 2, 3], durationsMs: [125, 125, 125, 125], source: { kind: 'human' },
    }), 201);
    const candidate = await place(server.origin, headers, slot.id, image, clip.id);
    candidateId = candidate.id;
    assert.equal((await change(server.origin, headers, `/api/slots/${slot.id}/selection`, 'PATCH',
      { expectedSlotRevision: 1, nextCandidateId: candidate.id, expectedCandidateRevision: 1, instruction })).status, 400);
    const selected = await result<SelectionResult>(await change(server.origin, headers, `/api/slots/${slot.id}/selection`, 'PATCH', {
      expectedSlotRevision: 1, nextCandidateId: candidate.id, expectedCandidateRevision: 1,
      observedPlaybackRevisionId: clip.current.id, instruction,
    }));
    assert.equal(selected.decision.next?.playbackRevisionId, clip.current.id);
    assert.equal(selected.selection.selected?.playback?.cycleMs, 500);
    const output = await captureFixtures(server, bearer, project.id, asset.id, ['sequence-0.png']);
    await result<unknown>(await change(server.origin, headers, `/api/artifacts/${output}/inputs`, 'POST', {
      inputs: [{ artifactId: image, clipId: clip.id, playbackRevisionId: clip.current.id, role: 'source animation' }],
    }), 201);
    const correction = await result<ClipRecord>(await change(server.origin, headers, `/api/clips/${clip.id}`, 'PATCH', {
      expectedRevision: 1, geometry, frames: [3, 2, 1, 0], durationsMs: [200, 200, 200, 200], source: { kind: 'human' },
    }));
    const live = await read<SlotDecisionState>(server.origin, headers, `/api/slots/${slot.id}/decision`);
    assert.equal(live.slot.revision, 2);
    assert.equal(live.selected?.playback?.id, correction.current.id);
    assert.equal(live.selected?.playback?.cycleMs, 800);
    const history = (await read<QueryPage<SlotSelectionDecision>>(server.origin, headers,
      `/api/slots/${slot.id}/selection-history`)).items;
    assert.equal(history[0]?.next?.playbackRevisionId, clip.current.id);
    const oldRevision = await read<PlaybackRevision>(server.origin, headers, `/api/playback-revisions/${clip.current.id}`);
    assert.equal(oldRevision.cycleMs, 500);
    const inputs = await read<QueryPage<InputEdgeRecord>>(server.origin, headers, `/api/artifacts/${output}/inputs?limit=1`);
    assert.equal(inputs.nextCursor, null);
    const inputHistory = await read<QueryPage<InputEdgeRevision>>(server.origin, headers,
      `/api/inputs/${inputs.items[0]!.edgeId}/history?limit=1`);
    assert.equal(inputHistory.items[0]!.input.playbackRevisionId, oldRevision.id);
    assert.equal(inputHistory.nextCursor, null);
    const stale = await change(server.origin, headers, `/api/candidates/${candidate.id}/review`, 'PATCH', {
      expectedCandidateRevision: 1, nextState: 'approved', observedPlaybackRevisionId: oldRevision.id, instruction,
    });
    assert.equal(stale.status, 409);
    assert.equal((await change(server.origin, headers, `/api/slots/${slot.id}/selection`, 'PATCH', {
      expectedSlotRevision: 2, nextCandidateId: null, observedPreviousPlaybackRevisionId: oldRevision.id, instruction,
    })).status, 409);
    assert.equal((await read<CandidateRecord>(server.origin, headers, `/api/candidates/${candidate.id}`)).reviewState, 'unreviewed');
    const currentDecision = await result<ReviewResult>(await change(server.origin, headers, `/api/candidates/${candidate.id}/review`, 'PATCH', {
      expectedCandidateRevision: 1, nextState: 'approved', observedPlaybackRevisionId: correction.current.id, instruction,
    }));
    assert.equal(currentDecision.decision.playbackRevisionId, correction.current.id);
    assert.equal((await read<QueryPage<SlotSelectionDecision>>(server.origin, headers,
      `/api/slots/${slot.id}/selection-history`)).items.length, 1);
  } finally { await server.close(); }
  store.reopen();
  assert.ok(candidateId);
  assert.equal(store.catalog.getSlot(slot.id).selectedCandidateId, candidateId);
});

test('mixed browser/bridge commands from one revision commit once; loser retains no authority or watermark event', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Concurrency' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const slot = store.catalog.createSlot(asset.id, { name: 'Concept' }, 'human');
  const image = createStoredArtifact(store, asset.id).artifactId;
  const { server, bearer } = await mediaServer(store);
  let before: number;
  let candidateId: string;
  try {
    const bridge = auth(bearer);
    const candidate = await place(server.origin, bridge, slot.id, image);
    candidateId = candidate.id;
    const browser = await pair(server.origin, store.profilePath);
    const first = { expectedCandidateRevision: 1, nextState: 'approved' };
    const [ui, agent] = await Promise.all([
      change(server.origin, browser, `/api/candidates/${candidate.id}/review`, 'PATCH', first),
      change(server.origin, bridge, `/api/candidates/${candidate.id}/review`, 'PATCH',
        { expectedCandidateRevision: 1, nextState: 'rejected', instruction }),
    ]);
    assert.deepEqual([ui.status, agent.status].sort(), [200, 409]);
    const review = (await read<QueryPage<CandidateReviewDecision>>(server.origin, bridge,
      `/api/candidates/${candidate.id}/reviews`)).items;
    assert.equal(review.length, 1);
    assert.equal(review[0]!.nextState, ui.status === 200 ? 'approved' : 'rejected');
    assert.equal(review[0]!.authority.channel, ui.status === 200 ? 'browser' : 'reported');
    assert.equal((await read<CandidateRecord>(server.origin, bridge, `/api/candidates/${candidate.id}`)).revision, 2);
    assert.equal((await read<SlotDecisionState>(server.origin, bridge, `/api/slots/${slot.id}/decision`)).slot.revision, 1);
    before = review[0]!.auditEventId;
  } finally { await server.close(); }
  store.reopen();
  assert.equal(store.database.watermark, before!);
  const authorities = store.database.connection.prepare('SELECT COUNT(*) AS count FROM authorities').get() as { count: number };
  assert.equal(authorities.count, 1);
  assert.equal(store.catalog.getCandidate(candidateId!).revision, 2);
  assert.throws(() => store.database.connection.prepare('UPDATE candidate_reviews SET next_state = ? WHERE candidate_id = ?')
    .run('approved', candidateId!), /candidate review history is immutable/);
});
