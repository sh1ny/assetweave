import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ContextItem, ContextQuery, ContextResult, TextExcerpt } from '@assetweave/contracts/queries';
import { ContextService } from '../src/queries/context.service.js';
import { auth, mediaServer } from './helpers/media-fixture.js';
import { createClipRevision, createStore, createStoredArtifact } from './helpers/store-fixture.js';

const skip = process.platform !== 'win32';
const record = <T>(item: ContextItem): T => item.record as T;
const context = (service: ContextService, assetId: string, extra: Partial<ContextQuery> = {}): ContextResult =>
  service.context({ assetId, limit: 20, ...extra });

// Read through the actual persisted catalog; no fabricated artifact/provenance rows.
test('context keeps an unselected target and explicit source distinct, with captured ownership and actual provenance', { skip }, t => {
  const store = createStore(t);
  const targetProject = store.catalog.createProject({ name: 'Targets', notes: 'target project' }, 'human');
  const originalProject = store.catalog.createProject({ name: 'Originals' }, 'human');
  const targetAsset = store.catalog.createAsset(targetProject.id, { name: 'Hero', notes: 'target asset' }, 'human');
  const originalAsset = store.catalog.createAsset(originalProject.id, { name: 'Sketchbook' }, 'human');
  const slot = store.catalog.createSlot(targetAsset.id, { name: 'Ａrt   Pose', notes: 'target slot' }, 'human');
  const proposed = createStoredArtifact(store, originalAsset.id);
  const actual = createStoredArtifact(store, targetAsset.id);
  const request = store.requests.createRequest(originalProject.id, originalAsset.id,
    { intent: 'Prepare a sketch', proposedInputs: [{ artifactId: proposed.artifactId, role: 'proposal only' }] }, 'agent');
  store.requests.reportOutcome(request.id, { expectedRevision: 0, status: 'failed',
    notes: 'Outcome observation '.repeat(45) }, 'agent');
  const source = createStoredArtifact(store, originalAsset.id, { requestId: request.id });
  store.catalog.placeCandidate(slot.id, { artifactId: source.artifactId }, 'agent');
  store.provenance.addClaims(source.artifactId, [
    { field: 'parameters', state: 'known', value: { options: { long: 'p'.repeat(800) } }, source: { kind: 'producer' } },
    { field: 'seed', state: 'unknown', source: { kind: 'artist', detail: 'not supplied' } },
    { field: 'negativePrompt', state: 'absent', source: { kind: 'artist' } },
  ], 'agent');
  store.lineage.addInputs(source.artifactId, [{ artifactId: actual.artifactId, role: 'actual captured input' }], 'agent');
  store.lineage.addGaps(source.artifactId, [{ kind: 'upstream', description: 'unknown source', sourceKind: 'reported' }], 'agent');
  store.reopen();

  const service = new ContextService(store.database);
  const unselected = context(service, targetAsset.id, { sourceArtifactId: source.artifactId });
  assert.equal(unselected.targetSlot, null);
  assert.deepEqual(unselected.alternatives.map(row => [row.id, row.url]), [[slot.id, `/api/slots/${slot.id}`]]);
  assert.deepEqual(unselected.sections.candidates.items, []);
  assert.deepEqual(unselected.sections.artifacts.items.map(row => row.id), [source.artifactId]);
  const targeted = context(service, targetAsset.id, { slotName: 'Art Pose', sourceArtifactId: source.artifactId });
  assert.equal(targeted.targetSlot?.id, slot.id);
  assert.equal(targeted.targetSlot?.selectedCandidateId, null);
  assert.equal(targeted.explicitSource?.id, source.artifactId);
  const candidate = record<{ placement: { slotId: string }; originalOwner: { projectId: string; assetName: string } }>(
    targeted.sections.candidates.items[0]!);
  assert.equal(candidate.placement.slotId, slot.id);
  assert.equal(candidate.originalOwner.projectId, originalProject.id);
  assert.equal(candidate.originalOwner.assetName, originalAsset.name);
  const claims = targeted.sections.claims.items.map(item => record<{
    field: string; state: string; valueJson: TextExcerpt | null;
  }>(item));
  assert.equal(claims.find(row => row.field === 'seed')?.state, 'unknown');
  assert.equal(claims.find(row => row.field === 'negativePrompt')?.state, 'absent');
  assert.equal(claims.find(row => row.field === 'prompt')?.state, 'not-recorded');
  assert.equal(claims.find(row => row.field === 'parameters')?.valueJson?.truncated, true);
  assert.equal(claims.find(row => row.field === 'parameters')?.valueJson?.fullRecordUrl.startsWith('/api/assertions/'), true);
  const input = record<{ inputArtifactId: string; kind: string }>(targeted.sections.inputs.items[0]!);
  assert.equal(input.inputArtifactId, actual.artifactId);
  assert.equal(input.kind, 'actual-input');
  const relatedRequest = record<{ proposedInputs: { artifactId: string }[];
    outcome: { status: string; notes: TextExcerpt };
    actualInputsForRelevantArtifacts: { artifactId: string; inputsUrl: string; gapsUrl: string }[] }>(
    targeted.sections.requests.items[0]!);
  assert.equal(relatedRequest.outcome.status, 'failed');
  assert.equal(relatedRequest.outcome.notes.truncated, true);
  assert.deepEqual(relatedRequest.proposedInputs.map(row => row.artifactId), [proposed.artifactId]);
  assert.deepEqual(relatedRequest.actualInputsForRelevantArtifacts,
    [{ artifactId: source.artifactId, inputsUrl: `/api/artifacts/${source.artifactId}/inputs`,
      gapsUrl: `/api/artifacts/${source.artifactId}/gaps` }]);
});

