<script module lang="ts">
  import type { AssetRecord, CandidateRecord, SlotRecord } from '@assetweave/contracts/catalog';
  import type { ReviewState, SelectionDisposition } from '@assetweave/contracts/decisions';

  interface Target { candidate: CandidateRecord; playbackRevisionId: string | null }
  interface ReviewDraft {
    nextState: ReviewState | ''; disposition: SelectionDisposition | '';
    replacementId: string; manualId: string; replacement: Target | null;
    expectedCandidateRevision: number; observedPlaybackRevisionId: string | null | undefined;
    expectedSlotRevision: number; rationale: string; conflict: boolean; needsRefresh: boolean; error: string;
  }
  interface SelectionDraft {
    candidateId: string; manualId: string; target: Target | null;
    expectedSlotRevision: number; observedPreviousPlaybackRevisionId: string | null | undefined;
    rationale: string; conflict: boolean; needsRefresh: boolean; error: string;
  }
  interface StageDraft {
    stage: string; expectedAssetRevision: number; rationale: string; conflict: boolean; needsRefresh: boolean; error: string;
  }

  // A tab may unmount this component. Keep unsent entries in memory, separately for each logical target.
  const reviewDrafts = new Map<string, ReviewDraft>();
  const selectionDrafts = new Map<string, SelectionDraft>();
  const stageDrafts = new Map<string, StageDraft>();
</script>

