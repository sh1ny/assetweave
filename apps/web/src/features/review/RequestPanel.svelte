<script module lang="ts">
  import type { ExactInput } from '@assetweave/contracts/production';

  interface RequestDraft {
    intent: string;
    notes: string;
    slotId: string;
    proposedInputs: ExactInput[];
    inputArtifactId: string;
    inputClipId: string;
    inputRole: string;
    lookupId: string;
  }
  interface OutcomeDraft {
    expectedRevision: number;
    status: '' | 'succeeded' | 'failed' | 'cancelled';
    notes: string;
  }
  // Keep unsent entries when the inspector switches tabs. Never persist private notes to a URL or storage.
  const requestDrafts = new Map<string, RequestDraft>();
  const outcomeDrafts = new Map<string, OutcomeDraft>();
  function freshDraft(slotId?: string): RequestDraft {
    return { intent: '', notes: '', slotId: slotId ?? '', proposedInputs: [],
      inputArtifactId: '', inputClipId: '', inputRole: '', lookupId: '' };
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { catalogId, type SlotRecord } from '@assetweave/contracts/catalog';
  import type { CaptureRecord } from '@assetweave/contracts/capture';
  import type { ClipRecord } from '@assetweave/contracts/playback';
  import { createRequestInput, exactInput, reportOutcomeInput,
    type OutcomeReport, type ProposedInputRecord, type RequestRecord } from '@assetweave/contracts/production';
  import type { QueryPage } from '@assetweave/contracts/queries';
  import { ApiClientError, type ApiClient } from '../../lib/api/client.js';
  import { navigationHref, type NavigationState } from '../../lib/navigation.js';

  type RequestSummary = Omit<RequestRecord, 'proposedInputs' | 'capturedArtifacts'> & {
    proposedInputCount: number;
    capturedArtifactCount: number;
    detailUrl: string;
  };
  interface Pages<T> {
    items: T[];
    cursor: string | null;
    watermark: number | null;
    loading: boolean;
    error: string;
  }
  const emptyPages = <T,>(): Pages<T> => ({ items: [], cursor: null, watermark: null, loading: false, error: '' });
  const stalePages = 'Records changed during pagination. Refresh this list to start a new query; pages were not combined.';
  const explain = (cause: unknown) => cause instanceof Error ? cause.message : 'The local service could not load this record.';
  const isConflict = (cause: unknown) => cause instanceof ApiClientError && cause.status === 409;
  const date = (value: string) => new Date(value).toLocaleString();

  let { api, projectId, assetId, slotId, requestId, request, onNavigate, onChanged }: {
    api: ApiClient;
    projectId?: string;
    assetId?: string;
    slotId?: string;
    requestId?: string;
    request: RequestRecord | null;
    onNavigate: (patch: Partial<NavigationState>) => void;
    onChanged: () => void;
  } = $props();

  let draftKey = $state('');
  let draft = $state<RequestDraft>(freshDraft());
  let createError = $state('');
  let lookupError = $state('');
  let inputError = $state('');
  let creating = $state(false);
  let lookingUp = $state(false);
  let addingInput = $state(false);

  let requests = $state<Pages<RequestSummary>>(emptyPages());
  let slots = $state<Pages<SlotRecord>>(emptyPages());
  let outcomes = $state<Pages<OutcomeReport>>(emptyPages());
  let requestPageEpoch = 0;
  let slotPageEpoch = 0;
  let outcomePageEpoch = 0;
  let assetScope = '';
  let assetClient: ApiClient | null = null;
  let outcomeScope = '';
  let outcomeClient: ApiClient | null = null;

  type NavigationContext = {
    api: ApiClient;
    projectId?: string;
    assetId?: string;
    slotId?: string;
    requestId?: string;
    generation: number;
  };
  let navigationGeneration = 0;
  let navigationContext: NavigationContext | null = null;
  function captureNavigationContext(): NavigationContext {
    return { api, projectId, assetId, slotId, requestId, generation: navigationGeneration };
  }
  function isCurrentContext(context: NavigationContext): boolean {
    return navigationGeneration === context.generation && api === context.api &&
      projectId === context.projectId && assetId === context.assetId &&
      slotId === context.slotId && requestId === context.requestId;
  }
  $effect(() => {
    const next = captureNavigationContext();
    if (navigationContext && (navigationContext.api !== next.api ||
      navigationContext.projectId !== next.projectId || navigationContext.assetId !== next.assetId ||
      navigationContext.slotId !== next.slotId || navigationContext.requestId !== next.requestId)) {
      navigationGeneration++;
      lookingUp = false;
      creating = false;
    }
    navigationContext = { ...next, generation: navigationGeneration };
  });
  onDestroy(() => { navigationGeneration++; });

  let localRequest = $state<RequestRecord | null>(null);
  let requestLoading = $state(false);
  let requestError = $state('');
  let outcomeDraftKey = $state('');
  let outcomeDraft = $state<OutcomeDraft | null>(null);
  let outcomeError = $state('');
  let outcomeConflict = $state(false);
  let reporting = $state(false);

  let activeRequest = $derived.by(() => {
    const id = requestId ?? request?.id;
    const supplied = request?.id === id ? request : null;
    const local = localRequest?.id === id ? localRequest : null;
    if (local && (!supplied || local.outcomeRevision > supplied.outcomeRevision ||
      local.capturedArtifacts.length > supplied.capturedArtifacts.length)) return local;
    return supplied ?? local;
  });
  let visibleRequest = $derived(activeRequest && (!projectId || activeRequest.projectId === projectId) &&
    (!assetId || activeRequest.assetId === assetId) ? activeRequest : null);

  $effect(() => {
    const key = projectId && assetId ? `${projectId}:${assetId}` : '';
    if (key === draftKey) return;
    if (draftKey) requestDrafts.set(draftKey, $state.snapshot(draft));
    draftKey = key;
    draft = requestDrafts.get(key) ?? freshDraft(slotId);
    createError = ''; lookupError = ''; inputError = '';
  });
  $effect(() => {
    if (draftKey) requestDrafts.set(draftKey, $state.snapshot(draft));
  });
  $effect(() => {
    const id = visibleRequest?.id ?? '';
    if (id === outcomeDraftKey) return;
    if (outcomeDraftKey && outcomeDraft) outcomeDrafts.set(outcomeDraftKey, $state.snapshot(outcomeDraft));
    outcomeDraftKey = id;
    outcomeDraft = visibleRequest ? outcomeDrafts.get(id) ??
      { expectedRevision: visibleRequest.outcomeRevision, status: '', notes: '' } : null;
    outcomeError = ''; outcomeConflict = false;
  });
  $effect(() => {
    if (outcomeDraftKey && outcomeDraft) outcomeDrafts.set(outcomeDraftKey, $state.snapshot(outcomeDraft));
  });

  async function readPage<T>(client: ApiClient, path: string, previous: Pages<T>, more: boolean,
    assign: (page: Pages<T>) => void, isCurrent: () => boolean) {
    assign(more ? { ...previous, loading: true, error: '' } : { ...emptyPages<T>(), loading: true });
    try {
      const page: QueryPage<T> = await client.page<T>(path, more ? previous.cursor ?? undefined : undefined);
      if (!isCurrent()) return;
      if (more && previous.watermark !== page.watermark) {
        assign({ ...emptyPages<T>(), error: stalePages });
        return;
      }
      assign({ items: more ? [...previous.items, ...page.items] : page.items,
        cursor: page.nextCursor, watermark: page.watermark, loading: false, error: '' });
    } catch (cause) {
      if (!isCurrent()) return;
      assign(isConflict(cause) ? { ...emptyPages<T>(), error: stalePages } :
        { ...previous, loading: false, error: explain(cause) });
    }
  }
  function loadRequests(more = false) {
    if (!assetId || (more && (!requests.cursor || requests.loading || requests.error))) return;
    const id = assetId; const client = api; const epoch = ++requestPageEpoch;
    void readPage(client, `/api/assets/${id}/requests`, requests, more, page => requests = page,
      () => requestPageEpoch === epoch && assetId === id && api === client);
  }
  function loadSlots(more = false) {
    if (!assetId || (more && (!slots.cursor || slots.loading || slots.error))) return;
    const id = assetId; const client = api; const epoch = ++slotPageEpoch;
    void readPage(client, `/api/assets/${id}/slots`, slots, more, page => slots = page,
      () => slotPageEpoch === epoch && assetId === id && api === client);
  }
  function loadOutcomes(more = false) {
    if (!visibleRequest || (more && (!outcomes.cursor || outcomes.loading || outcomes.error))) return;
    const id = visibleRequest.id; const client = api; const epoch = ++outcomePageEpoch;
    void readPage(client, `/api/requests/${id}/outcomes`, outcomes, more, page => outcomes = page,
      () => outcomePageEpoch === epoch && visibleRequest?.id === id && api === client);
  }
  $effect(() => {
    const key = `${projectId ?? ''}:${assetId ?? ''}`;
    const client = api;
    if (key === assetScope && client === assetClient) return;
    assetScope = key; assetClient = client;
    requestPageEpoch++; slotPageEpoch++;
    requests = emptyPages(); slots = emptyPages();
    if (projectId && assetId) untrack(() => { loadRequests(); loadSlots(); });
  });
  $effect(() => {
    const id = visibleRequest?.id ?? '';
    const client = api;
    if (id === outcomeScope && client === outcomeClient) return;
    outcomeScope = id; outcomeClient = client; outcomePageEpoch++;
    outcomes = emptyPages();
    if (id) untrack(() => loadOutcomes());
  });
  $effect(() => {
    const id = requestId;
    const client = api;
    if (!id || request?.id === id || localRequest?.id === id) {
      requestLoading = false;
      return;
    }
    let cancelled = false;
    requestLoading = true; requestError = '';
    void client.get<RequestRecord>(`/api/requests/${id}`).then(found => {
      if (!cancelled && api === client && requestId === id) localRequest = found;
    }, cause => {
      if (!cancelled && api === client && requestId === id) requestError = explain(cause);
    }).finally(() => { if (!cancelled) requestLoading = false; });
    return () => { cancelled = true; };
  });

  function requestPatch(found: Pick<RequestRecord, 'id' | 'projectId' | 'assetId' | 'slotId'>): Partial<NavigationState> {
    return { projectId: found.projectId, assetId: found.assetId, slotId: found.slotId ?? undefined,
      requestId: found.id, artifactId: undefined, candidateId: undefined, clipId: undefined, revisionId: undefined,
      filters: found.slotId ? { slotIds: [found.slotId] } : { assetIds: [found.assetId] }, tab: 'requests' };
  }
  function openRequest(event: MouseEvent, found: Pick<RequestRecord, 'id' | 'projectId' | 'assetId' | 'slotId'>) {
    event.preventDefault();
    onNavigate(requestPatch(found));
  }
  async function refreshSelected() {
    if (!requestId || requestLoading) return;
    const id = requestId; const client = api;
    requestLoading = true; requestError = '';
    try {
      const found = await client.get<RequestRecord>(`/api/requests/${id}`);
      if (api === client && requestId === id) localRequest = found;
    } catch (cause) {
      if (api === client && requestId === id) requestError = explain(cause);
    } finally { requestLoading = false; }
  }
  async function lookup(event: SubmitEvent) {
    event.preventDefault();
    const id = draft.lookupId.trim();
    if (lookingUp) return;
    if (!catalogId.safeParse(id).success) { lookupError = 'Enter a valid request UUID.'; return; }
    const context = captureNavigationContext();
    lookingUp = true; lookupError = '';
    try {
      const found = await context.api.get<RequestRecord>(`/api/requests/${id}`);
      if (!isCurrentContext(context)) return;
      localRequest = found;
      onNavigate(requestPatch(found));
    } catch (cause) {
      if (isCurrentContext(context)) lookupError = explain(cause);
    } finally {
      if (isCurrentContext(context)) lookingUp = false;
    }
  }
  async function addProposedInput() {
    if (addingInput || draft.proposedInputs.length >= 128) return;
    const key = draftKey;
    const artifactId = draft.inputArtifactId.trim();
    const clipId = draft.inputClipId.trim();
    const role = draft.inputRole.trim();
    inputError = '';
    if (!catalogId.safeParse(artifactId).success || (clipId && !catalogId.safeParse(clipId).success) || role.length > 200) {
      inputError = 'Enter an artifact UUID, an optional clip UUID, and a role of at most 200 characters.';
      return;
    }
    addingInput = true;
    try {
      // Read the clip rather than guessing a revision from the current selection or the artwork file.
      const [artifact, clip] = await Promise.all([
        api.get<CaptureRecord>(`/api/artifacts/${artifactId}`),
        clipId ? api.get<ClipRecord>(`/api/clips/${clipId}`) : Promise.resolve(null),
      ]);
      if (draftKey !== key) return;
      if (artifact.id !== artifactId || (clip && (clip.id !== clipId || clip.artifactId !== artifact.id))) {
        inputError = 'The clip does not belong to that artifact. No proposed input was added.';
        return;
      }
      const parsed = exactInput.safeParse({ artifactId: artifact.id,
        ...(clip ? { clipId: clip.id, playbackRevisionId: clip.current.id } : {}),
        ...(role ? { role } : {}) });
      if (!parsed.success) { inputError = 'The service did not return a valid exact playback revision.'; return; }
      draft.proposedInputs = [...draft.proposedInputs, parsed.data];
      draft.inputArtifactId = ''; draft.inputClipId = ''; draft.inputRole = '';
    } catch (cause) {
      if (draftKey === key) inputError = `${explain(cause)} No proposed input was added; your entries remain here.`;
    } finally { addingInput = false; }
  }
  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (creating || addingInput || !projectId || !assetId) return;
    if (draft.inputArtifactId.trim() || draft.inputClipId.trim() || draft.inputRole.trim()) {
      createError = 'Add or clear the unfinished proposed input before recording the request.';
      return;
    }
    const parsed = createRequestInput.safeParse({ intent: draft.intent, notes: draft.notes,
      ...(draft.slotId ? { slotId: draft.slotId } : {}), proposedInputs: draft.proposedInputs });
    if (!parsed.success) { createError = 'Supply an intent and a valid destination slot and proposed inputs.'; return; }
    const key = draftKey;
    const submittedDraft = draft;
    const context = captureNavigationContext();
    creating = true; createError = '';
    try {
      const found = await context.api.mutate<RequestRecord>(`/api/projects/${context.projectId}/assets/${context.assetId}/requests`, 'POST', parsed.data);
      // A newly selected scope may have a different draft, even when it belongs to the same asset.
      if (isCurrentContext(context) && draftKey === key && draft === submittedDraft) {
        draft = freshDraft(context.slotId);
        requestDrafts.delete(key);
      } else if (draftKey !== key) {
        requestDrafts.delete(key);
      }
      if (isCurrentContext(context)) {
        localRequest = found;
        loadRequests();
        onNavigate(requestPatch(found));
        onChanged();
      }
    } catch (cause) {
      if (isCurrentContext(context)) createError = `${explain(cause)} The request was not confirmed. Your draft remains here; check request history before resubmitting an uncertain network result.`;
    } finally {
      if (isCurrentContext(context)) creating = false;
    }
  }
  async function report(event: SubmitEvent) {
    event.preventDefault();
    const selected = visibleRequest;
    const entry = outcomeDraft;
    if (!selected || !entry || reporting || outcomeConflict || entry.expectedRevision !== selected.outcomeRevision) return;
    const parsed = reportOutcomeInput.safeParse(entry);
    if (!parsed.success) { outcomeError = 'Choose a reported outcome and keep notes within 16,384 characters.'; return; }
    const id = selected.id;
    reporting = true; outcomeError = '';
    try {
      const updated = await api.mutate<RequestRecord>(`/api/requests/${id}/outcomes`, 'POST', parsed.data);
      const nextDraft: OutcomeDraft = { expectedRevision: updated.outcomeRevision, status: '', notes: '' };
      outcomeDrafts.set(id, nextDraft);
      if (outcomeDraftKey === id) {
        localRequest = updated;
        outcomeDraft = nextDraft;
        outcomeConflict = false;
        loadOutcomes();
      }
      if (assetId === updated.assetId) loadRequests();
      onChanged();
    } catch (cause) {
      if (outcomeDraftKey === id) {
        outcomeConflict = isConflict(cause);
        outcomeError = isConflict(cause)
          ? 'Another outcome was recorded. Your entries remain here. Refresh this request, review the report, and explicitly use its latest revision before retrying.'
          : `${explain(cause)} Your outcome draft remains here; check history before resubmitting an uncertain network result.`;
      }
    } finally { reporting = false; }
  }
  function viewCaptured(id: string) {
    if (!visibleRequest) return;
    onNavigate({ projectId: visibleRequest.projectId, assetId: visibleRequest.assetId,
      slotId: undefined, artifactId: id, candidateId: undefined, clipId: undefined, revisionId: undefined,
      requestId: visibleRequest.id, filters: { assetIds: [visibleRequest.assetId] }, tab: 'facts' });
  }
  function viewInput(input: ProposedInputRecord) {
    // Proposed sources may be from another asset; allow the parent to resolve the artifact's true owner.
    // A pinned clip opens its recorded playback revision, never the clip's mutable current description.
    onNavigate({ projectId: undefined, assetId: undefined, slotId: undefined, requestId: undefined,
      artifactId: input.artifactId, candidateId: undefined, clipId: input.clipId ?? undefined,
      revisionId: input.playbackRevisionId ?? undefined, filters: {},
      tab: input.playbackRevisionId ? 'history' : 'facts' });
  }