test('ambiguous project or asset names raise 409 with bounded explicit ID alternatives', { skip }, t => {
  const store = createStore(t);
  const first = store.catalog.createProject({ name: 'Shared' }, 'human');
  const second = store.catalog.createProject({ name: 'Shared' }, 'human');
  const a = store.catalog.createAsset(first.id, { name: 'Hero' }, 'human');
  const b = store.catalog.createAsset(first.id, { name: 'Hero' }, 'human');
  store.catalog.createAsset(second.id, { name: 'Hero' }, 'human');
  const service = new ContextService(store.database);
  const verifyAlternatives = (call: () => unknown, expected: { id: string; url: string }[]) => {
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      const response: unknown = error.getResponse();
      assert.ok(response && typeof response === 'object' && 'alternatives' in response &&
        Array.isArray(response.alternatives));
      const alternatives = response.alternatives.map((item: unknown) => {
        assert.ok(item && typeof item === 'object' && 'id' in item && 'url' in item &&
          typeof item.id === 'string' && typeof item.url === 'string');
        return [item.id, item.url];
      });
      assert.deepEqual(alternatives.sort(), expected.map(item => [item.id, item.url]).sort());
      return true;
    });
  };
  verifyAlternatives(() => context(service, a.id, { projectName: 'Shared' }),
    [{ id: first.id, url: `/api/projects/${first.id}` }, { id: second.id, url: `/api/projects/${second.id}` }]);
  verifyAlternatives(() => service.context({ projectId: first.id, assetName: 'Hero', limit: 20 }),
    [{ id: a.id, url: `/api/assets/${a.id}` }, { id: b.id, url: `/api/assets/${b.id}` }]);
  for (let index = 0; index < 50; index++) store.catalog.createProject({ name: 'Shared' }, 'human');
  assert.throws(() => context(service, a.id, { projectName: 'Shared' }), (error: unknown) => {
    assert.ok(error instanceof ConflictException);
    const response: unknown = error.getResponse();
    assert.ok(response && typeof response === 'object' && 'alternatives' in response &&
      Array.isArray(response.alternatives) && 'alternativesTruncated' in response);
    assert.equal(response.alternatives.length, 50);
    assert.equal(response.alternativesTruncated, true);
    assert.ok('alternativesUrl' in response);
    assert.equal(response.alternativesUrl, '/api/projects?limit=50');
    return true;
  });
  assert.throws(() => context(service, a.id, { sourceArtifactId: randomUUID() }), NotFoundException);
  const foreignSlot = store.catalog.createSlot(b.id, { name: 'Alt' }, 'human');
  assert.throws(() => context(service, a.id, { slotId: foreignSlot.id }), BadRequestException);
});

