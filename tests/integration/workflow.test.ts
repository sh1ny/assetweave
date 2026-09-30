import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Client } from '@modelcontextprotocol/client';
import type { AssetRecord, CandidateRecord, ProjectRecord, SlotRecord } from '@assetweave/contracts/catalog';
import type { CaptureRecord, CaptureReceipt } from '@assetweave/contracts/capture';
import type { ReviewResult, SelectionResult, SlotDecisionState } from '@assetweave/contracts/decisions';
import type { ContextResult, LineagePage, QueryPage, SearchHit } from '@assetweave/contracts/queries';
import type { InputEdgeRecord, RequestRecord } from '@assetweave/contracts/production';
import { fixture, http, mediaFile, tool, windowsOnly } from './fixture.js';

async function capture(client: Client, projectId: string, assetId: string, name: string,
  extra: Record<string, unknown> = {}): Promise<CaptureRecord> {
  const { artifact, receipt } = await tool<{ artifact: CaptureRecord | null; receipt: CaptureReceipt }>(client, 'capture_files', {
    operationId: randomUUID(), projectId, assetId, kind: 'png', name,
    files: [{ path: mediaFile('bounded-sequence-0.png'), sourceName: `${name}.png` }], ...extra,
  });
  assert.equal(receipt.status, 'committed');
  assert.ok(artifact);
  assert.equal(artifact.content, 'available');
  return artifact;
}