</script>

<section class="request-panel" aria-label="Artwork requests">
  <header>
    <p class="section-kicker">Production intent</p>
    <h2>Requests</h2>
    <p class="hint">Requests record planned work. Producing artwork happens outside AssetWeave; capture and outcome reports remain separate records.</p>
  </header>

  <form class="lookup" onsubmit={lookup}>
    <label>Find a request by UUID
      <input bind:value={draft.lookupId} placeholder="Recorded request ID" aria-label="Request UUID" />
    </label>
    <button type="submit" class="quiet-button" disabled={lookingUp || !draft.lookupId.trim()}>{lookingUp ? 'Finding…' : 'Find request'}</button>
    {#if lookupError}<p role="alert" class="notice">{lookupError}</p>{/if}
  </form>

  {#if !projectId || !assetId}
    <p class="hint">Select a project and logical asset to record intent or browse its requests. An existing request can still be found by ID.</p>
  {:else}
    <section class="history" aria-label="Request history">
      <div class="section-title"><h3>Asset request history</h3><button type="button" class="quiet-button" onclick={() => loadRequests()} disabled={requests.loading}>Refresh requests</button></div>
      <p class="hint">Includes requests with no captured output. A captured result does not set its outcome.</p>
      {#if requests.loading}<p role="status" class="hint">Loading request history…</p>{/if}
      {#if requests.error}<p role="alert" class="notice">{requests.error} <button type="button" class="quiet-button" onclick={() => loadRequests()}>Refresh request history</button></p>{/if}
      {#if !requests.loading && !requests.error && !requests.items.length}<p class="hint">No requests recorded for this asset.</p>{/if}
      {#if requests.items.length}
        <ol class="record-list">
          {#each requests.items as item (item.id)}
            <li>
              <a class="request-link" aria-current={requestId === item.id ? 'page' : undefined}
                href={navigationHref({ projectId: item.projectId, assetId: item.assetId, slotId: item.slotId ?? undefined, requestId: item.id, tab: 'requests' })}
                onclick={(event) => openRequest(event, item)}>{item.intent}</a>
              <small>Recorded by {item.recordedBy} · <time datetime={item.recordedAt}>{date(item.recordedAt)}</time></small>
              <small>Outcome: {item.outcome.status === 'unknown' ? 'unknown (no report)' : `reported ${item.outcome.status}`} · Captured artifacts: {item.capturedArtifactCount} · Proposed inputs: {item.proposedInputCount}</small>
            </li>
          {/each}
        </ol>
      {/if}
      {#if requests.cursor}<button type="button" class="quiet-button" onclick={() => loadRequests(true)} disabled={requests.loading}>Load more requests</button>{/if}
    </section>

    <details class="create" open={!requestId}>
      <summary>Record a new request</summary>
      <form onsubmit={create}>
        <fieldset disabled={creating}>
          <label>What artwork is requested?
            <textarea bind:value={draft.intent} maxlength="16384" rows="3" required placeholder="Record the actual intended work"></textarea>
          </label>
          <label>Notes (optional)
            <textarea bind:value={draft.notes} maxlength="16384" rows="2" placeholder="Additional direction or constraints"></textarea>
          </label>
          <label>Intended destination slot (optional)
            <select bind:value={draft.slotId}>
              <option value="">No slot specified</option>
              {#if draft.slotId && !slots.items.some(item => item.id === draft.slotId)}
                <option value={draft.slotId}>Slot {draft.slotId} (not on this page)</option>
              {/if}
              {#each slots.items as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
            </select>
          </label>
          {#if slots.error}<p role="alert" class="notice">{slots.error} <button type="button" class="quiet-button" onclick={() => loadSlots()}>Refresh slots</button></p>{/if}
          {#if slots.loading}<p role="status" class="hint">Loading destination slots…</p>{/if}
          {#if slots.cursor}<button type="button" class="quiet-button" onclick={() => loadSlots(true)} disabled={slots.loading}>Load more slots</button>{/if}
          <div class="inputs">
            <h3>Proposed exact inputs (optional)</h3>
            <p class="hint">These are intentions, not actual derivation. A clip is pinned to the playback revision read when you add it; later corrections do not change this proposal.</p>
            {#if draft.proposedInputs.length}
              <ol class="record-list">
                {#each draft.proposedInputs as input, index (index)}
                  <li>Artifact <code>{input.artifactId}</code>{input.clipId ? ` · clip ${input.clipId} · pinned playback revision ${input.playbackRevisionId}` : ' · whole artifact'} · role: {input.role ?? 'unspecified'}
                    <button type="button" class="quiet-button" disabled={addingInput} onclick={() => draft.proposedInputs = draft.proposedInputs.filter((_, row) => row !== index)}>Remove input</button>
                  </li>
                {/each}
              </ol>
            {/if}
            <label>Artifact UUID <input bind:value={draft.inputArtifactId} disabled={addingInput} placeholder="Existing captured artifact" /></label>
            <label>Clip UUID (optional) <input bind:value={draft.inputClipId} disabled={addingInput} placeholder="Named clip on that artifact" /></label>
            <label>Role (optional) <input bind:value={draft.inputRole} disabled={addingInput} maxlength="200" placeholder="e.g. starting artwork, visual reference" /></label>
            <button type="button" class="quiet-button" onclick={addProposedInput} disabled={addingInput || draft.proposedInputs.length >= 128}>{addingInput ? 'Verifying input…' : 'Add proposed input'}</button>
            {#if inputError}<p role="alert" class="notice">{inputError}</p>{/if}
          </div>
          {#if createError}<p role="alert" class="notice">{createError}</p>{/if}
          <button type="submit" class="primary-button" disabled={addingInput || !draft.intent.trim()}>{creating ? 'Recording…' : 'Record request intent'}</button>
        </fieldset>
      </form>
    </details>
  {/if}

  {#if requestId && !visibleRequest}
    {#if requestLoading}<p role="status" class="hint">Loading the selected request…</p>{/if}
    {#if requestError}<p role="alert" class="notice">{requestError} <button type="button" class="quiet-button" onclick={refreshSelected}>Refresh selected request</button></p>{/if}
    {#if activeRequest && !visibleRequest}
      <p role="alert" class="notice">This request belongs to another project or asset.
        <a href={navigationHref({ projectId: activeRequest.projectId, assetId: activeRequest.assetId, requestId: activeRequest.id, tab: 'requests' })}
          onclick={(event) => openRequest(event, activeRequest)}>Open its recorded asset context</a>.
      </p>
    {/if}
  {/if}
  {#if visibleRequest}
    <section class="selected" aria-label="Selected request">
      <div class="section-title"><h3>Viewed request</h3><button type="button" class="quiet-button" onclick={refreshSelected} disabled={requestLoading}>{requestLoading ? 'Refreshing…' : 'Refresh request'}</button></div>
      {#if requestError}<p role="alert" class="notice">{requestError}</p>{/if}
      <p class="intent">{visibleRequest.intent}</p>
      <dl class="fact-list">
        <dt>Request ID</dt><dd><code>{visibleRequest.id}</code></dd>
        <dt>Context</dt><dd>Project <code>{visibleRequest.projectId}</code> · asset <code>{visibleRequest.assetId}</code></dd>
        <dt>Destination</dt><dd>{visibleRequest.slotId ? `Slot ${visibleRequest.slotId}` : 'No destination slot recorded'}</dd>
        <dt>Recorded</dt><dd>{visibleRequest.recordedBy} · <time datetime={visibleRequest.recordedAt}>{date(visibleRequest.recordedAt)}</time></dd>
        <dt>Notes</dt><dd class="notes">{visibleRequest.notes || 'No request notes recorded'}</dd>
        <dt>Outcome</dt><dd><strong>{visibleRequest.outcome.status === 'unknown' ? 'Unknown — no report' : `Reported ${visibleRequest.outcome.status}`}</strong>{#if visibleRequest.outcome.status !== 'unknown'} · revision {visibleRequest.outcome.revision} by {visibleRequest.outcome.actor} · <time datetime={visibleRequest.outcome.at}>{date(visibleRequest.outcome.at)}</time>{/if}</dd>
      </dl>
      {#if visibleRequest.outcome.status !== 'unknown' && visibleRequest.outcome.notes}<p class="notes">Outcome notes: {visibleRequest.outcome.notes}</p>{/if}
      <h3>Proposed inputs</h3>
      {#if visibleRequest.proposedInputs.length}
        <ol class="record-list">
          {#each visibleRequest.proposedInputs as input (input.id)}
            <li>#{input.ordinal + 1} · <button type="button" class="text-link" onclick={() => viewInput(input)}>Artifact {input.artifactId}</button>
              {#if input.clipId} · clip <code>{input.clipId}</code> · pinned revision <code>{input.playbackRevisionId}</code>{/if}
              · role: {input.role ?? 'unspecified'}</li>
          {/each}
        </ol>
      {:else}<p class="hint">No exact inputs proposed. This does not assert that production used no inputs.</p>{/if}
      <h3>Captured artifacts linked to this request</h3>
      {#if visibleRequest.capturedArtifacts.length}
        <ol class="record-list">
          {#each visibleRequest.capturedArtifacts as artifact (artifact.id)}
            <li><button type="button" class="text-link" onclick={() => viewCaptured(artifact.id)}>Open artifact {artifact.id}</button>
              · captured <time datetime={artifact.capturedAt}>{date(artifact.capturedAt)}</time></li>
          {/each}
        </ol>
      {:else}<p class="hint">No captured artifacts linked to this request yet. Its intent and reported outcome remain available.</p>{/if}
      <p class="hint">Capture does not change a reported outcome, and a proposed input is not an actual input. Inspect each captured artifact for its recorded derivation.</p>

      <section class="outcomes" aria-label="Outcome report history">
        <div class="section-title"><h3>Outcome reports</h3><button type="button" class="quiet-button" onclick={() => loadOutcomes()} disabled={outcomes.loading}>Refresh reports</button></div>
        {#if outcomes.loading}<p role="status" class="hint">Loading outcome history…</p>{/if}
        {#if outcomes.error}<p role="alert" class="notice">{outcomes.error} <button type="button" class="quiet-button" onclick={() => loadOutcomes()}>Refresh report history</button></p>{/if}
        {#if !outcomes.loading && !outcomes.error && !outcomes.items.length}<p class="hint">No outcome reports recorded. Outcome unknown unless a later report appears.</p>{/if}
        {#if outcomes.items.length}<ol class="record-list">{#each outcomes.items as item (item.id)}
          <li><strong>Reported {item.status}</strong> · revision {item.revision} · by {item.actor} · <time datetime={item.at}>{date(item.at)}</time>
            {#if item.notes}<p class="notes">{item.notes}</p>{/if}</li>
        {/each}</ol>{/if}
        {#if outcomes.cursor}<button type="button" class="quiet-button" onclick={() => loadOutcomes(true)} disabled={outcomes.loading}>Load more reports</button>{/if}
      </section>

      {#if outcomeDraft}
        <form class="outcome-form" onsubmit={report}>
          <fieldset disabled={reporting}>
            <legend>Report an outcome</legend>
            <p class="hint">Report only what is known about this request. Capturing an artifact never chooses an outcome for you.</p>
            <label>Status
              <select bind:value={outcomeDraft.status} required>
                <option value="">Choose a reported status</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label>Report notes (optional) <textarea bind:value={outcomeDraft.notes} maxlength="16384" rows="2"></textarea></label>
            {#if outcomeDraft.expectedRevision !== visibleRequest.outcomeRevision || outcomeConflict}
              <p class="notice" role="status">Your draft uses outcome revision {outcomeDraft.expectedRevision}; the latest displayed request has revision {visibleRequest.outcomeRevision}. Review its status and reports before adopting the latest revision. Your entries have not been replaced.</p>
              <button type="button" class="quiet-button" disabled={outcomeDraft.expectedRevision === visibleRequest.outcomeRevision} onclick={() => {
                if (outcomeDraft) outcomeDraft.expectedRevision = visibleRequest.outcomeRevision;
                outcomeConflict = false; outcomeError = '';
              }}>Use latest revision with my draft</button>
            {/if}
            {#if outcomeError}<p role="alert" class="notice">{outcomeError}</p>{/if}
            <button type="submit" class="primary-button" disabled={!outcomeDraft.status || outcomeConflict || outcomeDraft.expectedRevision !== visibleRequest.outcomeRevision}>Report outcome</button>
          </fieldset>
        </form>
      {/if}
    </section>
  {/if}
</section>

<style>
  .request-panel { display: grid; gap: 18px; min-width: 0; color: var(--text); font-size: 13px; }
  header { display: grid; gap: 6px; }
  .request-panel :is(h2, h3, p) { margin: 0; }
  .request-panel h3 { font-size: 13px; }
  .hint, small { color: var(--muted); font-size: 12px; line-height: 1.5; }
  .lookup, .request-panel form fieldset, .inputs { display: grid; gap: 9px; min-width: 0; }
  label { display: grid; gap: 4px; min-width: 0; }
  label :is(input, select, textarea) { width: 100%; }
  .lookup .quiet-button, .request-panel form .quiet-button, .request-panel form .primary-button { justify-self: start; }
  .request-panel :is(.history, .create, .selected, .outcomes) { border-top: 1px solid var(--line); padding-top: 14px; min-width: 0; }
  .request-panel .outcomes { margin-top: 15px; }
  .request-panel .create summary { cursor: pointer; font-weight: 650; }
  .request-panel .create form { margin-top: 10px; }
  .request-panel fieldset { border: 0; padding: 0; min-width: 0; }
  .request-panel .outcome-form fieldset { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 14px; }
  .section-title { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 7px; }
  .record-list { display: grid; gap: 9px; padding-left: 18px; margin: 7px 0; min-width: 0; }
  .record-list li { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; }
  .record-list small { display: block; }
  .request-link { display: block; overflow-wrap: anywhere; }
  .request-link[aria-current='page'] { font-weight: 700; }
  .fact-list { margin: 8px 0 12px; }
  .fact-list dd, .intent, .notes { overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.55; }
  .intent { font-weight: 650; }
  .selected { display: grid; gap: 9px; }
  .inputs { border-top: 1px solid var(--line); padding-top: 12px; }
  .text-link { padding: 0; border: 0; background: none; color: var(--accent-ink); text-decoration: underline; text-align: left; overflow-wrap: anywhere; }
  .request-panel .notice { overflow-wrap: anywhere; }
  .request-panel :is(code, a, small, button) { overflow-wrap: anywhere; }
</style>