test('all context categories use independent bounded continuations and note excerpts stay linked', { skip }, t => {
  const store = createStore(t);
  const long = 'q'.repeat(1_100);
  const project = store.catalog.createProject({ name: 'Scenes', notes: long }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Trees', notes: long }, 'human');
  const firstSlot = store.catalog.createSlot(asset.id, { name: 'Slot 00', notes: long }, 'human');
  for (let index = 1; index < 52; index++) {
    store.catalog.createSlot(asset.id, { name: `Slot ${String(index).padStart(2, '0')}` }, 'human');
  }
  const reference = createStoredArtifact(store, asset.id);
  const source = createStoredArtifact(store, asset.id);
  store.provenance.addClaims(source.artifactId, Array.from({ length: 52 }, (_, index) => ({
    field: `extra-${String(index).padStart(2, '0')}`, state: 'known' as const,
    value: { prompt: long }, source: { kind: 'producer', detail: long },
  })), 'agent');
  store.lineage.addGaps(source.artifactId, Array.from({ length: 52 }, () => ({
    kind: 'upstream' as const, description: long, sourceKind: 'reported',
  })), 'agent');
  store.lineage.addInputs(source.artifactId, Array.from({ length: 3 }, (_, index) => ({
    artifactId: reference.artifactId, role: `actual ${index}`,
  })), 'agent');
  for (let index = 0; index < 3; index++) {
    store.requests.createRequest(project.id, asset.id,
      { intent: long, notes: long, proposedInputs: [{ artifactId: reference.artifactId }] }, 'agent');
  }
  store.reopen();
  const service = new ContextService(store.database);
  const first = context(service, asset.id, { sourceArtifactId: source.artifactId, limit: 50 });
  assert.equal(first.project.notes.truncated, true);
  assert.equal(first.project.notes.fullRecordUrl, `/api/projects/${project.id}`);
  assert.equal(first.asset.notes.truncated, true);
  assert.equal(first.sections.slots.items.length, 50);
  assert.equal(first.sections.slots.truncated, true);
  assert.equal(first.sections.claims.truncated, true);
  assert.equal(first.sections.gaps.truncated, true);
  const remainder = context(service, asset.id, { sourceArtifactId: source.artifactId, limit: 50,
    section: 'slots', cursor: first.sections.slots.nextCursor! });
  assert.equal(remainder.sections.slots.items.length, 2);
  assert.equal(remainder.sections.slots.truncated, false);
  assert.equal(remainder.alternatives.length, 50);
  const seen = new Set(first.sections.slots.items.concat(remainder.sections.slots.items).map(item => item.id));
  assert.equal(seen.size, 52);
  for (const section of ['claims', 'gaps'] as const) {
    const page = context(service, asset.id, { sourceArtifactId: source.artifactId, limit: 50,
      section, cursor: first.sections[section].nextCursor! });
    assert.equal(page.sections[section].nextCursor, null);
    assert.ok(page.sections[section].items.length > 0);
    assert.equal(new Set(first.sections[section].items.concat(page.sections[section].items)
      .map(item => item.id)).size, first.sections[section].items.length + page.sections[section].items.length);
  }
  const detailed = context(service, asset.id, { sourceArtifactId: source.artifactId, slotId: firstSlot.id, limit: 1 });
  assert.equal(detailed.targetSlot?.notes.truncated, true);
  assert.equal(detailed.sections.inputs.truncated, true);
  assert.equal(detailed.sections.requests.truncated, true);
  const request = record<{ intent: TextExcerpt; notes: TextExcerpt; proposedInputCount: number }>(
    detailed.sections.requests.items[0]!);
  assert.equal(request.intent.truncated, true);
  assert.equal(request.notes.truncated, true);
  assert.equal(request.proposedInputCount, 1);
  const gap = record<{ description: TextExcerpt }>(detailed.sections.gaps.items[0]!);
  assert.equal(gap.description.truncated, true);
  for (const section of ['inputs', 'requests'] as const) {
    const next = context(service, asset.id, { sourceArtifactId: source.artifactId, slotId: firstSlot.id,
      limit: 1, section, cursor: detailed.sections[section].nextCursor! });
    assert.notEqual(next.sections[section].items[0]?.id, detailed.sections[section].items[0]?.id);
  }
});

test('selected named clip points to its current revision without rewriting its earlier selection', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Actors' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const slot = store.catalog.createSlot(asset.id, { name: 'Idle' }, 'human');
  const captured = createStoredArtifact(store, asset.id);
  const firstClip = createClipRevision(store, captured.artifactId, { name: 'Breathing' });
  const candidate = store.catalog.placeCandidate(slot.id,
    { artifactId: captured.artifactId, clipId: firstClip.clipId }, 'agent');
  const { server, bearer } = await mediaServer(store);
  try {
    const response = await fetch(`${server.origin}/api/slots/${slot.id}/selection`, {
      method: 'PATCH', headers: { ...auth(bearer), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedSlotRevision: 1, nextCandidateId: candidate.id,
        expectedCandidateRevision: 1, observedPlaybackRevisionId: firstClip.revisionId,
        instruction: 'Select the Breathing clip for the idle slot.' }),
    });
    assert.equal(response.status, 200, await response.text());
  } finally { await server.close(); }
  store.reopen();
  const secondClip = createClipRevision(store, captured.artifactId, { clipId: firstClip.clipId });
  const result = context(new ContextService(store.database), asset.id, { slotId: slot.id });
  assert.equal(result.targetSlot?.selectedCandidateId, candidate.id);
  const selected = record<{ selected: { clip: { currentRevisionId: string; currentRevisionUrl: string } }; selectionHistoryUrl: string }>(
    result.sections.slots.items[0]!);
  assert.equal(selected.selected.clip.currentRevisionId, secondClip.revisionId);
  assert.equal(selected.selected.clip.currentRevisionUrl, `/api/playback-revisions/${secondClip.revisionId}`);
  assert.equal(selected.selectionHistoryUrl, `/api/slots/${slot.id}/selection-history`);
  assert.equal(result.sections.artifacts.items[0]?.id, captured.artifactId);
  assert.equal(record<{ selectionState: string }>(result.sections.candidates.items[0]!).selectionState,
    'currently-selected');
  assert.equal(result.explicitSource, null);
});