// The only images are synthetic local fixtures: no producer is configured or called.
test('HTTP browser decisions and real stdio MCP share independent review, selection, request and branch history',
  { skip: windowsOnly, timeout: 300_000 }, async t => {
    const f = fixture(t);
    const service = await f.start();
    const client = await f.client();
    const browser = await f.browserHeaders(service);
    const project = await tool<ProjectRecord>(client, 'catalog_create_project', { name: 'Knight', notes: 'Synthetic test project' });
    const knight = await http<AssetRecord>(service, browser, `/api/projects/${project.id}/assets`, 'POST', { name: 'Knight' });
    const concept = await tool<SlotRecord>(client, 'catalog_create_slot', { assetId: knight.id, name: 'Concept' });
    const portrait = await tool<SlotRecord>(client, 'catalog_create_slot', { assetId: knight.id, name: 'Portrait' });
    const attack = await tool<SlotRecord>(client, 'catalog_create_slot', { assetId: knight.id, name: 'Attack' });
    const helmetAsset = await tool<AssetRecord>(client, 'catalog_create_asset', { projectId: project.id, name: 'Helmet' });
    const swordAsset = await tool<AssetRecord>(client, 'catalog_create_asset', { projectId: project.id, name: 'Sword' });
    const swordSlot = await tool<SlotRecord>(client, 'catalog_create_slot', { assetId: swordAsset.id, name: 'Direction' });

    const original = await capture(client, project.id, knight.id, 'Old concept', { slotId: concept.id,
      claims: [{ field: 'productionTime', state: 'unknown', source: { kind: 'human report', detail: 'Date not retained.' } }],
      gaps: [{ kind: 'upstream', description: 'Original rough sketch is not available', sourceKind: 'human report' }],
    });
    const newer = await capture(client, project.id, knight.id, 'New concept', { slotId: concept.id });
    const helmet = await capture(client, project.id, helmetAsset.id, 'Helmet reference');
    const sword = await capture(client, project.id, swordAsset.id, 'Rejected sword', { slotId: swordSlot.id });
    assert.ok(original.candidateId && newer.candidateId && sword.candidateId);
    const portraitPlacement = await http<CandidateRecord>(service, browser, `/api/slots/${portrait.id}/candidates`, 'POST',
      { artifactId: original.id });

    const originalReview = await http<ReviewResult>(service, browser,
      `/api/candidates/${original.candidateId}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'approved', rationale: 'Keep as a usable historical direction.' });
    await tool<ReviewResult>(client, 'decisions_review', { candidateId: newer.candidateId,
      expectedCandidateRevision: 1, nextState: 'approved', instruction: 'Approve the alternate Concept artwork.' });
    await tool<ReviewResult>(client, 'decisions_review', { candidateId: portraitPlacement.id,
      expectedCandidateRevision: 1, nextState: 'rejected', instruction: 'Reject this placement for Portrait, not for Concept.' });
    await http<ReviewResult>(service, browser, `/api/candidates/${sword.candidateId}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'rejected' });
    const oldChoice = await http<SelectionResult>(service, browser, `/api/slots/${concept.id}/selection`, 'PATCH',
      { expectedSlotRevision: concept.revision, nextCandidateId: original.candidateId,
        expectedCandidateRevision: originalReview.candidate.revision });
    assert.equal(oldChoice.decision.next?.artifactId, original.id);
    const stage = await http<{ asset: AssetRecord }>(service, browser, `/api/assets/${knight.id}/stage`, 'PATCH',
      { expectedAssetRevision: knight.revision, stage: 'Exploring' });
    assert.equal(stage.asset.stage, 'Exploring');

    const managed = await tool<RequestRecord>(client, 'requests_create', { projectId: project.id, assetId: knight.id,
      slotId: attack.id, intent: 'Explore a new attack animation without presuming a successful external result',
      proposedInputs: [{ artifactId: newer.id, role: 'suggested concept' }],
    });
    const pending = await tool<RequestRecord>(client, 'requests_create', { projectId: project.id, assetId: knight.id,
      slotId: attack.id, intent: 'A separate request whose production was not reported' });
    assert.equal(managed.outcome.status, 'unknown');
    assert.equal(pending.outcome.status, 'unknown');
    const oldAttack = await capture(client, project.id, knight.id, 'Old attack', { slotId: attack.id, requestId: managed.id,
      inputs: [{ artifactId: original.id, role: 'base concept' },
        { artifactId: helmet.id, role: 'helmet reference' }, { artifactId: sword.id }],
      claims: [{ field: 'seed', state: 'unknown', source: { kind: 'human report', detail: 'Not supplied.' } }],
    });
    const newAttack = await capture(client, project.id, knight.id, 'New attack', { slotId: attack.id,
      inputs: [{ artifactId: newer.id, role: 'alternative base' }],
    });
    const walk = await capture(client, project.id, knight.id, 'Walk branch', {
      inputs: [{ artifactId: original.id, role: 'old concept reuse' }],
    });
    assert.ok(oldAttack.candidateId && newAttack.candidateId);
    const approvedAttack = await http<ReviewResult>(service, browser,
      `/api/candidates/${oldAttack.candidateId}/review`, 'PATCH',
      { expectedCandidateRevision: 1, nextState: 'approved' });
    assert.equal(approvedAttack.candidate.reviewState, 'approved');
    assert.equal((await tool<CandidateRecord>(client, 'catalog_candidate', { candidateId: newAttack.candidateId })).reviewState,
      'unreviewed');
    assert.equal((await tool<SlotDecisionState>(client, 'decisions_slot', { slotId: attack.id })).selected, null);

    const nextChoice = await tool<SelectionResult>(client, 'decisions_select', { slotId: concept.id,
      expectedSlotRevision: oldChoice.selection.slot.revision, nextCandidateId: newer.candidateId,
      expectedCandidateRevision: 2, instruction: 'Replace the Concept working selection with the newer approved direction.' });
    assert.equal(nextChoice.decision.previous?.artifactId, original.id);
    assert.equal(nextChoice.decision.next?.artifactId, newer.id);
    assert.equal((await tool<CandidateRecord>(client, 'catalog_candidate', { candidateId: original.candidateId })).reviewState,
      'approved');
    assert.equal((await tool<CandidateRecord>(client, 'catalog_candidate', { candidateId: portraitPlacement.id })).reviewState,
      'rejected');
    assert.equal((await tool<CandidateRecord>(client, 'catalog_candidate', { candidateId: sword.candidateId })).reviewState,
      'rejected');
    const request = await http<RequestRecord>(service, f.bridgeHeaders(), `/api/requests/${managed.id}`);
    assert.equal(request.outcome.status, 'unknown');
    assert.deepEqual(request.proposedInputs.map(input => [input.artifactId, input.role]), [[newer.id, 'suggested concept']]);
    assert.deepEqual(request.capturedArtifacts.map(item => item.id), [oldAttack.id]);
    const untouched = await http<RequestRecord>(service, f.bridgeHeaders(), `/api/requests/${pending.id}`);
    assert.equal(untouched.outcome.status, 'unknown');
    assert.deepEqual(untouched.capturedArtifacts, []);
    const actual = await tool<QueryPage<InputEdgeRecord>>(client, 'lineage_inputs', { artifactId: oldAttack.id });
    assert.equal(actual.items.length, 3);
    assert.deepEqual(Object.fromEntries(actual.items.map(edge => [edge.input.artifactId, edge.input.role])), {
      [original.id]: 'base concept', [helmet.id]: 'helmet reference', [sword.id]: null,
    });
    const descendants = await tool<QueryPage<SearchHit>>(client, 'queries_search', {
      filters: { descendantOf: [original.id] },
    });
    assert.deepEqual(new Set(descendants.items.map(item => item.artifactId)), new Set([oldAttack.id, walk.id]));
    const lineage = await tool<LineagePage>(client, 'queries_lineage', { artifactId: oldAttack.id, direction: 'inputs' });
    assert.ok(lineage.items.some(step => step.artifactId === sword.id));
    assert.equal((await tool<SlotRecord>(client, 'catalog_slot', { slotId: attack.id })).selectedCandidateId, null);
    const context = await tool<ContextResult>(client, 'queries_context', {
      assetId: knight.id, slotId: attack.id, sourceArtifactId: original.id, limit: 1,
    });
    assert.equal(context.asset.stage, 'Exploring');
    assert.equal(context.targetSlot?.selectedCandidateId, null);
    assert.equal(context.explicitSource?.id, original.id);
    assert.ok(context.sections.candidates.nextCursor);
    assert.ok(context.sections.requests.nextCursor);
    const candidatePage = await tool<ContextResult>(client, 'queries_context', {
      assetId: knight.id, slotId: attack.id, sourceArtifactId: original.id, limit: 1,
      section: 'candidates', cursor: context.sections.candidates.nextCursor,
    });
    assert.deepEqual(new Set([...context.sections.candidates.items, ...candidatePage.sections.candidates.items].map(item => item.id)),
      new Set([oldAttack.candidateId, newAttack.candidateId]));
    const requestPage = await tool<ContextResult>(client, 'queries_context', {
      assetId: knight.id, slotId: attack.id, sourceArtifactId: original.id, limit: 1,
      section: 'requests', cursor: context.sections.requests.nextCursor,
    });
    assert.deepEqual(new Set([...context.sections.requests.items, ...requestPage.sections.requests.items].map(item => item.id)),
      new Set([managed.id, pending.id]));
    const sourceContext = await tool<ContextResult>(client, 'queries_context', {
      assetId: knight.id, slotId: attack.id, sourceArtifactId: oldAttack.id,
    });
    assert.equal(sourceContext.explicitSource?.id, oldAttack.id);
    assert.ok(sourceContext.sections.inputs.items.some(item => item.id === actual.items[0]?.edgeId));
    const recoveredUnknown = await tool<{ claim: { state: string } }>(client, 'provenance_claim', {
      artifactId: oldAttack.id, field: 'seed',
    });
    assert.equal(recoveredUnknown.claim.state, 'unknown');
    assert.equal((await tool<{ claim: { state: string } }>(client, 'provenance_claim', {
      artifactId: original.id, field: 'productionTime',
    })).claim.state, 'unknown');
    assert.equal((await tool<{ state: string }>(client, 'provenance_claim', {
      artifactId: original.id, field: 'prompt',
    })).state, 'not-recorded');
  });
