<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { AssetRecord, CandidateRecord, SlotRecord } from '@assetweave/contracts/catalog';
  import type { CaptureRecord } from '@assetweave/contracts/capture';
  import type { MediaDescription } from '@assetweave/contracts/media';
  import type { ClipRecord } from '@assetweave/contracts/playback';
  import { claimInput, exactInput, lineageGapInput, productionField, productionFields,
    type ClaimInput, type ClaimRecord, type NotRecordedClaim, type InputEdgeRecord, type LineageGapRecord } from '@assetweave/contracts/production';
  import type { LineagePage, LineageStep, RevisionDetail } from '@assetweave/contracts/queries';
  import { ApiClientError, type ApiClient } from '../../lib/api/client.js';
  import type { NavigationState } from '../../lib/navigation.js';
  import HistoryPanel from './HistoryPanel.svelte';

  type Direction = 'inputs' | 'dependents';
  type SourceState = 'known' | 'unknown' | 'absent';
  interface Props {
    api: ApiClient; record: CaptureRecord | null; media: MediaDescription | null;
    claims: ClaimRecord[]; inputs: InputEdgeRecord[]; gaps: LineageGapRecord[]; clips: ClipRecord[];
    slots: SlotRecord[]; selectedSlotId?: string; selectedCandidateId?: string | null;
    candidate: CandidateRecord | null; candidateLabels: ReadonlyMap<string, { artifactName: string; clipName?: string | null }>;
    currentAsset: AssetRecord | null;
    capturedProjectName?: string; capturedAssetName?: string; tab: string;
    errors: Record<string, string>; more: Record<string, boolean>;
    revisionId?: string; revision: RevisionDetail | null; revisionLoading: boolean; revisionError: string;
    onNavigate: (patch: Partial<NavigationState>) => void; onTab: (tab: string) => void;
    onMore: (part: 'claims' | 'inputs' | 'gaps' | 'clips') => void;
    onPlace: (slotId: string, clipId?: string) => Promise<void>;
    onChanged: () => void; decisions: Snippet; requests: Snippet; editor: Snippet;
  }
  let { api, record, media, claims, inputs, gaps, clips, slots, selectedSlotId, selectedCandidateId,
    candidate, candidateLabels, currentAsset, capturedProjectName, capturedAssetName, tab, errors, more,
    revisionId, revision, revisionLoading, revisionError, onNavigate, onTab, onMore, onPlace,
    onChanged, decisions, requests, editor }: Props = $props();

  const tabs = [
    ['facts', 'Facts'], ['sources', 'Sources'], ['placement', 'Placement'], ['playback', 'Playback'],
    ['decisions', 'Decisions'], ['requests', 'Requests'], ['history', 'History'],
  ] as const;
  const humanTime = (value: string) => new Date(value).toLocaleString();
  const message = (cause: unknown) => cause instanceof Error ? cause.message : 'The record could not be saved.';
  const conflict = (cause: unknown) => cause instanceof ApiClientError && cause.status === 409;
  const valueText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
  const claimKey = (id: string, field: string) => `${id}:${field}`;
  function candidateLabel(id: string): string {
    const label = candidateLabels.get(id);
    if (!label) return id;
    const target = label.clipName === null ? 'Whole artwork' : label.clipName?.trim() || 'Named clip (name unavailable)';
    return `${label.artifactName} · ${target} · #${id.slice(0, 8)}`;
  }

  interface ClaimDraft {
    artifactId: string; field: string; state: SourceState; value: string; sourceKind: string;
    sourceDetail: string; assertionId: string | null; expectedRevision: number | null;
    latest: ClaimRecord | NotRecordedClaim | null; conflict: boolean; error: string; busy: boolean;
  }
  interface EdgeDraft {
    artifactId: string; edgeId: string | null; artifactInputId: string; clipId: string;
    playbackRevisionId: string; role: string; expectedRevision: number | null;
    latest: InputEdgeRecord | null; conflict: boolean; error: string; busy: boolean; confirmRetract: boolean;
  }
  interface GapDraft {
    artifactId: string; gapId: string | null; kind: 'upstream' | 'playback'; inputArtifactId: string;
    clipId: string; description: string; sourceKind: string; expectedRevision: number | null;
    latest: LineageGapRecord | null; conflict: boolean; error: string; busy: boolean; confirmRetract: boolean;
  }
  interface PlacementDraft { slotId: string; clipId: string; busy: boolean; error: string }
  interface Walk { steps: LineageStep[]; cursor: string | null; watermark: number | null; loaded: boolean;
    loading: boolean; error: string; visitedCount: number; frontierCount: number; gapCount: number;
    visitedTruncated: boolean; frontierTruncated: boolean; gapsTruncated: boolean }
  const newWalk = (): Walk => ({ steps: [], cursor: null, watermark: null, loaded: false, loading: false,
    error: '', visitedCount: 0, frontierCount: 0, gapCount: 0,
    visitedTruncated: false, frontierTruncated: false, gapsTruncated: false });

  let activeClaim = $state<Record<string, string>>({});
  let claimDrafts = $state<Record<string, ClaimDraft>>({});
  let customField = $state<Record<string, string>>({});
  let lookup = $state<Record<string, ClaimRecord | NotRecordedClaim>>({});
  let lookupErrors = $state<Record<string, string>>({});
  let lookingUp = new Set<string>();
  let lookupSequence = new Map<string, number>();
  let activeEdge = $state<Record<string, string>>({});
  let edgeDrafts = $state<Record<string, EdgeDraft>>({});
  let activeGap = $state<Record<string, string>>({});
  let gapDrafts = $state<Record<string, GapDraft>>({});
  let placementDrafts = $state<Record<string, PlacementDraft>>({});
  let walks = $state<Record<string, Record<Direction, Walk>>>({});
  let historyRefresh = $state(0);
  let postSave = $state<{ artifactId: string; text: string } | null>(null);

  $effect(() => {
    const id = record?.id;
    if (!id || placementDrafts[id]) return;
    placementDrafts[id] = { slotId: selectedSlotId ?? '', clipId: '', busy: false, error: '' };
  });
  $effect(() => {
    const id = record?.id;
    if (id && (tab === 'sources' || tab === 'facts')) {
      for (const field of productionFields) {
        if (!claims.some(item => item.claim.field === field)) void lookupField(id, field);
      }
    }
  });
  async function lookupField(id: string, field: string, force = false) {
    const key = claimKey(id, field);
    if (!force && (lookingUp.has(key) || lookup[key] || lookupErrors[key])) return;
    const sequence = (lookupSequence.get(key) ?? 0) + 1;
    lookupSequence.set(key, sequence);
    lookingUp.add(key);
    delete lookupErrors[key];
    try {
      const result = await api.get<ClaimRecord | NotRecordedClaim>(`/api/artifacts/${id}/claims/${encodeURIComponent(field)}`);
      if (lookupSequence.get(key) === sequence) lookup[key] = result;
    } catch (cause) {
      if (lookupSequence.get(key) === sequence) lookupErrors[key] = message(cause);
    } finally {
      if (lookupSequence.get(key) === sequence) lookingUp.delete(key);
    }
  }
  function currentClaim(id: string, field: string): ClaimRecord | null {
    const listed = claims.find(item => item.artifactId === id && item.claim.field === field) ?? null;
    const fetched = lookup[claimKey(id, field)];
    if (fetched && 'claim' in fetched && (!listed || fetched.revision >= listed.revision)) return fetched;
    return listed;
  }
  function stateText(id: string, field: string): string {
    const found = currentClaim(id, field);
    if (found) return found.claim.state === 'known' ? 'Known' : found.claim.state === 'unknown' ? 'Explicitly unknown' : 'Recorded absent';
    const key = claimKey(id, field);
    if (lookupErrors[key]) return 'Source unavailable';
    const fetched = lookup[key];
    if (fetched && 'state' in fetched && fetched.state === 'not-recorded') return 'Not recorded';
    return 'Checking recorded source…';
  }
  function startClaim(id: string, field: string) {
    const key = claimKey(id, field);
    if (!claimDrafts[key]) {
      const existing = currentClaim(id, field);
      claimDrafts[key] = { artifactId: id, field, state: existing?.claim.state ?? 'known',
        value: existing?.claim.state === 'known' ? JSON.stringify(existing.claim.value) : '',
        sourceKind: existing?.claim.source.kind ?? '', sourceDetail: existing?.claim.source.detail ?? '',
        assertionId: existing?.assertionId ?? null, expectedRevision: existing?.revision ?? null,
        latest: null, conflict: false, error: '', busy: false };
    }
    activeClaim[id] = field;
  }
  function startCustom(id: string) {
    const parsed = productionField.safeParse(customField[id]?.trim());
    if (!parsed.success) { postSave = { artifactId: id, text: 'Enter a provenance field name (up to 200 characters).' }; return; }
    startClaim(id, parsed.data);
    customField[id] = '';
    postSave = null;
    void lookupField(id, parsed.data);
  }
  function claimPayload(draft: ClaimDraft): ClaimInput | null {
    let value: unknown;
    if (draft.state === 'known') {
      try { value = JSON.parse(draft.value); }
      catch { draft.error = 'Known values must be valid JSON: for text, include quotes (for example "A prompt").'; return null; }
    }
    const result = claimInput.safeParse({ field: draft.field, state: draft.state,
      ...(draft.state === 'known' ? { value } : {}),
      source: { kind: draft.sourceKind.trim(), ...(draft.sourceDetail.trim() ? { detail: draft.sourceDetail.trim() } : {}) } });
    if (!result.success) { draft.error = 'Enter a valid sourced claim. The source kind is required.'; return null; }
    return result.data;
  }
  async function saveClaim(draft: ClaimDraft) {
    if (draft.busy || draft.conflict) return;
    draft.error = '';
    const claim = claimPayload(draft);
    if (!claim) return;
    draft.busy = true;
    try {
      const changed = draft.assertionId && draft.expectedRevision !== null
        ? await api.mutate<ClaimRecord>(`/api/assertions/${draft.assertionId}`, 'PATCH',
          { expectedRevision: draft.expectedRevision, claim })
        : (await api.mutate<ClaimRecord[]>(`/api/artifacts/${draft.artifactId}/claims`, 'POST', { claims: [claim] }))[0];
      if (changed) lookup[claimKey(draft.artifactId, draft.field)] = changed;
      delete claimDrafts[claimKey(draft.artifactId, draft.field)];
      delete activeClaim[draft.artifactId];
      postSave = { artifactId: draft.artifactId, text: 'Provenance saved. Earlier revisions remain in History.' };
      historyRefresh++;
      onChanged();
    } catch (cause) {
      draft.error = `${message(cause)} Your sourced claim remains unsent.`;
      if (conflict(cause)) {
        draft.conflict = true;
        try {
          draft.latest = await api.get<ClaimRecord | NotRecordedClaim>(
            `/api/artifacts/${draft.artifactId}/claims/${encodeURIComponent(draft.field)}`);
        } catch (readCause) { draft.error += ` Latest claim could not be loaded: ${message(readCause)}`; }
      }
    } finally { draft.busy = false; }
  }
  function adoptClaim(draft: ClaimDraft) {
    if (!draft.latest || !('claim' in draft.latest)) return;
    draft.assertionId = draft.latest.assertionId;
    draft.expectedRevision = draft.latest.revision;
    draft.conflict = false;
    draft.error = 'Latest assertion revision adopted for this unsent draft. Check your value and save when ready.';
  }
  function openNewEdge(id: string) {
    const key = `${id}:new`;
    edgeDrafts[key] ??= { artifactId: id, edgeId: null, artifactInputId: '', clipId: '', playbackRevisionId: '',
      role: '', expectedRevision: null, latest: null, conflict: false, error: '', busy: false, confirmRetract: false };
    activeEdge[id] = key;
  }
  function openEdge(item: InputEdgeRecord) {
    const key = `${item.outputArtifactId}:${item.edgeId}`;
    edgeDrafts[key] ??= { artifactId: item.outputArtifactId, edgeId: item.edgeId,
      artifactInputId: item.input.artifactId, clipId: item.input.clipId ?? '',
      playbackRevisionId: item.input.playbackRevisionId ?? '', role: item.input.role ?? '',
      expectedRevision: item.revision, latest: null, conflict: false, error: '', busy: false, confirmRetract: false };
    activeEdge[item.outputArtifactId] = key;
  }
  async function saveEdge(draft: EdgeDraft, retract = false) {
    if (draft.busy || draft.conflict || retract && !draft.confirmRetract) return;
    draft.error = '';
    const parsed = exactInput.safeParse({ artifactId: draft.artifactInputId.trim(),
      ...(draft.role.trim() ? { role: draft.role.trim() } : {}),
      ...(draft.clipId.trim() ? { clipId: draft.clipId.trim() } : {}),
      ...(draft.playbackRevisionId.trim() ? { playbackRevisionId: draft.playbackRevisionId.trim() } : {}) });
    if (!retract && !parsed.success) { draft.error = 'Specify an exact input artifact UUID. A clip input needs both clip and pinned playback revision UUIDs.'; return; }
    draft.busy = true;
    try {
      if (draft.edgeId && draft.expectedRevision !== null) {
        await api.mutate<InputEdgeRecord>(`/api/inputs/${draft.edgeId}${retract ? '/retract' : ''}`,
          retract ? 'POST' : 'PATCH', { expectedRevision: draft.expectedRevision,
            ...(retract ? {} : { input: parsed.data }) });
      } else if (parsed.success) {
        await api.mutate<InputEdgeRecord[]>(`/api/artifacts/${draft.artifactId}/inputs`, 'POST', { inputs: [parsed.data] });
      }
      delete edgeDrafts[draft.edgeId ? `${draft.artifactId}:${draft.edgeId}` : `${draft.artifactId}:new`];
      delete activeEdge[draft.artifactId];
      postSave = { artifactId: draft.artifactId,
        text: retract ? 'Input retracted; its revisions remain in History.' : 'Actual input saved; it is not a request proposal.' };
      delete walks[draft.artifactId];
      historyRefresh++;
      onChanged();
    } catch (cause) {
      draft.error = `${message(cause)} Your actual-input draft remains unsent.`;
      if (draft.edgeId && conflict(cause)) {
        draft.conflict = true;
        try { draft.latest = await api.get<InputEdgeRecord>(`/api/inputs/${draft.edgeId}`); }
        catch (readCause) { draft.error += ` Latest input could not be loaded: ${message(readCause)}`; }
      }
    } finally { draft.busy = false; }
  }
  function adoptEdge(draft: EdgeDraft) {
    if (!draft.latest) return;
    draft.expectedRevision = draft.latest.revision;
    draft.conflict = false;
    draft.error = 'Latest edge revision adopted for this unsent draft. Check the exact input and save when ready.';
  }
  function openNewGap(id: string) {
    const key = `${id}:new`;
    gapDrafts[key] ??= { artifactId: id, gapId: null, kind: 'upstream', inputArtifactId: '', clipId: '',
      description: '', sourceKind: '', expectedRevision: null, latest: null, conflict: false,
      error: '', busy: false, confirmRetract: false };
    activeGap[id] = key;
  }
  function openGap(item: LineageGapRecord) {
    const key = `${item.outputArtifactId}:${item.gapId}`;
    gapDrafts[key] ??= { artifactId: item.outputArtifactId, gapId: item.gapId, kind: item.gap.kind,
      inputArtifactId: item.gap.inputArtifactId ?? '', clipId: item.gap.kind === 'playback' ? item.gap.clipId : '',
      description: item.gap.description, sourceKind: item.gap.sourceKind, expectedRevision: item.revision,
      latest: null, conflict: false, error: '', busy: false, confirmRetract: false };
    activeGap[item.outputArtifactId] = key;
  }
  async function saveGap(draft: GapDraft, retract = false) {
    if (draft.busy || draft.conflict || retract && !draft.confirmRetract) return;
    draft.error = '';
    const parsed = lineageGapInput.safeParse({ kind: draft.kind, description: draft.description.trim(),
      sourceKind: draft.sourceKind.trim(),
      ...(draft.inputArtifactId.trim() ? { inputArtifactId: draft.inputArtifactId.trim() } : {}),
      ...(draft.kind === 'playback' ? { clipId: draft.clipId.trim() } : {}) });
    if (!retract && !parsed.success) { draft.error = 'Describe the gap and its source kind. A playback gap also needs its input artwork and clip UUID.'; return; }
    draft.busy = true;
    try {
      if (draft.gapId && draft.expectedRevision !== null) {
        await api.mutate<LineageGapRecord>(`/api/gaps/${draft.gapId}${retract ? '/retract' : ''}`,
          retract ? 'POST' : 'PATCH', { expectedRevision: draft.expectedRevision,
            ...(retract ? {} : { gap: parsed.data }) });
      } else if (parsed.success) {
        await api.mutate<LineageGapRecord[]>(`/api/artifacts/${draft.artifactId}/gaps`, 'POST', { gaps: [parsed.data] });
      }
      delete gapDrafts[draft.gapId ? `${draft.artifactId}:${draft.gapId}` : `${draft.artifactId}:new`];
      delete activeGap[draft.artifactId];
      postSave = { artifactId: draft.artifactId,
        text: retract ? 'Gap retracted; its revisions remain in History.' : 'Explicit lineage gap saved.' };
      delete walks[draft.artifactId];
      historyRefresh++;
      onChanged();
    } catch (cause) {
      draft.error = `${message(cause)} Your gap draft remains unsent.`;
      if (draft.gapId && conflict(cause)) {
        draft.conflict = true;
        try { draft.latest = await api.get<LineageGapRecord>(`/api/gaps/${draft.gapId}`); }
        catch (readCause) { draft.error += ` Latest gap could not be loaded: ${message(readCause)}`; }
      }
    } finally { draft.busy = false; }
  }
  function adoptGap(draft: GapDraft) {
    if (!draft.latest) return;
    draft.expectedRevision = draft.latest.revision;
    draft.conflict = false;
    draft.error = 'Latest gap revision adopted for this unsent draft. Check the description and save when ready.';
  }
  async function place(id: string, draft: PlacementDraft) {
    if (!draft.slotId || draft.busy) return;
    draft.busy = true; draft.error = '';
    try { await onPlace(draft.slotId, draft.clipId || undefined); }
    catch (cause) { draft.error = `${message(cause)} Your placement choice remains here.`; }
    finally { draft.busy = false; }
  }
  async function walk(id: string, direction: Direction, moreSteps = false) {
    walks[id] ??= { inputs: newWalk(), dependents: newWalk() };
    const previous = walks[id][direction];
    if (previous.loading || moreSteps && !previous.cursor) return;
    walks[id][direction] = { ...previous, loading: true, error: '' };
    const params = new URLSearchParams({ direction, limit: '20' });
    if (moreSteps && previous.cursor) params.set('cursor', previous.cursor);
    try {
      const page = await api.get<LineagePage>(`/api/queries/lineage/${id}?${params}`);
      if (!walks[id]) return;
      if (moreSteps && previous.watermark !== page.watermark) {
        walks[id][direction] = { ...previous, cursor: null, error: 'Lineage changed during traversal. Restart from the artwork to see the new graph.' };
        return;
      }
      walks[id][direction] = { steps: moreSteps ? [...previous.steps, ...page.items] : page.items,
        cursor: page.nextCursor, watermark: page.watermark, loaded: true, loading: false, error: '',
        visitedCount: page.visitedCount, frontierCount: page.frontierCount, gapCount: page.encounteredGapCount,
        visitedTruncated: page.visitedTruncated, frontierTruncated: page.frontierTruncated,
        gapsTruncated: page.encounteredGapsTruncated };
    } catch (cause) {
      walks[id][direction] = { ...previous, loading: false, cursor: conflict(cause) ? null : previous.cursor,
        error: conflict(cause) ? `${message(cause)} Restart traversal to use the latest graph.` : message(cause) };
    }
  }
  function openArtwork(id: string, pinnedRevisionId?: string | null, pinnedClipId?: string | null) {
    // A related artifact may belong to another asset. Let the parent resolve its owner
    // instead of carrying this artwork's slot and captured-asset context into it.
    const differentArtwork = record?.id !== id;
    onNavigate({ artifactId: id, revisionId: pinnedRevisionId ?? undefined,
      tab: pinnedRevisionId ? 'history' : 'facts',
      ...(differentArtwork ? { candidateId: undefined, clipId: undefined, slotId: undefined,
        assetId: undefined, projectId: undefined, requestId: undefined, filters: undefined } : {}),
      ...(pinnedRevisionId && pinnedClipId !== undefined && pinnedClipId !== candidate?.clipId
        ? { candidateId: undefined } : {}),
      ...(pinnedRevisionId ? { clipId: pinnedClipId ?? undefined } : {}) });
  }
  const gifWithUnknownTiming = $derived(media?.playback === 'unconfigured' &&
    media.members.some(member => member.format === 'gif' && (member.frameCount ?? 0) > 1 &&
      member.encodedTiming?.status === 'unknown'));
  const fields = $derived([...new Set<string>([...productionFields,
    ...claims.filter(item => item.artifactId === record?.id).map(item => item.claim.field),
    ...Object.values(lookup).filter((item): item is ClaimRecord =>
      'claim' in item && item.artifactId === record?.id).map(item => item.claim.field)])]);