test('unselected target still pages every asset slot selection and its provenance, including foreign ownership', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Atlas' }, 'human');
  const foreignProject = store.catalog.createProject({ name: 'Sketches' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Dragon' }, 'human');
  const foreignAsset = store.catalog.createAsset(foreignProject.id, { name: 'Study sheet' }, 'human');
  const target = store.catalog.createSlot(asset.id, { name: 'Slot 00' }, 'human');
  const firstSlot = store.catalog.createSlot(asset.id, { name: 'Slot 01' }, 'human');
  for (let index = 2; index < 53; index++) {
    store.catalog.createSlot(asset.id, { name: `Slot ${String(index).padStart(2, '0')}` }, 'human');
  }
  const lastSlot = store.catalog.createSlot(asset.id, { name: 'Slot 53' }, 'human');
  const input = createStoredArtifact(store, foreignAsset.id);
  const first = createStoredArtifact(store, asset.id);
  const request = store.requests.createRequest(foreignProject.id, foreignAsset.id,
    { intent: 'Develop the silhouette', proposedInputs: [{ artifactId: input.artifactId }] }, 'agent');
  const second = createStoredArtifact(store, foreignAsset.id, { requestId: request.id });
  store.provenance.addClaims(first.artifactId,
    [{ field: 'seed', state: 'unknown', source: { kind: 'artist' } }], 'agent');
  store.provenance.addClaims(second.artifactId,
    [{ field: 'prompt', state: 'known', value: 'manual sketch', source: { kind: 'artist' } }], 'agent');
  store.lineage.addInputs(second.artifactId, [{ artifactId: input.artifactId, role: 'recorded starting image' }], 'agent');
  store.lineage.addGaps(second.artifactId,
    [{ kind: 'upstream', description: 'Earlier studies not known', sourceKind: 'reported' }], 'agent');
  const placedFirst = store.catalog.placeCandidate(firstSlot.id, { artifactId: first.artifactId }, 'agent');
  const placedLast = store.catalog.placeCandidate(lastSlot.id, { artifactId: second.artifactId }, 'agent');
  const { server, bearer } = await mediaServer(store);
  const long = 'Artist instruction '.repeat(45);
  const send = async (path: string, body: unknown) => {
    const response = await fetch(`${server.origin}${path}`, { method: 'PATCH',
      headers: { ...auth(bearer), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  };
  try {
    await send(`/api/candidates/${placedFirst.id}/review`,
      { expectedCandidateRevision: 1, nextState: 'approved', instruction: long, rationale: long });
    await send(`/api/slots/${firstSlot.id}/selection`, { expectedSlotRevision: 1,
      nextCandidateId: placedFirst.id, expectedCandidateRevision: 2, instruction: long, rationale: long });
    await send(`/api/slots/${lastSlot.id}/selection`, { expectedSlotRevision: 1,
      nextCandidateId: placedLast.id, expectedCandidateRevision: 1, instruction: 'Select the study sheet.' });
  } finally { await server.close(); }
  store.reopen();
  const service = new ContextService(store.database);
  const overview = context(service, asset.id, { limit: 50 });
  assert.equal(overview.targetSlot, null);
  assert.deepEqual(new Set(overview.sections.artifacts.items.map(item => item.id)),
    new Set([first.artifactId, second.artifactId]));
  const task = context(service, asset.id, { slotId: target.id, limit: 1 });
  assert.equal(task.targetSlot?.selectedCandidateId, null);
  assert.deepEqual(task.sections.candidates.items, []);
  assert.equal(record<{ latestSelectionDecision: unknown }>(task.sections.slots.items[0]!).latestSelectionDecision, null);
  const artifacts = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ContextResult = context(service, asset.id, { slotId: target.id, limit: 1,
      ...(cursor ? { section: 'artifacts', cursor } : {}) });
    for (const item of page.sections.artifacts.items) artifacts.add(item.id);
    cursor = page.sections.artifacts.nextCursor;
  } while (cursor);
  assert.deepEqual(artifacts, new Set([first.artifactId, second.artifactId]));
  const largePage = context(service, asset.id, { slotId: target.id, limit: 50 });
  assert.equal(largePage.sections.slots.items.length, 50);
  assert.equal(largePage.sections.slots.truncated, true);
  const lastPage = context(service, asset.id, { slotId: target.id, limit: 50,
    section: 'slots', cursor: largePage.sections.slots.nextCursor! });
  const lastSelection = record<{ latestSelectionDecision: { next: { candidateId: string };
    authority: { instruction: TextExcerpt } } }>(
    lastPage.sections.slots.items.find(item => item.id === lastSlot.id)!);
  assert.equal(lastSelection.latestSelectionDecision.next.candidateId, placedLast.id);
  assert.equal(lastSelection.latestSelectionDecision.authority.instruction.value, 'Select the study sheet.');
  const firstSelection = record<{ latestSelectionDecision: { previous: unknown;
    next: { candidateId: string; artifactId: string }; actor: string; at: string;
    authority: { instruction: TextExcerpt }; rationale: TextExcerpt } }>(
    largePage.sections.slots.items.find(item => item.id === firstSlot.id)!);
  assert.equal(firstSelection.latestSelectionDecision.previous, null);
  assert.equal(firstSelection.latestSelectionDecision.next.candidateId, placedFirst.id);
  assert.equal(firstSelection.latestSelectionDecision.next.artifactId, first.artifactId);
  assert.equal(firstSelection.latestSelectionDecision.actor, 'bridge');
  assert.ok(firstSelection.latestSelectionDecision.at);
  assert.equal(firstSelection.latestSelectionDecision.authority.instruction.truncated, true);
  assert.equal(firstSelection.latestSelectionDecision.rationale.truncated, true);
  assert.equal(firstSelection.latestSelectionDecision.rationale.fullRecordUrl,
    `/api/slots/${firstSlot.id}/selection-history`);
  const review = context(service, asset.id, { slotId: firstSlot.id });
  const reviewDecision = record<{ latestReviewDecision: { previousState: string; nextState: string;
    actor: string; authority: { instruction: TextExcerpt }; rationale: TextExcerpt } }>(
    review.sections.candidates.items[0]!).latestReviewDecision;
  assert.equal(reviewDecision.previousState, 'unreviewed');
  assert.equal(reviewDecision.nextState, 'approved');
  assert.equal(reviewDecision.actor, 'bridge');
  assert.equal(reviewDecision.authority.instruction.truncated, true);
  assert.equal(reviewDecision.rationale.fullRecordUrl, `/api/candidates/${placedFirst.id}/reviews`);
  const foreignCandidate = record<{ latestReviewDecision: unknown;
    placement: { slotId: string }; originalOwner: { assetId: string } }>(
    context(service, asset.id, { slotId: lastSlot.id }).sections.candidates.items[0]!);
  assert.equal(foreignCandidate.latestReviewDecision, null);
  assert.equal(foreignCandidate.placement.slotId, lastSlot.id);
  assert.equal(foreignCandidate.originalOwner.assetId, foreignAsset.id);
  const claims = largePage.sections.claims.items.map(item => record<{ artifactId: string; field: string; state: string }>(item));
  assert.ok(claims.some(row => row.artifactId === first.artifactId && row.field === 'seed' && row.state === 'unknown'));
  assert.ok(claims.some(row => row.artifactId === second.artifactId && row.field === 'prompt' && row.state === 'known'));
  assert.equal(record<{ outputArtifactId: string }>(largePage.sections.inputs.items[0]!).outputArtifactId, second.artifactId);
  assert.equal(record<{ outputArtifactId: string }>(largePage.sections.gaps.items[0]!).outputArtifactId, second.artifactId);
  assert.ok(largePage.sections.requests.items.some(item => item.id === request.id));
});