<script lang="ts">
  import type { ReviewCandidateInput, ReviewResult, SelectCandidateInput, SelectionResult,
    SetStageInput, SlotDecisionState, StageResult } from '@assetweave/contracts/decisions';
  import type { ClipRecord } from '@assetweave/contracts/playback';
  import { ApiClientError, type ApiClient } from '../../lib/api/client.js';

  let { api, candidate, slotRecord: slot, asset, alternatives, candidateLabels,
    viewedPlaybackRevisionId, historicalPlayback, onViewCurrentClip, onChanged }: {
    api: ApiClient; candidate: CandidateRecord | null; slotRecord: SlotRecord | null;
    asset: AssetRecord | null; alternatives: CandidateRecord[];
    candidateLabels: ReadonlyMap<string, { artifactName: string; clipName?: string | null }>;
    viewedPlaybackRevisionId?: string; historicalPlayback: boolean; onViewCurrentClip: () => void;
    onChanged: () => void;
  } = $props();

  let review = $state<ReviewDraft>({ nextState: '', disposition: '', replacementId: '', manualId: '',
    replacement: null, expectedCandidateRevision: 0, observedPlaybackRevisionId: undefined,
    expectedSlotRevision: 0, rationale: '', conflict: false, needsRefresh: false, error: '' });
  let selection = $state<SelectionDraft>({ candidateId: '', manualId: '', target: null,
    expectedSlotRevision: 0, observedPreviousPlaybackRevisionId: undefined,
    rationale: '', conflict: false, needsRefresh: false, error: '' });
  let stage = $state<StageDraft>({ stage: '', expectedAssetRevision: 0, rationale: '', conflict: false, needsRefresh: false, error: '' });
  let reviewKey = ''; let selectionKey = ''; let stageKey = '';
  let decision = $state<SlotDecisionState | null>(null);
  let latestCandidate = $state<CandidateRecord | null>(null);
  let latestAsset = $state<AssetRecord | null>(null);
  let latestReviewPlaybackId = $state<string | null | undefined>(undefined);
  let latestTargets = $state<Record<string, Target>>({});
  let decisionError = $state(''); let refreshError = $state('');
  let loading = $state(false); let saving = $state(false);
  let generation = 0;

  const reviewStates: { value: ReviewState; label: string }[] = [
    { value: 'unreviewed', label: 'Unreviewed' },
    { value: 'reviewed-undecided', label: 'Reviewed, undecided' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
  ];
  const label = (value: ReviewState) => reviewStates.find(item => item.value === value)?.label ?? value;
  function candidateLabel(candidateId: string, _artifactId?: string, clipId?: string | null): string {
    const names = candidateLabels.get(candidateId);
    const artifactName = names?.artifactName.trim();
    const targetName = clipId === null ? 'Whole artwork' : clipId ? names?.clipName?.trim() : null;
    return artifactName && targetName ? `${artifactName} · ${targetName} · #${candidateId.slice(0, 8)}` : candidateId;
  }
  const message = (error: unknown) => error instanceof Error ? error.message : 'The local service could not save this decision.';
  const isConflict = (error: unknown) => error instanceof ApiClientError && error.status === 409;
  const idPath = (id: string) => encodeURIComponent(id);
  function saveReview() { if (reviewKey) reviewDrafts.set(reviewKey, { ...review }); }
  function saveSelection() { if (selectionKey) selectionDrafts.set(selectionKey, { ...selection }); }
  function saveStage() { if (stageKey) stageDrafts.set(stageKey, { ...stage }); }

  const currentCandidate = $derived(candidate && latestCandidate?.id === candidate.id &&
    latestCandidate.revision >= candidate.revision ? latestCandidate : candidate);
  const currentAsset = $derived(asset && latestAsset?.id === asset.id &&
    latestAsset.revision >= asset.revision ? latestAsset : asset);
  const selectedRejection = $derived(review.nextState === 'rejected' && !!candidate &&
    decision?.slot.selectedCandidateId === candidate.id);
  const choices = $derived.by(() => {
    const found = new Map<string, CandidateRecord>();
    if (slot) {
      for (const item of alternatives) if (item.slotId === slot.id) found.set(item.id, item);
      if (candidate?.slotId === slot.id) found.set(candidate.id, currentCandidate ?? candidate);
      if (decision?.selected?.candidate.slotId === slot.id) found.set(decision.selected.candidate.id, decision.selected.candidate);
      for (const item of [selection.target, review.replacement]) {
        if (item?.candidate.slotId === slot.id) found.set(item.candidate.id, item.candidate);
      }
    }
    return [...found.values()];
  });
  const viewedCurrentPlayback = $derived(!candidate?.clipId ||
    (!!viewedPlaybackRevisionId && viewedPlaybackRevisionId === latestReviewPlaybackId));
  const reviewPlaybackReady = $derived(viewedCurrentPlayback &&
    (!candidate?.clipId || review.observedPlaybackRevisionId === viewedPlaybackRevisionId));
  // A fetched current revision is not an observation; the viewer must actually draw its frames.
  $effect(() => {
    if (candidate?.clipId && reviewKey === `${slot?.id}:${candidate.id}` &&
        !review.conflict && !review.needsRefresh && review.observedPlaybackRevisionId === undefined &&
        viewedPlaybackRevisionId && viewedPlaybackRevisionId === latestReviewPlaybackId) {
      review.observedPlaybackRevisionId = viewedPlaybackRevisionId;
      saveReview();
    }
  });
  const reviewDrift = $derived.by(() => {
    const replacement = latestTargets[review.replacementId];
    return !!candidate && (review.expectedCandidateRevision !== currentCandidate?.revision ||
      (!!candidate.clipId && latestReviewPlaybackId !== undefined &&
        review.observedPlaybackRevisionId !== latestReviewPlaybackId) ||
      (review.nextState === 'rejected' && review.expectedSlotRevision !== decision?.slot.revision) ||
      (selectedRejection && review.disposition === 'replace' && !!review.replacementId && !!replacement &&
        (review.replacement?.candidate.revision !== replacement.candidate.revision ||
          review.replacement?.playbackRevisionId !== replacement.playbackRevisionId)));
  });
  const slotSelectionDrift = $derived(!!slot && (selection.expectedSlotRevision !== decision?.slot.revision ||
    (!!decision?.selected?.candidate.clipId &&
      selection.observedPreviousPlaybackRevisionId !== decision.selected.playback?.id)));
  const selectionDrift = $derived.by(() => {
    const target = latestTargets[selection.candidateId];
    return slotSelectionDrift || (!!selection.candidateId && !!target &&
      (selection.target?.candidate.revision !== target.candidate.revision ||
        selection.target?.playbackRevisionId !== target.playbackRevisionId));
  });
  const stageDrift = $derived(!!asset && stage.expectedAssetRevision !== currentAsset?.revision);

  // Identity changes restore that target's draft. New data only updates the displayed records;
  // an existing draft's observed revisions never advance without the user's explicit adoption.
  $effect(() => {
    const client = api;
    const slotId = slot?.id ?? '';
    const candidateId = candidate?.id ?? '';
    const assetId = asset?.id ?? '';
    const revisions = [slot?.revision, candidate?.revision, asset?.revision, alternatives];
    const nextReviewKey = slotId && candidate?.slotId === slotId ? `${slotId}:${candidateId}` : '';
    if (nextReviewKey !== reviewKey) {
      reviewKey = nextReviewKey;
      latestReviewPlaybackId = undefined;
      review = nextReviewKey ? { ...(reviewDrafts.get(nextReviewKey) ?? {
        nextState: '', disposition: '', replacementId: '', manualId: '', replacement: null,
        expectedCandidateRevision: candidate!.revision, observedPlaybackRevisionId: candidate!.clipId ? undefined : null,
        expectedSlotRevision: slot!.revision, rationale: '', conflict: false, needsRefresh: false, error: '',
      }) } : review;
    }
    if (slotId !== selectionKey) {
      selectionKey = slotId;
      decision = null; decisionError = '';
      selection = slotId ? { ...(selectionDrafts.get(slotId) ?? {
        candidateId: '', manualId: '', target: null, expectedSlotRevision: slot!.revision,
        observedPreviousPlaybackRevisionId: undefined, rationale: '', conflict: false, needsRefresh: false, error: '',
      }) } : selection;
    }
    if (assetId !== stageKey) {
      stageKey = assetId;
      stage = assetId ? { ...(stageDrafts.get(assetId) ?? {
        stage: asset!.stage ?? '', expectedAssetRevision: asset!.revision,
        rationale: '', conflict: false, needsRefresh: false, error: '',
      }) } : stage;
    }
    void revisions;
    void refreshLatest(client, slotId, candidateId, assetId);
  });

  async function fetchTarget(client: ApiClient, id: string, slotId: string): Promise<Target> {
    const found = await client.get<CandidateRecord>(`/api/candidates/${idPath(id)}`);
    if (found.slotId !== slotId) throw new Error('This candidate belongs to another slot; no decision was recorded.');
    const playbackRevisionId = found.clipId
      ? (await client.get<ClipRecord>(`/api/clips/${idPath(found.clipId)}`)).currentRevisionId : null;
    return { candidate: found, playbackRevisionId };
  }

  async function refreshLatest(client = api, slotId = slot?.id ?? '', candidateId = candidate?.id ?? '',
    assetId = asset?.id ?? '') {
    const run = ++generation;
    loading = true; refreshError = ''; decisionError = '';
    if (!slotId) decision = null;
    if (!candidateId) { latestCandidate = null; latestReviewPlaybackId = undefined; }
    if (!assetId) latestAsset = null;
    const [slotResult, candidateResult, assetResult] = await Promise.allSettled([
      slotId ? client.get<SlotDecisionState>(`/api/slots/${idPath(slotId)}/decision`) : Promise.resolve(null),
      candidateId ? client.get<CandidateRecord>(`/api/candidates/${idPath(candidateId)}`) : Promise.resolve(null),
      assetId ? client.get<AssetRecord>(`/api/assets/${idPath(assetId)}`) : Promise.resolve(null),
    ]);
    if (run !== generation || client !== api || slotId !== (slot?.id ?? '') ||
      candidateId !== (candidate?.id ?? '') || assetId !== (asset?.id ?? '')) return;
    if (slotResult.status === 'fulfilled') {
      decision = slotResult.value;
      if (slotResult.value && selection.observedPreviousPlaybackRevisionId === undefined) {
        const selected = slotResult.value.selected;
        if (!selected?.candidate.clipId || selected.playback) {
          selection.observedPreviousPlaybackRevisionId = selected?.playback?.id ?? null;
          saveSelection();
        }
      }
    } else { decision = null; decisionError = message(slotResult.reason); }
    if (candidateResult.status === 'fulfilled') latestCandidate = candidateResult.value;
    else refreshError = `Viewed candidate could not be refreshed: ${message(candidateResult.reason)}`;
    if (assetResult.status === 'fulfilled') latestAsset = assetResult.value;
    else refreshError += `${refreshError ? ' ' : ''}Asset could not be refreshed: ${message(assetResult.reason)}`;
    const candidateClip = candidateResult.status === 'fulfilled' ? candidateResult.value?.clipId : null;
    const targetIds = slotId ? [...new Set([selection.candidateId, review.replacementId].filter(Boolean))] : [];
    const [[clipResult], targetResults] = await Promise.all([
      Promise.allSettled([candidateClip
        ? client.get<ClipRecord>(`/api/clips/${idPath(candidateClip)}`) : Promise.resolve(null)]),
      Promise.allSettled(targetIds.map(id => fetchTarget(client, id, slotId))),
    ]);
    if (run !== generation || client !== api || slotId !== (slot?.id ?? '') ||
      candidateId !== (candidate?.id ?? '') || assetId !== (asset?.id ?? '')) return null;
    if (clipResult.status === 'fulfilled' && candidateResult.status === 'fulfilled') {
      latestReviewPlaybackId = candidateClip ? clipResult.value?.currentRevisionId : null;
    } else if (clipResult.status === 'rejected') {
      latestReviewPlaybackId = undefined;
      refreshError += `${refreshError ? ' ' : ''}Viewed clip could not be refreshed: ${message(clipResult.reason)}`;
    } else latestReviewPlaybackId = undefined;
    for (const [index, result] of targetResults.entries()) {
      const targetId = targetIds[index];
      if (!targetId) { refreshError += ' A candidate lookup returned without its requested ID.'; continue; }
      if (result.status === 'fulfilled') latestTargets = { ...latestTargets, [targetId]: result.value };
      else refreshError += `${refreshError ? ' ' : ''}Candidate ${targetId} could not be verified: ${message(result.reason)}`;
    }
    loading = false;
    const targetReady = (id: string) => !id || targetResults[targetIds.indexOf(id)]?.status === 'fulfilled';
    return {
      review: slotResult.status === 'fulfilled' && candidateResult.status === 'fulfilled' &&
        clipResult.status === 'fulfilled' &&
        (!selectedRejection || review.disposition !== 'replace' || targetReady(review.replacementId)),
      selection: slotResult.status === 'fulfilled' && targetReady(selection.candidateId),
      stage: assetResult.status === 'fulfilled',
    };
  }

  async function refreshForAdoption() {
    const refreshed = await refreshLatest();
    if (!refreshed) return;
    if (refreshed.review && review.needsRefresh) { review.needsRefresh = false; saveReview(); }
    if (refreshed.selection && selection.needsRefresh) { selection.needsRefresh = false; saveSelection(); }
    if (refreshed.stage && stage.needsRefresh) { stage.needsRefresh = false; saveStage(); }
  }

  async function chooseTarget(id: string, kind: 'selection' | 'replacement') {
    const slotId = slot?.id;
    const originalReviewKey = reviewKey;
    if (!slotId || !id) return;
    if (kind === 'selection') { selection.candidateId = id; selection.target = null; selection.error = ''; saveSelection(); }
    else { review.replacementId = id; review.replacement = null; review.error = ''; saveReview(); }
    try {
      const target = await fetchTarget(api, id, slotId);
      if (slot?.id !== slotId || (kind === 'replacement' && originalReviewKey !== reviewKey) ||
        (kind === 'selection' ? selection.candidateId : review.replacementId) !== id) return;
      latestTargets = { ...latestTargets, [id]: target };
      if (kind === 'selection') { selection.target = target; saveSelection(); }
      else { review.replacement = target; saveReview(); }
    } catch (cause) {
      if (slot?.id !== slotId || (kind === 'replacement' && originalReviewKey !== reviewKey) ||
        (kind === 'selection' ? selection.candidateId : review.replacementId) !== id) return;
      if (kind === 'selection') { selection.error = message(cause); saveSelection(); }
      else { review.error = message(cause); saveReview(); }
    }
  }
  function onSelectionChoice(id: string) {
    selection.manualId = '';
    if (!id) { selection.candidateId = ''; selection.target = null; selection.error = ''; saveSelection(); return; }
    void chooseTarget(id, 'selection');
  }
  function onReplacementChoice(id: string) {
    review.manualId = '';
    if (!id) { review.replacementId = ''; review.replacement = null; review.error = ''; saveReview(); return; }
    void chooseTarget(id, 'replacement');
  }
  function adoptReview() {
    if (!candidate || !currentCandidate || !decision || loading || review.needsRefresh) return;
    if (candidate.clipId && !viewedCurrentPlayback) return;
    if (selectedRejection && review.disposition === 'replace' &&
      (!review.replacementId || !latestTargets[review.replacementId])) return;
    review.expectedCandidateRevision = currentCandidate.revision;
    review.observedPlaybackRevisionId = currentCandidate.clipId ? viewedPlaybackRevisionId : null;
    review.expectedSlotRevision = decision.slot.revision;
    const replacement = latestTargets[review.replacementId];
    if (review.replacementId && replacement) review.replacement = replacement;
    review.conflict = false; review.needsRefresh = false; review.error = ''; saveReview();
  }
  function adoptSelection() {
    if (!decision || loading || selection.needsRefresh) return;
    if (decision.selected?.candidate.clipId && !decision.selected.playback) return;
    if (selection.candidateId && !latestTargets[selection.candidateId]) return;
    selection.expectedSlotRevision = decision.slot.revision;
    selection.observedPreviousPlaybackRevisionId = decision.selected?.playback?.id ?? null;
    const target = latestTargets[selection.candidateId];
    if (selection.candidateId && target) selection.target = target;
    selection.conflict = false; selection.needsRefresh = false; selection.error = ''; saveSelection();
  }
  function adoptStage() {
    if (!currentAsset || loading || stage.needsRefresh) return;
    stage.expectedAssetRevision = currentAsset.revision;
    stage.conflict = false; stage.needsRefresh = false; stage.error = ''; saveStage();
  }
  function changed() { onChanged(); }

  async function submitReview(event: SubmitEvent) {
    event.preventDefault();
    if (!candidate || !slot || candidate.slotId !== slot.id || !decision || !review.nextState ||
      review.conflict || reviewDrift || !reviewPlaybackReady || saving || loading ||
      review.observedPlaybackRevisionId === undefined) return;
    if (selectedRejection && (!review.disposition ||
      (review.disposition === 'replace' && (!review.replacement || review.replacement.candidate.id !== review.replacementId)))) return;
    saving = true; review.error = ''; saveReview();
    const body: ReviewCandidateInput = {
      expectedCandidateRevision: review.expectedCandidateRevision, nextState: review.nextState,
      ...(candidate.clipId ? { observedPlaybackRevisionId: review.observedPlaybackRevisionId! } : {}),
      ...(selectedRejection ? { expectedSlotRevision: review.expectedSlotRevision,
        disposition: review.disposition as SelectionDisposition } : {}),
      ...(selectedRejection && review.disposition === 'replace' && review.replacement ? {
        replacementCandidateId: review.replacement.candidate.id,
        expectedReplacementCandidateRevision: review.replacement.candidate.revision,
        ...(review.replacement.candidate.clipId ? {
          observedReplacementPlaybackRevisionId: review.replacement.playbackRevisionId!,
        } : {}),
      } : {}),
      ...(review.rationale ? { rationale: review.rationale } : {}),
    };
    const submittedDraft = review;
    const submittedKey = reviewKey;
    let saved = false;
    try {
      const result = await api.mutate<ReviewResult>(`/api/candidates/${idPath(candidate.id)}/review`, 'PATCH', body);
      if (candidate.id === result.candidate.id && slot.id === candidate.slotId) {
        latestCandidate = result.candidate;
        review.expectedCandidateRevision = result.candidate.revision;
        review.nextState = ''; review.disposition = ''; review.replacementId = '';
        review.manualId = ''; review.replacement = null; review.rationale = ''; review.conflict = false; saveReview();
        if (result.selection) {
          decision = result.selection;
          selection.expectedSlotRevision = result.selection.slot.revision;
          selection.observedPreviousPlaybackRevisionId = result.selection.selected?.playback?.id ?? null;
          saveSelection();
        }
      }
      saved = true;
    } catch (cause) {
      submittedDraft.conflict = isConflict(cause);
      submittedDraft.needsRefresh = submittedDraft.conflict;
      submittedDraft.error = `${message(cause)} ${submittedDraft.conflict ? 'Refresh latest, inspect it, then explicitly use its revisions before resubmitting.' : 'Your entries were kept.'}`;
      reviewDrafts.set(submittedKey, { ...submittedDraft });
    } finally { saving = false; }
    if (saved) changed();
  }

  async function submitSelection(nextCandidateId: string | null) {
    if (!slot || !decision || selection.conflict || (nextCandidateId ? selectionDrift : slotSelectionDrift) || saving || loading) return;
    if (nextCandidateId && (selection.target?.candidate.id !== nextCandidateId ||
      (selection.target.candidate.clipId && !selection.target.playbackRevisionId))) return;
    if (decision.selected?.candidate.clipId && !selection.observedPreviousPlaybackRevisionId) return;
    saving = true; selection.error = ''; saveSelection();
    const body: SelectCandidateInput = {
      expectedSlotRevision: selection.expectedSlotRevision, nextCandidateId,
      ...(nextCandidateId && selection.target ? {
        expectedCandidateRevision: selection.target.candidate.revision,
        ...(selection.target.candidate.clipId ? { observedPlaybackRevisionId: selection.target.playbackRevisionId! } : {}),
      } : {}),
      ...(decision.selected?.candidate.clipId ? {
        observedPreviousPlaybackRevisionId: selection.observedPreviousPlaybackRevisionId!,
      } : {}),
      ...(selection.rationale ? { rationale: selection.rationale } : {}),
    };
    const submittedDraft = selection;
    const submittedKey = selectionKey;
    let saved = false;
    try {
      const result = await api.mutate<SelectionResult>(`/api/slots/${idPath(slot.id)}/selection`, 'PATCH', body);
      if (slot.id === result.selection.slot.id) {
        decision = result.selection;
        selection.expectedSlotRevision = result.selection.slot.revision;
        selection.observedPreviousPlaybackRevisionId = result.selection.selected?.playback?.id ?? null;
        selection.candidateId = ''; selection.manualId = ''; selection.target = null;
        selection.rationale = ''; selection.conflict = false; saveSelection();
      }
      saved = true;
    } catch (cause) {
      submittedDraft.conflict = isConflict(cause);
      submittedDraft.needsRefresh = submittedDraft.conflict;
      submittedDraft.error = `${message(cause)} ${submittedDraft.conflict ? 'Refresh latest, inspect it, then explicitly use its revisions before resubmitting.' : 'Your entries were kept.'}`;
      selectionDrafts.set(submittedKey, { ...submittedDraft });
    } finally { saving = false; }
    if (saved) changed();
  }

  async function submitStage(nextStage: string | null) {
    if (!asset || (slot && slot.assetId !== asset.id) || stage.conflict || stageDrift || saving || loading) return;
    saving = true; stage.error = ''; saveStage();
    const body: SetStageInput = { expectedAssetRevision: stage.expectedAssetRevision, stage: nextStage,
      ...(stage.rationale ? { rationale: stage.rationale } : {}) };
    const submittedDraft = stage;
    const submittedKey = stageKey;
    let saved = false;
    try {
      const result = await api.mutate<StageResult>(`/api/assets/${idPath(asset.id)}/stage`, 'PATCH', body);
      if (asset.id === result.asset.id) {
        latestAsset = result.asset; stage.expectedAssetRevision = result.asset.revision;
        stage.stage = result.asset.stage ?? ''; stage.rationale = ''; stage.conflict = false; saveStage();
      }
      saved = true;
    } catch (cause) {
      submittedDraft.conflict = isConflict(cause);
      submittedDraft.needsRefresh = submittedDraft.conflict;
      submittedDraft.error = `${message(cause)} ${submittedDraft.conflict ? 'Refresh latest, inspect it, then explicitly use its revision before resubmitting.' : 'Your entries were kept.'}`;
      stageDrafts.set(submittedKey, { ...submittedDraft });
    } finally { saving = false; }
    if (saved) changed();
  }
</script>

<section class="decision-panel" aria-label="Human decisions">
  <h3>Review and working choice</h3>
  <p class="hint">Viewing artwork or choosing a clip never records a decision. Reviews and slot choices are separate; multiple candidates may be approved. This paired browser records each deliberate action as human authority.</p>
  {#if loading}<p role="status" class="hint">Reading latest decisions and playback revisions…</p>{/if}
  {#if refreshError}<p role="alert" class="notice">{refreshError} <button class="quiet-button" type="button" disabled={loading || saving} onclick={() => void refreshForAdoption()}>Refresh latest records</button></p>{/if}
  {#if slot}
    <div class="current-status">
      {#if candidate?.slotId === slot.id}
        <p><strong>Viewed review:</strong> {candidateLabel(candidate.id, candidate.artifactId, candidate.clipId)} · {label(currentCandidate?.reviewState ?? candidate.reviewState)}.
          {candidate.id === decision?.slot.selectedCandidateId ? 'It is the current selection.' : 'It is not the current selection.'}
          {#if candidate.clipId} Named clip · viewer displayed playback revision {viewedPlaybackRevisionId ?? (historicalPlayback ? 'historical (not eligible for a current review)' : 'not loaded')} · service current revision {latestReviewPlaybackId ?? 'unavailable'}.{/if}</p>
      {:else}<p>No placement for the viewed artwork in this slot was supplied. Review actions are unavailable until a slot candidate is opened.</p>{/if}
      {#if decisionError}<p role="alert" class="notice">Slot decision unavailable: {decisionError} <button class="quiet-button" type="button" disabled={loading || saving} onclick={() => void refreshForAdoption()}>Refresh slot decision</button></p>
      {:else if decision}
        <p><strong>Current selection:</strong> {decision.selected
          ? candidateLabel(decision.selected.candidate.id, decision.selected.candidate.artifactId, decision.selected.candidate.clipId)
          : 'None recorded'}.
          {#if decision.selected}<strong>Selected candidate review:</strong> {label(decision.selected.candidate.reviewState)}.
            {#if decision.selected.candidate.clipId} Named clip · current playback revision {decision.selected.playback?.revision ?? 'unavailable'}.{/if}
          {/if}
        </p>
      {/if}
      <p class="hint"><strong>Purpose:</strong> {slot.name} · logical asset {asset?.id === slot.assetId ? asset.name : slot.assetId}</p>
      {#if candidate?.slotId === slot.id || decision?.selected}
        <details class="target-details"><summary>Target IDs and playback</summary>
          <dl>
            {#if candidate?.slotId === slot.id}<dt>Viewed candidate</dt><dd><code>{candidate.id}</code></dd>
              <dt>Artwork</dt><dd><code>{candidate.artifactId}</code></dd>
              {#if candidate.clipId}<dt>Named clip</dt><dd><code>{candidate.clipId}</code></dd>{/if}
            {/if}
            {#if decision?.selected}<dt>Selected candidate</dt><dd><code>{decision.selected.candidate.id}</code></dd>
              {#if decision.selected.candidate.clipId}<dt>Selected clip</dt><dd><code>{decision.selected.candidate.clipId}</code></dd>{/if}
            {/if}
          </dl>
        </details>
      {/if}
    </div>
    {#if choices.length}
      <details class="candidate-details"><summary>{choices.length} loaded candidate{choices.length === 1 ? '' : 's'} in this slot · additional pages may exist</summary>
        <ul>{#each choices as choice (choice.id)}
          <li><span>{candidateLabel(choice.id, choice.artifactId, choice.clipId)} · {label(choice.reviewState)}{choice.id === decision?.slot.selectedCandidateId ? ' · selected' : ''}</span><code>{choice.id}</code></li>
        {/each}</ul>
      </details>
    {/if}
    {#if candidate?.slotId === slot.id}
      <form class="decision-form" onsubmit={submitReview}>
        <h4>Record this candidate’s review</h4>
        {#if candidate.clipId && !viewedCurrentPlayback}
          <p class="notice" role="status">{historicalPlayback
            ? 'Historical playback is open. Review of the current clip is unavailable until you explicitly view and load the current clip.'
            : viewedPlaybackRevisionId
              ? 'The displayed clip revision differs from the service’s latest revision. Reload the current clip and inspect its frames before reviewing.'
              : 'Current clip frames have not been displayed. Wait for playback to load, or reload the current clip before reviewing.'}</p>
          <div class="actions"><button class="quiet-button" type="button" disabled={saving} onclick={onViewCurrentClip}>{historicalPlayback ? 'View current clip' : 'Reload current clip'}</button>
            {#if !historicalPlayback && viewedPlaybackRevisionId}<button class="quiet-button" type="button" disabled={saving || loading} onclick={() => void refreshForAdoption()}>Refresh latest revision</button>{/if}</div>
        {/if}
        <label>Review decision
          <select value={review.nextState} onchange={event => { review.nextState = event.currentTarget.value as ReviewState | ''; review.disposition = ''; saveReview(); }}>
            <option value="">Choose an explicit decision</option>
            {#each reviewStates as state}<option value={state.value}>{state.label}</option>{/each}
          </select>
        </label>
        {#if review.nextState === 'rejected' && review.disposition && !selectedRejection}
          <p class="notice">The previously chosen {review.disposition} disposition no longer applies: this candidate is not currently selected. Inspect the latest slot choice before recording this review.</p>
        {/if}
        {#if selectedRejection}
          <fieldset><legend>Rejecting the selected candidate: what happens to the working choice?</legend>
            <label><input type="radio" name="rejection-disposition" value="keep" checked={review.disposition === 'keep'} onchange={() => { review.disposition = 'keep'; saveReview(); }} /> Keep rejected candidate selected</label>
            <label><input type="radio" name="rejection-disposition" value="clear" checked={review.disposition === 'clear'} onchange={() => { review.disposition = 'clear'; saveReview(); }} /> Clear selection</label>
            <label><input type="radio" name="rejection-disposition" value="replace" checked={review.disposition === 'replace'} onchange={() => { review.disposition = 'replace'; saveReview(); }} /> Replace with another candidate in this slot</label>
          </fieldset>
          {#if review.disposition === 'replace'}
            <label>Replacement from loaded candidates
              <select value={review.replacementId} onchange={event => onReplacementChoice(event.currentTarget.value)}>
                <option value="">Choose a candidate</option>
                {#each choices.filter(item => item.id !== candidate.id) as choice (choice.id)}
                  <option value={choice.id}>{candidateLabel(choice.id, choice.artifactId, choice.clipId)} · {label(choice.reviewState)}</option>
                {/each}
              </select>
            </label>
            <div class="lookup"><label>Candidate ID not in loaded results
              <input value={review.manualId} placeholder="Paste candidate ID" spellcheck="false" oninput={event => { review.manualId = event.currentTarget.value; saveReview(); }} />
            </label><button class="quiet-button" type="button" disabled={!review.manualId.trim() || saving} onclick={() => void chooseTarget(review.manualId.trim(), 'replacement')}>Verify replacement ID</button></div>
            <p class="hint">{review.replacement?.candidate.id === review.replacementId ? `Verified replacement: ${candidateLabel(review.replacementId, review.replacement.candidate.artifactId, review.replacement.candidate.clipId)} · ${label(review.replacement.candidate.reviewState)}.` : 'Choose or verify a candidate before recording the rejection. Loaded results are not the whole slot.'}</p>
          {/if}
        {/if}
        <label>Rationale (optional)<textarea rows="2" maxlength="16384" value={review.rationale} oninput={event => { review.rationale = event.currentTarget.value; saveReview(); }}></textarea></label>
        {#if review.error || review.conflict || reviewDrift}<p class="notice" role="status">Your review entries are retained. Latest review: {currentCandidate ? label(currentCandidate.reviewState) : 'unavailable'} · candidate revision {currentCandidate?.revision ?? 'unavailable'}; slot revision {decision?.slot.revision ?? 'unavailable'}. Refresh and inspect before adopting newer revisions.</p>
          <div class="actions"><button class="quiet-button" type="button" disabled={loading || saving} onclick={() => void refreshForAdoption()}>Refresh latest</button>
            <button class="quiet-button" type="button" disabled={loading || saving || review.needsRefresh || !decision || !currentCandidate || !viewedCurrentPlayback || (selectedRejection && review.disposition === 'replace' && !latestTargets[review.replacementId])} onclick={adoptReview}>Use latest for review draft</button></div>{/if}
        {#if review.error}<p role="alert" class="notice">{review.error}</p>{/if}
        <button class="primary-button" type="submit" disabled={saving || loading || !decision || !review.nextState || review.conflict || reviewDrift || !reviewPlaybackReady || review.observedPlaybackRevisionId === undefined || (selectedRejection && (!review.disposition || (review.disposition === 'replace' && (review.replacement?.candidate.id !== review.replacementId || review.replacementId === candidate.id || (!!review.manualId.trim() && review.manualId.trim() !== review.replacementId)))))}>{saving ? 'Saving…' : 'Record review'}</button>
      </form>
    {/if}
    <div class="decision-form">
      <h4>Choose the current working candidate</h4>
      <p class="hint">Unreviewed, rejected, and approved candidates may all be selected. This does not change anyone’s review state.</p>
      <label>Candidate in this slot
        <select value={selection.candidateId} onchange={event => onSelectionChoice(event.currentTarget.value)}>
          <option value="">Choose a candidate to select</option>
          {#each choices as choice (choice.id)}<option value={choice.id}>{candidateLabel(choice.id, choice.artifactId, choice.clipId)} · {label(choice.reviewState)}</option>{/each}
        </select>
      </label>
      <div class="lookup"><label>Candidate ID not in loaded results
        <input value={selection.manualId} placeholder="Paste candidate ID" spellcheck="false" oninput={event => { selection.manualId = event.currentTarget.value; saveSelection(); }} />
      </label><button class="quiet-button" type="button" disabled={!selection.manualId.trim() || saving} onclick={() => void chooseTarget(selection.manualId.trim(), 'selection')}>Verify candidate ID</button></div>
      {#if selection.target?.candidate.id === selection.candidateId}<p class="hint">Verified: {candidateLabel(selection.candidateId, selection.target.candidate.artifactId, selection.target.candidate.clipId)} · {label(selection.target.candidate.reviewState)}{selection.target.candidate.reviewState === 'rejected' ? '. Selecting a rejected candidate is a deliberate working choice.' : '.'}</p>
      {:else}<p class="hint">Select a loaded candidate or verify an ID before recording a choice. Additional candidates may exist beyond this page.</p>{/if}
      <label>Rationale (optional)<textarea rows="2" maxlength="16384" value={selection.rationale} oninput={event => { selection.rationale = event.currentTarget.value; saveSelection(); }}></textarea></label>
      {#if selection.error || selection.conflict || selectionDrift}<p class="notice" role="status">Your selection entries are retained. Latest selection: {decision?.selected
          ? candidateLabel(decision.selected.candidate.id, decision.selected.candidate.artifactId, decision.selected.candidate.clipId)
          : 'None recorded'} · slot revision {decision?.slot.revision ?? 'unavailable'}. Refresh and inspect before adopting newer revisions.</p>
        <div class="actions"><button class="quiet-button" type="button" disabled={loading || saving} onclick={() => void refreshForAdoption()}>Refresh latest</button>
          <button class="quiet-button" type="button" disabled={loading || saving || selection.needsRefresh || !decision || (!!decision.selected?.candidate.clipId && !decision.selected.playback) || (!!selection.candidateId && !latestTargets[selection.candidateId])} onclick={adoptSelection}>Use latest for selection draft</button></div>{/if}
      {#if selection.error}<p role="alert" class="notice">{selection.error}</p>{/if}
      <div class="actions"><button class="primary-button" type="button" disabled={saving || loading || !decision || !selection.candidateId || !selection.target || selection.target.candidate.id !== selection.candidateId || (selection.target.candidate.clipId && !selection.target.playbackRevisionId) || selection.candidateId === decision.slot.selectedCandidateId || (!!selection.manualId.trim() && selection.manualId.trim() !== selection.candidateId) || selection.conflict || selectionDrift} onclick={() => void submitSelection(selection.candidateId)}>Record selection</button>
        <button class="quiet-button" type="button" disabled={saving || loading || !decision?.selected || selection.conflict || slotSelectionDrift || (!!decision.selected.candidate.clipId && !selection.observedPreviousPlaybackRevisionId)} onclick={() => void submitSelection(null)}>Explicitly clear selection</button></div>
    </div>
  {:else}<p class="hint">Choose a named slot to review a candidate or set its working selection.</p>{/if}

  <div class="decision-form">
    <h4>Human-set stage</h4>
    {#if asset && (!slot || slot.assetId === asset.id)}
      <p>Logical asset: {currentAsset?.name ?? asset.name} · ID {asset.id}. <strong>Current human stage:</strong> {currentAsset?.stage ?? 'None recorded'}.</p>
      <p class="hint">Stage is optional and describes this logical asset only; it is never derived from captured artwork or its owner.</p>
      <label>New human stage<input maxlength="200" value={stage.stage} placeholder="Enter your stage label" oninput={event => { stage.stage = event.currentTarget.value; saveStage(); }} /></label>
      <label>Rationale (optional)<textarea rows="2" maxlength="16384" value={stage.rationale} oninput={event => { stage.rationale = event.currentTarget.value; saveStage(); }}></textarea></label>
      {#if stage.error || stage.conflict || stageDrift}<p class="notice" role="status">Your stage entry is retained. Latest human stage: {currentAsset?.stage ?? 'None recorded'} · asset revision {currentAsset?.revision ?? 'unavailable'}. Refresh and inspect before adopting the newer revision.</p>
        <div class="actions"><button class="quiet-button" type="button" disabled={loading || saving} onclick={() => void refreshForAdoption()}>Refresh latest</button>
          <button class="quiet-button" type="button" disabled={loading || saving || stage.needsRefresh || !currentAsset} onclick={adoptStage}>Use latest for stage draft</button></div>{/if}
      {#if stage.error}<p role="alert" class="notice">{stage.error}</p>{/if}
      <div class="actions"><button class="primary-button" type="button" disabled={saving || loading || !stage.stage.trim() || stage.stage.trim() === currentAsset?.stage || stage.conflict || stageDrift} onclick={() => void submitStage(stage.stage.trim())}>Set human stage</button>
        <button class="quiet-button" type="button" disabled={saving || loading || !currentAsset?.stage || stage.conflict || stageDrift} onclick={() => void submitStage(null)}>Explicitly clear stage</button></div>
    {:else}<p class="hint">{slot ? 'The logical asset for this slot is unavailable; stage changes are disabled, even if the captured artwork belongs to another asset.' : 'Open a logical asset to set its human stage.'}</p>{/if}
  </div>
</section>

<style>
  .decision-panel { display: grid; gap: 14px; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
  .decision-panel h3 { margin: 0; } .decision-panel h4 { margin: 0; font-size: 13px; }
  .decision-panel p { margin: 0; line-height: 1.5; }
  .hint { color: var(--muted); }
  .current-status, .decision-form { display: grid; gap: 9px; min-width: 0; padding: 12px 0; border-top: 1px solid var(--line); }
  .current-status { padding-top: 4px; border-top: 0; }
  .candidate-details, .target-details { min-width: 0; color: var(--muted); font-size: 12px; }
  .candidate-details summary, .target-details summary { cursor: pointer; }
  .candidate-details ul { display: grid; gap: 0; list-style: none; margin: 8px 0 0; padding: 0; }
  .candidate-details li { display: grid; gap: 2px; padding: 6px 0; border-top: 1px solid var(--line); }
  .target-details dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 9px; margin: 8px 0 0; }
  .candidate-details code, .target-details code { font-size: 11px; overflow-wrap: anywhere; }
  .target-details dd { min-width: 0; }
  .decision-form label { display: grid; gap: 5px; min-width: 0; }
  .decision-form input:not([type='radio']), .decision-form select, .decision-form textarea { width: 100%; }
  .decision-form fieldset { display: grid; gap: 9px; margin: 0; }
  .decision-form fieldset label { display: flex; align-items: flex-start; gap: 8px; font-weight: 400; }
  .decision-form fieldset input { flex: none; margin: 3px 0 0; accent-color: var(--accent); }
  .lookup { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
  .lookup label { flex: 1 1 170px; } .lookup button { flex: 0 0 auto; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .notice { padding: 9px 10px; border-left: 3px solid var(--status-rejected-ink); border-radius: 5px; background: var(--surface-raised); }
</style>