</script>

<section class="artifact-inspector" aria-label="Viewed artwork record inspector">
  <p class="inspector-kicker">Viewed record · not a selection</p>
  <h2>{record?.name ?? 'Artwork record loading…'}</h2>
  {#if record}
    <p class="muted">{record.kind} · captured {humanTime(record.capturedAt)}</p>
    <p><strong>Viewed:</strong> {candidate?.artifactId === record.id
      ? candidateLabel(candidate.id)
      : `${record.name} · artwork ${record.id.slice(0, 8)} (no verified candidate in this slot)`}</p>
    <p class="muted">Viewed candidate review: {candidate?.artifactId === record.id ? candidate.reviewState : 'no verified candidate review'}. Viewing alone records no review.</p>
    <p><strong>Current slot selection:</strong> {selectedSlotId
      ? selectedCandidateId === undefined ? 'not loaded' : selectedCandidateId === null ? 'none' : candidateLabel(selectedCandidateId)
      : 'No slot selected.'}</p>
    <p class="muted">{candidate && candidate.artifactId === record.id && selectedCandidateId === candidate.id
      ? 'Viewed candidate is the current slot selection.' : 'Viewed artwork is not verified as the current slot selection.'}</p>
    <details><summary>Full record IDs</summary>
      <dl><dt>Artifact</dt><dd><code>{record.id}</code></dd>
        <dt>Viewed candidate</dt><dd><code>{candidate?.artifactId === record.id ? candidate.id : 'No verified candidate'}</code></dd>
        <dt>Slot selection</dt><dd><code>{selectedSlotId ? selectedCandidateId === undefined ? 'Not loaded' : selectedCandidateId ?? 'None' : 'No slot selected'}</code></dd>
      </dl>
    </details>
  {:else}<p class="muted">Select artwork to inspect its captured record, available sources, and decisions.</p>{/if}
  {#if postSave && record && postSave.artifactId === record.id}<p class="notice" role="status">{postSave.text}</p>{/if}
  {#if revisionId}<p class="notice">Pinned historical revision {revisionId} is separate from the current artwork. Open History to inspect it.</p>{/if}
  <nav class="inspector-tabs" aria-label="Artwork inspector tabs">
    {#each tabs as [id, title] (id)}
      <button type="button" aria-current={tab === id ? 'page' : undefined} onclick={() => onTab(id)}>{title}</button>
    {/each}
  </nav>

  <div hidden={tab !== 'facts'} class="inspector-panel">
    {#if record}
      {@const productionTime = currentClaim(record.id, 'productionTime')}
      <dl class="fact-list">
        <dt>Captured owner</dt><dd>{capturedProjectName ?? record.projectId} / {capturedAssetName ?? record.assetId}</dd>
        <dt>Current asset stage</dt><dd>{currentAsset ? `${currentAsset.name}: ${currentAsset.stage ?? 'No stage set'}` : 'Current asset not loaded'}
          {#if currentAsset && currentAsset.id !== record.assetId} · different from capture owner{/if}</dd>
        {#if currentAsset}<dt>Current asset notes</dt><dd>{currentAsset.notes || 'No asset notes recorded'}</dd>{/if}
        <dt>Record notes</dt><dd>{record.notes || 'No artifact notes recorded'}</dd>
        <dt>Captured</dt><dd>{humanTime(record.capturedAt)} · by {record.recordedBy}</dd>
        <dt>Production time</dt><dd>{stateText(record.id, 'productionTime')}
          {#if productionTime?.claim.state === 'known'} · {valueText(productionTime.claim.value)}{/if}</dd>
        <dt>Content</dt><dd>{record.content === 'available' ? 'Preserved content available' : 'Content unavailable; metadata and history remain'}</dd>
        <dt>Playback</dt><dd>{gifWithUnknownTiming ? 'Native GIF animation · encoded timing unknown' :
          media?.playback === 'unconfigured' ? 'Still image · playback unconfigured' :
          media?.playback ?? 'Media description not loaded'}</dd>
        <dt>Request</dt><dd>{record.requestId ? `Linked request ${record.requestId}` : 'No managed request linked (not an inferred absence of external work)'}</dd>
      </dl>
      {#if record.requestId}<button type="button" class="text-button" onclick={() => onTab('requests')}>Open linked request and its proposed inputs</button>{/if}
      <h3>Original captured members</h3>
      <p class="muted">{record.members.length} member{record.members.length === 1 ? '' : 's'} in recorded ordinal order. Downloads preserve the captured originals.</p>
      {#each [...record.members].sort((a, b) => a.ordinal - b.ordinal) as member (member.ordinal)}
        <div class="member"><strong>{member.ordinal + 1}. {member.sourceName}</strong>
          <span>{member.byteCount.toLocaleString()} bytes · SHA-256 {member.sha256}</span>
          {#if record.content === 'available'}<a href={`/api/artifacts/${record.id}/members/${member.ordinal}/original`} download={member.sourceName}>Download original member</a>
          {:else}<span>Original unavailable</span>{/if}
        </div>
      {/each}
    {/if}
  </div>

  <div hidden={tab !== 'sources'} class="inspector-panel">
    {#if record}
      <h3>Production claims</h3>
      <p class="muted">Capture time is separate from production time. Known, explicitly unknown, recorded absent, and not recorded are different states.</p>
      <button type="button" class="quiet-button" onclick={() => {
        for (const field of productionFields) void lookupField(record!.id, field, true);
      }}>Refresh sourced production facts</button>
      {#if errors.claims}<p role="alert" class="notice">Claim list unavailable: {errors.claims}. A missing row is not evidence of absence.</p>{/if}
      <dl class="source-list">
        {#each fields as field (field)}
          {@const item = currentClaim(record.id, field)}
          {@const key = claimKey(record.id, field)}
          <dt>{field}</dt><dd><strong>{stateText(record.id, field)}</strong>
            {#if item?.claim.state === 'known'}<span class="value">{valueText(item.claim.value)}</span>{/if}
            {#if item}<small>Source: {item.claim.source.kind}{item.claim.source.detail ? ` · ${item.claim.source.detail}` : ''}. Revision {item.revision}, recorded by {item.actor} on {humanTime(item.at)}.</small>{/if}
            {#if lookupErrors[key]}<small role="alert">{lookupErrors[key]}</small>{/if}
            <button type="button" class="text-button" onclick={() => startClaim(record!.id, field)}>{item ? 'Correct sourced claim' : 'Record sourced claim'}</button>
          </dd>
        {/each}
      </dl>
      {#if more.claims}<button type="button" class="quiet-button" onclick={() => onMore('claims')}>Load more recorded fields</button>{/if}
      <div class="inline-add"><label>Other provenance field<input maxlength="200" bind:value={customField[record.id]} placeholder="Name of recorded field" /></label>
        <button type="button" class="quiet-button" onclick={() => startCustom(record!.id)}>Record another field</button></div>
      {@const claimField = activeClaim[record.id]}
      {@const claimDraft = claimField ? claimDrafts[claimKey(record.id, claimField)] : undefined}
      {#if claimDraft}
        {@const draft = claimDraft}
        <form class="edit-form" onsubmit={(event) => { event.preventDefault(); void saveClaim(draft); }}>
          <h4>{draft.assertionId ? 'Correct' : 'Record'} {draft.field}</h4>
          <label>Claim status<select bind:value={draft.state}><option value="known">Known</option><option value="unknown">Explicitly unknown</option><option value="absent">Recorded absent</option></select></label>
          {#if draft.state === 'known'}<label>Known value (JSON; wrap text in quotes)<textarea bind:value={draft.value} spellcheck="false" required></textarea></label>{/if}
          <label>Source kind<input bind:value={draft.sourceKind} maxlength="200" required placeholder="human, producer, import…" /></label>
          <label>Source detail (optional)<textarea bind:value={draft.sourceDetail} maxlength="16384"></textarea></label>
          {#if draft.conflict}<p role="alert" class="notice">The record changed. This form will not retry until you explicitly adopt the latest revision.</p>
            {#if draft.latest && 'claim' in draft.latest}<p class="muted">Latest: revision {draft.latest.revision} · {draft.latest.claim.state} · {draft.latest.claim.state === 'known' ? valueText(draft.latest.claim.value) : 'no known value'} · source {draft.latest.claim.source.kind}{draft.latest.claim.source.detail ? ` · ${draft.latest.claim.source.detail}` : ''} · {draft.latest.actor} on {humanTime(draft.latest.at)}.</p>
              <button type="button" class="quiet-button" onclick={() => adoptClaim(draft)}>Adopt latest revision for my unsent draft</button>{/if}
          {/if}
          {#if draft.error}<p role="alert" class="notice">{draft.error}</p>{/if}
          <div class="actions"><button type="submit" class="primary-button" disabled={draft.busy || draft.conflict}>{draft.busy ? 'Saving…' : 'Save sourced claim'}</button>
            <button type="button" class="quiet-button" onclick={() => delete activeClaim[record!.id]}>Close form (keep draft)</button></div>
        </form>
      {/if}

      <h3>Actual recorded inputs</h3>
      <p class="muted">These are effective exact production inputs, not proposed request inputs or inferred links. A missing edge does not prove there was no source.</p>
      {#if record.requestId}<button type="button" class="text-button" onclick={() => onTab('requests')}>Compare linked request's proposed inputs</button>{/if}
      {#if errors.inputs}<p role="alert" class="notice">Actual inputs unavailable: {errors.inputs}</p>{/if}
      {#each inputs as edge (edge.edgeId)}
        <div class="relation"><button type="button" class="text-button" onclick={() => openArtwork(edge.input.artifactId)}>Input artwork {edge.input.artifactId}</button>
          <span>Role: {edge.input.role ?? 'not recorded'}{edge.input.clipId ? ` · clip ${edge.input.clipId}` : ''}</span>
          {#if edge.input.playbackRevisionId}<button type="button" class="text-button" onclick={() => openArtwork(edge.input.artifactId, edge.input.playbackRevisionId, edge.input.clipId)}>Pinned playback revision {edge.input.playbackRevisionId}</button>{/if}
          <small>Recorded by {edge.actor} on {humanTime(edge.at)} · edge revision {edge.revision}</small>
          <button type="button" class="quiet-button" onclick={() => openEdge(edge)}>Correct or retract input</button>
        </div>
      {/each}
      {#if !inputs.length && !errors.inputs}<p class="muted">No effective actual input is recorded in the loaded page.</p>{/if}
      {#if more.inputs}<button type="button" class="quiet-button" onclick={() => onMore('inputs')}>Load more actual inputs</button>{/if}
      <button type="button" class="quiet-button" onclick={() => openNewEdge(record!.id)}>Record an actual input</button>
      {@const edgeKey = activeEdge[record.id]}
      {@const edgeDraft = edgeKey ? edgeDrafts[edgeKey] : undefined}
      {#if edgeDraft}
        {@const draft = edgeDraft}
        <form class="edit-form" onsubmit={(event) => { event.preventDefault(); void saveEdge(draft); }}>
          <h4>{draft.edgeId ? 'Correct exact input' : 'Record exact actual input'}</h4>
          <label>Input artwork UUID<input bind:value={draft.artifactInputId} required /></label>
          <label>Input role (optional)<input bind:value={draft.role} maxlength="200" placeholder="starting artwork, visual reference…" /></label>
          <label>Input clip UUID (optional)<input bind:value={draft.clipId} /></label>
          <label>Pinned playback revision UUID (required with clip)<input bind:value={draft.playbackRevisionId} /></label>
          {#if draft.conflict}<p role="alert" class="notice">Input changed; adopt the latest revision explicitly before retrying.</p>
            {#if draft.latest}<p class="muted">Latest revision {draft.latest.revision} · {draft.latest.effective ? 'effective' : 'retracted'} · artwork {draft.latest.input.artifactId} · role {draft.latest.input.role ?? 'not recorded'} · clip {draft.latest.input.clipId ?? 'none'} · pinned playback {draft.latest.input.playbackRevisionId ?? 'none'} · {draft.latest.actor} on {humanTime(draft.latest.at)}.</p>
              <button type="button" class="quiet-button" onclick={() => adoptEdge(draft)}>Adopt latest edge revision for my draft</button>{/if}{/if}
          {#if draft.error}<p role="alert" class="notice">{draft.error}</p>{/if}
          <div class="actions"><button type="submit" class="primary-button" disabled={draft.busy || draft.conflict}>{draft.busy ? 'Saving…' : 'Save actual input'}</button>
            {#if draft.edgeId}<label class="check"><input type="checkbox" bind:checked={draft.confirmRetract} /> I intend to retract this exact input</label>
              <button type="button" class="quiet-button" disabled={draft.busy || draft.conflict || !draft.confirmRetract} onclick={() => saveEdge(draft, true)}>Retract input</button>{/if}
            <button type="button" class="quiet-button" onclick={() => delete activeEdge[record!.id]}>Close form (keep draft)</button></div>
        </form>
      {/if}

      <h3>Explicit gaps</h3>
      <p class="muted">A gap identifies missing or unavailable history without inventing an input relationship.</p>
      {#if errors.gaps}<p role="alert" class="notice">Gap list unavailable: {errors.gaps}</p>{/if}
      {#each gaps as gap (gap.gapId)}
        <div class="relation"><strong>{gap.gap.kind} gap</strong><span>{gap.gap.description}</span>
          <span>Source {gap.gap.sourceKind} · artwork {gap.gap.inputArtifactId ?? 'not identified'}{gap.gap.kind === 'playback' ? ` · clip ${gap.gap.clipId}` : ''}</span>
          <small>Recorded by {gap.actor} on {humanTime(gap.at)} · revision {gap.revision}</small>
          <button type="button" class="quiet-button" onclick={() => openGap(gap)}>Correct or retract gap</button></div>
      {/each}
      {#if !gaps.length && !errors.gaps}<p class="muted">No explicit effective gaps recorded in the loaded page.</p>{/if}
      {#if more.gaps}<button type="button" class="quiet-button" onclick={() => onMore('gaps')}>Load more gaps</button>{/if}
      <button type="button" class="quiet-button" onclick={() => openNewGap(record!.id)}>Record a lineage gap</button>
      {@const gapKey = activeGap[record.id]}
      {@const gapDraft = gapKey ? gapDrafts[gapKey] : undefined}
      {#if gapDraft}
        {@const draft = gapDraft}
        <form class="edit-form" onsubmit={(event) => { event.preventDefault(); void saveGap(draft); }}>
          <h4>{draft.gapId ? 'Correct lineage gap' : 'Record missing history'}</h4>
          <label>Gap kind<select bind:value={draft.kind}><option value="upstream">Unknown upstream history</option><option value="playback">Unknown playback revision for actual artifact input</option></select></label>
          <label>Input artwork UUID {draft.kind === 'playback' ? '(required)' : '(optional)'}<input bind:value={draft.inputArtifactId} required={draft.kind === 'playback'} /></label>
          {#if draft.kind === 'playback'}<label>Input clip UUID<input bind:value={draft.clipId} required /></label>{/if}
          <label>What is missing?<textarea bind:value={draft.description} maxlength="16384" required></textarea></label>
          <label>Source kind<input bind:value={draft.sourceKind} maxlength="200" required /></label>
          {#if draft.conflict}<p role="alert" class="notice">Gap changed; adopt the latest revision explicitly before retrying.</p>
            {#if draft.latest}<p class="muted">Latest revision {draft.latest.revision} · {draft.latest.effective ? 'effective' : 'retracted'} · {draft.latest.gap.kind} · {draft.latest.gap.description} · artwork {draft.latest.gap.inputArtifactId ?? 'not identified'}{draft.latest.gap.kind === 'playback' ? ` · clip ${draft.latest.gap.clipId}` : ''} · source {draft.latest.gap.sourceKind} · {draft.latest.actor} on {humanTime(draft.latest.at)}.</p>
              <button type="button" class="quiet-button" onclick={() => adoptGap(draft)}>Adopt latest gap revision for my draft</button>{/if}{/if}
          {#if draft.error}<p role="alert" class="notice">{draft.error}</p>{/if}
          <div class="actions"><button type="submit" class="primary-button" disabled={draft.busy || draft.conflict}>{draft.busy ? 'Saving…' : 'Save explicit gap'}</button>
            {#if draft.gapId}<label class="check"><input type="checkbox" bind:checked={draft.confirmRetract} /> I intend to retract this gap</label>
              <button type="button" class="quiet-button" disabled={draft.busy || draft.conflict || !draft.confirmRetract} onclick={() => saveGap(draft, true)}>Retract gap</button>{/if}
            <button type="button" class="quiet-button" onclick={() => delete activeGap[record!.id]}>Close form (keep draft)</button></div>
        </form>
      {/if}

      <h3>Traverse recorded lineage</h3>
      <p class="muted">Walk exact effective edges across multiple steps. Bounded results require explicit continuation; gaps mark incomplete histories.</p>
      {#each ['inputs', 'dependents'] as direction (direction)}
        {@const traversal = walks[record.id]?.[direction as Direction]}
        <section class="traversal" aria-label={direction === 'inputs' ? 'Upstream inputs' : 'Downstream dependents'}>
          <h4>{direction === 'inputs' ? 'Upstream inputs' : 'Downstream dependents'}</h4>
          <button type="button" class="quiet-button" disabled={traversal?.loading} onclick={() => walk(record!.id, direction as Direction)}>{traversal?.loaded ? 'Restart traversal' : 'Load traversal'}</button>
          {#if traversal?.error}<p role="alert" class="notice">{traversal.error}</p>{/if}
          {#if traversal?.loading}<p role="status">Loading recorded {direction}…</p>{/if}
          {#if traversal?.loaded}
            <p class="muted">Visited {traversal.visitedCount} artwork record{traversal.visitedCount === 1 ? '' : 's'} · frontier {traversal.frontierCount} · encountered gaps {traversal.gapCount}.
              {#if traversal.visitedTruncated || traversal.frontierTruncated || traversal.gapsTruncated} Counts may exceed the bounded IDs in this response; continue to inspect each recorded step.{/if}</p>
            {#each traversal.steps as step, index (`${step.artifactId}:${step.depth}:${index}`)}
              <div class="relation"><span>Step {index + 1} · depth {step.depth} {step.depth === 0 ? '(starting artwork)' : ''}</span>
                <button type="button" class="text-button" onclick={() => openArtwork(step.artifactId)}>Artwork {step.artifactId}</button>
                {#if step.via}<span>Via exact edge {step.via.id} · role {step.via.role ?? 'not recorded'}</span>
                  <button type="button" class="text-button" onclick={() => onNavigate({ revisionId: step.via!.revisionId, tab: 'history' })}>Open pinned edge revision</button>{/if}
                {#each step.links as link (link.id)}<small>Recorded link: {link.inputArtifactId} → {link.outputArtifactId} · role {link.role ?? 'not recorded'}</small>{/each}
                {#each step.gaps as missing (missing.id)}<span>Explicit {missing.kind} gap: {missing.description}{missing.descriptionTruncated ? '… (description truncated)' : ''}</span>{/each}
              </div>
            {/each}
            {#if !traversal.cursor}<p class="muted">No further recorded {direction} in this traversal. Unrecorded history remains unknown.</p>{/if}
            {#if traversal.cursor}<button type="button" class="quiet-button" disabled={traversal.loading} onclick={() => walk(record!.id, direction as Direction, true)}>Continue {direction} traversal</button>{/if}
          {/if}
        </section>
      {/each}
    {/if}
  </div>

  <div hidden={tab !== 'placement'} class="inspector-panel">
    {#if record}
      {@const placementDraft = placementDrafts[record.id]}
      {#if placementDraft}
        {@const draft = placementDraft}
      <h3>Place this exact target in a named slot</h3>
      <p class="muted">Placement does not select or approve artwork. The same whole artwork or named clip can be a candidate in multiple slots.</p>
      <form class="edit-form" onsubmit={(event) => { event.preventDefault(); void place(record!.id, draft); }}>
        <label>Destination slot<select bind:value={draft.slotId} required><option value="">Choose a slot</option>{#each slots as slot (slot.id)}<option value={slot.id}>{slot.name}</option>{/each}</select></label>
        <label>Target<select bind:value={draft.clipId}><option value="">Whole artifact</option>{#each clips as clip (clip.id)}<option value={clip.id}>Clip: {clip.name}</option>{/each}</select></label>
        {#if more.clips}<button type="button" class="quiet-button" onclick={() => onMore('clips')}>Load more named clips</button>{/if}
        {#if draft.error}<p role="alert" class="notice">{draft.error}</p>{/if}
        <button type="submit" class="primary-button" disabled={!draft.slotId || draft.busy}>{draft.busy ? 'Placing…' : 'Place candidate'}</button>
      </form>
      {#if !slots.length}<p class="muted">No destination slots loaded for the current asset. Create a named slot first.</p>{/if}
      {/if}
    {/if}
  </div>
  <div hidden={tab !== 'playback'} class="inspector-panel"><h3>Playback descriptions</h3>
    {#if media}<p class="muted">{gifWithUnknownTiming
      ? 'Native GIF animation · encoded timing unknown. The browser plays the original GIF; no frame rate is inferred.'
      : media.playback === 'unconfigured' ? 'Still image: playback is unconfigured. No frame rate has been inferred.'
      : `Media playback: ${media.playback}.`}</p>{/if}
    {#each clips as clip (clip.id)}<p>{clip.name} · {clip.current.description.frames.length} ordered frames · {clip.current.cycleMs} ms cycle · sourced by {clip.current.description.source.kind}</p>{/each}
    {#if more.clips}<button type="button" class="quiet-button" onclick={() => onMore('clips')}>Load more clips</button>{/if}
    {@render editor()}
  </div>
  <div hidden={tab !== 'decisions'} class="inspector-panel">{@render decisions()}</div>
  <div hidden={tab !== 'requests'} class="inspector-panel">{@render requests()}</div>
  <div hidden={tab !== 'history'} class="inspector-panel">
    <HistoryPanel {api} {record} {candidate} {claims} {clips} {selectedSlotId} {currentAsset}
      moreClaims={!!more.claims} moreClips={!!more.clips} claimError={errors.claims} clipError={errors.clips}
      onMore={(part) => onMore(part)} {revisionId} {revision} {revisionLoading}
      {revisionError} {onNavigate} refreshToken={historyRefresh} />
  </div>
</section>

<style>
  .artifact-inspector { min-width: 0; display: grid; align-content: start; gap: 9px; color: var(--text); }
  .artifact-inspector :is(h2, h3, h4, p, dl, dd) { margin: 0; }
  h2 { font-size: 17px; overflow-wrap: anywhere; }
  h3 { margin-top: 8px !important; font-size: 14px; }
  h4 { font-size: 13px; }
  .muted, small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .inspector-tabs { display: flex; flex-wrap: wrap; gap: 9px; margin: 8px 0 4px; }
  .inspector-tabs button { white-space: nowrap; }
  .inspector-tabs button[aria-current='page'] { color: var(--text); border-bottom-color: var(--accent); font-weight: 650; }
  .inspector-panel { display: grid; align-content: start; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
  .fact-list, .source-list { display: grid; grid-template-columns: minmax(72px, 88px) minmax(0, 1fr); gap: 9px 11px; }
  .fact-list dt, .source-list dt { color: var(--subtle); font-size: 11px; font-weight: 650; overflow-wrap: anywhere; }
  .fact-list dd, .source-list dd { min-width: 0; overflow-wrap: anywhere; }
  .source-list dd { display: grid; justify-items: start; gap: 3px; }
  .source-list .value { white-space: pre-wrap; overflow-wrap: anywhere; }
  .member, .relation { display: grid; gap: 3px; min-width: 0; padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
  .member span { font-size: 12px; color: var(--muted); }
  .edit-form { display: grid; gap: 10px; min-width: 0; padding: 12px; background: var(--surface-raised); border-radius: 6px; }
  .edit-form > label, .inline-add label { min-width: 0; display: grid; gap: 4px; }
  .edit-form :is(input, textarea, select), .inline-add input { width: 100%; min-width: 0; }
  .edit-form textarea { min-height: 70px; }
  .inline-add, .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
  .inline-add label { flex: 1 1 135px; }
  .actions .check { display: flex; gap: 5px; align-items: center; flex-basis: 100%; font-weight: normal; }
  .actions .check input { width: auto; }
  .traversal { min-width: 0; display: grid; justify-items: start; gap: 8px; border-top: 1px solid var(--line); padding-top: 10px; }
  .traversal .relation { width: 100%; }
  .text-button { display: inline; width: fit-content; max-width: 100%; padding: 0; border: 0; background: none; color: var(--accent-ink); font: inherit; text-align: left; text-decoration: underline; overflow-wrap: anywhere; cursor: pointer; }
</style>
