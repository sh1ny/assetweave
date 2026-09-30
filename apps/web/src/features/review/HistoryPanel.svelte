<script lang="ts">
  import type { AssetRecord, CandidateRecord } from '@assetweave/contracts/catalog';
  import type { CaptureRecord } from '@assetweave/contracts/capture';
  import type { CandidateReviewDecision, SlotSelectionDecision, AssetStageDecision, SelectionTarget } from '@assetweave/contracts/decisions';
  import type { ClipRecord, PlaybackRevision } from '@assetweave/contracts/playback';
  import type { ClaimRecord, ClaimRevision, InputEdgeRecord, InputEdgeRevision, LineageGapRecord, LineageGapRevision } from '@assetweave/contracts/production';
  import type { RevisionDetail } from '@assetweave/contracts/queries';
  import { ApiClientError, type ApiClient } from '../../lib/api/client.js';
  import type { NavigationState } from '../../lib/navigation.js';

  interface Props {
    api: ApiClient;
    record: CaptureRecord | null;
    candidate: CandidateRecord | null;
    claims: ClaimRecord[];
    clips: ClipRecord[];
    moreClaims: boolean;
    moreClips: boolean;
    claimError?: string;
    clipError?: string;
    onMore: (part: 'claims' | 'clips') => void;
    selectedSlotId?: string;
    currentAsset: AssetRecord | null;
    revisionId?: string;
    revision: RevisionDetail | null;
    revisionLoading: boolean;
    revisionError: string;
    onNavigate: (patch: Partial<NavigationState>) => void;
    refreshToken?: number;
  }
  let { api, record, candidate, claims, clips, moreClaims, moreClips, claimError, clipError, onMore,
    selectedSlotId, currentAsset, revisionId, revision, revisionLoading,
    revisionError, onNavigate, refreshToken = 0 }: Props = $props();
  interface HistoryPage { items: unknown[]; cursor: string | null; watermark: number | null; loading: boolean; error: string; open: boolean }
  const empty = (open = false): HistoryPage => ({ items: [], cursor: null, watermark: null, loading: false, error: '', open });
  let pages = $state<Record<string, HistoryPage>>({});
  let showClaims = $state(false);
  let showClips = $state(false);
  let contextKey = '';
  let generation = 0;
  $effect(() => {
    if (!record) return; // The parent briefly clears detail while refreshing; do not discard loaded history.
    const identity = [record.id, candidate?.id, selectedSlotId, currentAsset?.id, refreshToken].join(':');
    if (identity !== contextKey) {
      contextKey = identity;
      generation++;
      pages = {};
    }
  });
  function text(error: unknown): string {
    return error instanceof Error ? error.message : 'History could not be loaded.';
  }
  function show(value: unknown): string {
    const rendered = JSON.stringify(value, null, 2);
    return rendered === undefined ? 'Not recorded' : rendered;
  }
  function when(value: string): string { return new Date(value).toLocaleString(); }
  async function load(key: string, path: string, more = false) {
    const previous = pages[key] ?? empty(true);
    if (previous.loading || (more && !previous.cursor)) return;
    const started = generation;
    pages[key] = { ...previous, loading: true, error: '', open: true };
    try {
      const page = await api.page<unknown>(path, more ? previous.cursor ?? undefined : undefined);
      if (started !== generation) return;
      if (more && previous.watermark !== page.watermark) {
        pages[key] = { ...previous, loading: false, cursor: null,
          error: 'Records changed during pagination. Refresh this history before continuing.' };
        return;
      }
      pages[key] = { items: more ? [...previous.items, ...page.items] : page.items, cursor: page.nextCursor,
        watermark: page.watermark, loading: false, error: '', open: true };
    } catch (cause) {
      if (started === generation) pages[key] = { ...previous, loading: false,
        cursor: cause instanceof ApiClientError && cause.status === 409 ? null : previous.cursor,
        error: text(cause), open: true };
    }
  }
  function toggle(key: string, path: string) {
    const previous = pages[key];
    if (previous?.open) { pages[key] = { ...previous, open: false }; return; }
    if (previous?.items.length && !previous.error) { pages[key] = { ...previous, open: true }; return; }
    void load(key, path);
  }
  function target(label: string, value: SelectionTarget | null): string {
    return value ? `${label}: candidate ${value.candidateId} · artwork ${value.artifactId}${value.clipId ? ` · clip ${value.clipId}` : ''}` : `${label}: no selection`;
  }
  function jumpRevision(id: string, artifactId = record?.id, pinnedClipId?: string | null) {
    onNavigate({ revisionId: id, tab: 'history',
      ...(artifactId && artifactId !== record?.id ? { artifactId, candidateId: undefined,
        clipId: undefined, slotId: undefined, assetId: undefined, projectId: undefined,
        requestId: undefined, filters: undefined } : {}),
      ...(pinnedClipId !== undefined && pinnedClipId !== candidate?.clipId
        ? { candidateId: undefined } : {}),
      ...(pinnedClipId !== undefined ? { clipId: pinnedClipId ?? undefined } : {}) });
  }
  function refresh(key: string, path: string) { void load(key, path); }
</script>

<section class="history-panel" aria-label="Recorded history">
  <h3>Recorded history</h3>
  <p class="muted">Current facts and decisions appear in the other tabs. Older records are retained, not substituted for the current artwork.</p>
  <button type="button" class="quiet-button" onclick={() => { generation++; pages = {}; }}>Refresh loaded histories</button>
  {#if revisionId}
    <section class="recorded-match" aria-label="Exact recorded match">
      <h4>Exact recorded match</h4>
      {#if revisionLoading}<p role="status">Loading the pinned revision…</p>{/if}
      {#if revisionError}<p role="alert">{revisionError}</p>{/if}
      {#if revision && revision.revisionId === revisionId}
        <p>{revision.type} · revision {revision.revision} · {revision.current ? 'currently effective' : 'historical'} · recorded by {revision.actor} on {when(revision.at)}</p>
        <pre>{show(revision.record)}</pre>
      {:else if !revisionLoading && !revisionError}<p>The pinned revision has not been loaded. Current artwork is shown separately.</p>{/if}
    </section>
  {/if}

  {#if record}
    <p class="section-heading">Artwork {record.name} · captured {when(record.capturedAt)}</p>
    <section class="history-group">
      <button type="button" class="quiet-button" aria-expanded={showClaims} onclick={() => showClaims = !showClaims}>Provenance assertions</button>
      {#if showClaims}
        {#each claims.filter(item => item.artifactId === record.id) as claim (claim.assertionId)}
          <div class="history-item">
            <p><strong>{claim.claim.field}</strong> · current: {claim.claim.state} · revision {claim.revision}</p>
            <p>{claim.claim.state === 'known' ? show(claim.claim.value) : claim.claim.state} · source {claim.claim.source.kind}{claim.claim.source.detail ? ` · ${claim.claim.source.detail}` : ''}</p>
            <p class="muted">Recorded by {claim.actor} on {when(claim.at)}</p>
            <button type="button" class="quiet-button" aria-expanded={!!pages[`claim:${claim.assertionId}`]?.open}
              onclick={() => toggle(`claim:${claim.assertionId}`, `/api/assertions/${claim.assertionId}/history`)}>Revisions of this assertion</button>
            {#if pages[`claim:${claim.assertionId}`]?.open}
              {#each (pages[`claim:${claim.assertionId}`]?.items ?? []) as revisionRaw ((revisionRaw as ClaimRevision).id)}
                {@const item = revisionRaw as ClaimRevision}
                <div class="revision"><p>Revision {item.revision} · {item.claim.state} · {item.claim.state === 'known' ? show(item.claim.value) : 'No known value'}
                  · source {item.claim.source.kind}{item.claim.source.detail ? ` · ${item.claim.source.detail}` : ''}</p>
                  <p class="muted">{item.actor} · {when(item.at)}</p>
                  <button type="button" class="text-button" onclick={() => jumpRevision(item.id)}>Open pinned revision</button></div>
              {/each}
              {#if pages[`claim:${claim.assertionId}`]?.cursor}<button type="button" class="quiet-button" onclick={() => load(`claim:${claim.assertionId}`, `/api/assertions/${claim.assertionId}/history`, true)}>More assertion revisions</button>{/if}
              {#if pages[`claim:${claim.assertionId}`]?.error}<p role="alert">{pages[`claim:${claim.assertionId}`]?.error}</p>
                <button type="button" class="quiet-button" onclick={() => refresh(`claim:${claim.assertionId}`, `/api/assertions/${claim.assertionId}/history`)}>Refresh assertion revisions</button>{/if}
              {#if pages[`claim:${claim.assertionId}`]?.loading}<p role="status">Loading assertion revisions…</p>{/if}
            {/if}
          </div>
        {/each}
        {#if !claims.some(item => item.artifactId === record.id) && !claimError}<p class="muted">No provenance assertions in the loaded list. Unrecorded facts are not recorded absences.</p>{/if}
        {#if moreClaims}<button type="button" class="quiet-button" onclick={() => onMore('claims')}>More assertions</button>{/if}
        {#if claimError}<p role="alert">Assertion list unavailable: {claimError}</p>{/if}
      {/if}
    </section>

    {#each ['inputs', 'gaps'] as kind (kind)}
      {@const path = `/api/artifacts/${record.id}/${kind}/history`}
      <section class="history-group">
        <button type="button" class="quiet-button" aria-expanded={!!pages[kind]?.open} onclick={() => toggle(kind, path)}>{kind === 'inputs' ? 'Actual input edges (including retracted)' : 'Lineage gaps (including retracted)'}</button>
        {#if pages[kind]?.open}
          {#if kind === 'inputs'}
            {#each (pages.inputs?.items ?? []) as raw ((raw as InputEdgeRecord).edgeId)}
              {@const edge = raw as InputEdgeRecord}
              <div class="history-item">
                <p><strong>{edge.effective ? 'Effective input' : 'Retracted input'}</strong> · artwork {edge.input.artifactId} · role {edge.input.role ?? 'not recorded'}</p>
                <p class="muted">Revision {edge.revision} by {edge.actor} on {when(edge.at)}</p>
                {#if edge.input.playbackRevisionId}<button type="button" class="text-button" onclick={() => jumpRevision(edge.input.playbackRevisionId!, edge.input.artifactId, edge.input.clipId)}>Open pinned clip description</button>{/if}
                <button type="button" class="quiet-button" aria-expanded={!!pages[`edge:${edge.edgeId}`]?.open}
                  onclick={() => toggle(`edge:${edge.edgeId}`, `/api/inputs/${edge.edgeId}/history`)}>Prior edge revisions</button>
                {#if pages[`edge:${edge.edgeId}`]?.open}
                  {#each (pages[`edge:${edge.edgeId}`]?.items ?? []) as oldRaw ((oldRaw as InputEdgeRevision).id)}
                    {@const old = oldRaw as InputEdgeRevision}
                    <div class="revision"><p>Revision {old.revision} · {old.effective ? 'effective' : 'retracted'} · artwork {old.input.artifactId} · role {old.input.role ?? 'not recorded'}</p>
                      <p class="muted">{old.actor} · {when(old.at)}</p>
                      {#if old.input.playbackRevisionId}<button type="button" class="text-button" onclick={() => jumpRevision(old.input.playbackRevisionId!, old.input.artifactId, old.input.clipId)}>Pinned clip description</button>{/if}
                      <button type="button" class="text-button" onclick={() => jumpRevision(old.id)}>Open pinned edge revision</button></div>
                  {/each}
                  {#if pages[`edge:${edge.edgeId}`]?.cursor}<button type="button" class="quiet-button" onclick={() => load(`edge:${edge.edgeId}`, `/api/inputs/${edge.edgeId}/history`, true)}>More edge revisions</button>{/if}
                  {#if pages[`edge:${edge.edgeId}`]?.error}<p role="alert">{pages[`edge:${edge.edgeId}`]?.error}</p>
                    <button type="button" class="quiet-button" onclick={() => refresh(`edge:${edge.edgeId}`, `/api/inputs/${edge.edgeId}/history`)}>Refresh edge revisions</button>{/if}
                  {#if pages[`edge:${edge.edgeId}`]?.loading}<p role="status">Loading edge revisions…</p>{/if}
                {/if}
              </div>
            {/each}
          {:else}
            {#each (pages.gaps?.items ?? []) as raw ((raw as LineageGapRecord).gapId)}
              {@const gap = raw as LineageGapRecord}
              <div class="history-item">
                <p><strong>{gap.effective ? 'Effective gap' : 'Retracted gap'}</strong> · {gap.gap.kind} · {gap.gap.description}</p>
                <p>Source {gap.gap.sourceKind} · input artwork {gap.gap.inputArtifactId ?? 'not identified'}</p>
                <p class="muted">Revision {gap.revision} by {gap.actor} on {when(gap.at)}</p>
                <button type="button" class="quiet-button" aria-expanded={!!pages[`gap:${gap.gapId}`]?.open}
                  onclick={() => toggle(`gap:${gap.gapId}`, `/api/gaps/${gap.gapId}/history`)}>Prior gap revisions</button>
                {#if pages[`gap:${gap.gapId}`]?.open}
                  {#each (pages[`gap:${gap.gapId}`]?.items ?? []) as oldRaw ((oldRaw as LineageGapRevision).id)}
                    {@const old = oldRaw as LineageGapRevision}
                    <div class="revision"><p>Revision {old.revision} · {old.effective ? 'effective' : 'retracted'} · {old.gap.kind} · {old.gap.description}</p>
                      <p class="muted">Source {old.gap.sourceKind} · {old.actor} · {when(old.at)}</p>
                      <button type="button" class="text-button" onclick={() => jumpRevision(old.id)}>Open pinned gap revision</button></div>
                  {/each}
                  {#if pages[`gap:${gap.gapId}`]?.cursor}<button type="button" class="quiet-button" onclick={() => load(`gap:${gap.gapId}`, `/api/gaps/${gap.gapId}/history`, true)}>More gap revisions</button>{/if}
                  {#if pages[`gap:${gap.gapId}`]?.error}<p role="alert">{pages[`gap:${gap.gapId}`]?.error}</p>
                    <button type="button" class="quiet-button" onclick={() => refresh(`gap:${gap.gapId}`, `/api/gaps/${gap.gapId}/history`)}>Refresh gap revisions</button>{/if}
                  {#if pages[`gap:${gap.gapId}`]?.loading}<p role="status">Loading gap revisions…</p>{/if}
                {/if}
              </div>
            {/each}
          {/if}
          {#if pages[kind] && !pages[kind].items.length && !pages[kind].loading && !pages[kind].error}<p class="muted">No {kind === 'inputs' ? 'actual input edges' : 'lineage gaps'} recorded.</p>{/if}
          {#if pages[kind]?.cursor}<button type="button" class="quiet-button" onclick={() => load(kind, path, true)}>More {kind}</button>{/if}
          {#if pages[kind]?.error}<p role="alert">{pages[kind].error}</p><button type="button" class="quiet-button" onclick={() => refresh(kind, path)}>Refresh {kind}</button>{/if}
          {#if pages[kind]?.loading}<p role="status">Loading {kind}…</p>{/if}
        {/if}
      </section>
    {/each}

    <section class="history-group">
      <button type="button" class="quiet-button" aria-expanded={showClips} onclick={() => showClips = !showClips}>Named clip descriptions</button>
      {#if showClips}
        {#each clips.filter(item => item.artifactId === record.id) as clip (clip.id)}
          <div class="history-item"><p><strong>{clip.name}</strong> · current revision {clip.revision}</p>
            <button type="button" class="quiet-button" aria-expanded={!!pages[`clip:${clip.id}`]?.open}
              onclick={() => toggle(`clip:${clip.id}`, `/api/clips/${clip.id}/history`)}>Playback revisions</button>
            {#if pages[`clip:${clip.id}`]?.open}
              {#each (pages[`clip:${clip.id}`]?.items ?? []) as oldRaw ((oldRaw as PlaybackRevision).id)}
                {@const item = oldRaw as PlaybackRevision}
                <div class="revision"><p>Revision {item.revision} · frames {item.description.frames.join(', ')} · durations {item.description.durationsMs.join(', ')} ms · {item.cycleMs} ms cycle</p>
                  <p class="muted">Source {item.description.source.kind} · {item.actor} · {when(item.at)}</p>
                  <button type="button" class="text-button" onclick={() => jumpRevision(item.id, item.artifactId, item.clipId)}>Open pinned clip revision</button></div>
              {/each}
              {#if pages[`clip:${clip.id}`]?.cursor}<button type="button" class="quiet-button" onclick={() => load(`clip:${clip.id}`, `/api/clips/${clip.id}/history`, true)}>More playback revisions</button>{/if}
              {#if pages[`clip:${clip.id}`]?.error}<p role="alert">{pages[`clip:${clip.id}`]?.error}</p>
                <button type="button" class="quiet-button" onclick={() => refresh(`clip:${clip.id}`, `/api/clips/${clip.id}/history`)}>Refresh playback revisions</button>{/if}
              {#if pages[`clip:${clip.id}`]?.loading}<p role="status">Loading playback revisions…</p>{/if}
            {/if}</div>
        {/each}
        {#if !clips.some(item => item.artifactId === record.id) && !clipError}<p class="muted">No named clips in the loaded list.</p>{/if}
        {#if moreClips}<button type="button" class="quiet-button" onclick={() => onMore('clips')}>More named clips</button>{/if}
        {#if clipError}<p role="alert">Clip list unavailable: {clipError}</p>{/if}
      {/if}
    </section>
  {/if}

  {#if candidate && record && candidate.artifactId === record.id}
    <section class="history-group">
      <button type="button" class="quiet-button" aria-expanded={!!pages.reviews?.open} onclick={() => toggle('reviews', `/api/candidates/${candidate!.id}/reviews`)}>Viewed candidate review decisions</button>
      {#if pages.reviews?.open}
        {#each (pages.reviews?.items ?? []) as raw ((raw as CandidateReviewDecision).id)}
          {@const item = raw as CandidateReviewDecision}
          <div class="history-item"><p>{item.previousState} → {item.nextState} · revision {item.revision}</p>
            {#if item.selectionDisposition}<p>Selected candidate disposition: {item.selectionDisposition}</p>{/if}
            <p class="muted">{item.authority.channel} instruction: {item.authority.instruction} · recorded by {item.actor} on {when(item.at)}{item.rationale ? ` · ${item.rationale}` : ''}</p>
            {#if item.playbackRevisionId}<button type="button" class="text-button" onclick={() => jumpRevision(item.playbackRevisionId!, item.artifactId, item.clipId)}>Open observed clip revision</button>{/if}
            <button type="button" class="text-button" onclick={() => jumpRevision(item.id)}>Open pinned decision</button></div>
        {/each}
        {#if pages.reviews && !pages.reviews.items.length && !pages.reviews.loading && !pages.reviews.error}<p class="muted">No review decision recorded. Viewing does not record review.</p>{/if}
        {#if pages.reviews?.cursor}<button type="button" class="quiet-button" onclick={() => load('reviews', `/api/candidates/${candidate!.id}/reviews`, true)}>More reviews</button>{/if}
        {#if pages.reviews?.error}<p role="alert">{pages.reviews.error}</p><button type="button" class="quiet-button" onclick={() => refresh('reviews', `/api/candidates/${candidate!.id}/reviews`)}>Refresh reviews</button>{/if}
        {#if pages.reviews?.loading}<p role="status">Loading reviews…</p>{/if}
      {/if}
    </section>
  {/if}
  {#if selectedSlotId}
    <section class="history-group">
      <button type="button" class="quiet-button" aria-expanded={!!pages.selections?.open} onclick={() => toggle('selections', `/api/slots/${selectedSlotId}/selection-history`)}>Slot selection decisions</button>
      {#if pages.selections?.open}
        {#each (pages.selections?.items ?? []) as raw ((raw as SlotSelectionDecision).id)}
          {@const item = raw as SlotSelectionDecision}
          <div class="history-item"><p>{target('Previous', item.previous)} → {target('Next', item.next)}</p>
            <p class="muted">Revision {item.revision} · {item.authority.channel} instruction: {item.authority.instruction} · recorded by {item.actor} on {when(item.at)}{item.rationale ? ` · ${item.rationale}` : ''}</p>
            {#if item.previous?.playbackRevisionId}<button type="button" class="text-button" onclick={() => jumpRevision(item.previous!.playbackRevisionId!, item.previous!.artifactId, item.previous!.clipId)}>Previous pinned clip</button>{/if}
            {#if item.next?.playbackRevisionId}<button type="button" class="text-button" onclick={() => jumpRevision(item.next!.playbackRevisionId!, item.next!.artifactId, item.next!.clipId)}>Next pinned clip</button>{/if}
            <button type="button" class="text-button" onclick={() => jumpRevision(item.id)}>Open pinned selection decision</button></div>
        {/each}
        {#if pages.selections && !pages.selections.items.length && !pages.selections.loading && !pages.selections.error}<p class="muted">No selection decision recorded. This slot may have no selection.</p>{/if}
        {#if pages.selections?.cursor}<button type="button" class="quiet-button" onclick={() => load('selections', `/api/slots/${selectedSlotId}/selection-history`, true)}>More selections</button>{/if}
        {#if pages.selections?.error}<p role="alert">{pages.selections.error}</p><button type="button" class="quiet-button" onclick={() => refresh('selections', `/api/slots/${selectedSlotId}/selection-history`)}>Refresh selections</button>{/if}
        {#if pages.selections?.loading}<p role="status">Loading selections…</p>{/if}
      {/if}
    </section>
  {/if}
  {#if currentAsset}
    <section class="history-group">
      <button type="button" class="quiet-button" aria-expanded={!!pages.stages?.open} onclick={() => toggle('stages', `/api/assets/${currentAsset!.id}/stage-history`)}>Current asset stage decisions</button>
      {#if pages.stages?.open}
        {#each (pages.stages?.items ?? []) as raw ((raw as AssetStageDecision).id)}
          {@const item = raw as AssetStageDecision}
          <div class="history-item"><p>{item.previousStage ?? 'No stage'} → {item.nextStage ?? 'No stage'}</p>
            <p class="muted">Revision {item.revision} · {item.authority.channel} instruction: {item.authority.instruction} · recorded by {item.actor} on {when(item.at)}{item.rationale ? ` · ${item.rationale}` : ''}</p>
            <button type="button" class="text-button" onclick={() => jumpRevision(item.id)}>Open pinned stage decision</button></div>
        {/each}
        {#if pages.stages && !pages.stages.items.length && !pages.stages.loading && !pages.stages.error}<p class="muted">No human stage decision recorded.</p>{/if}
        {#if pages.stages?.cursor}<button type="button" class="quiet-button" onclick={() => load('stages', `/api/assets/${currentAsset!.id}/stage-history`, true)}>More stage decisions</button>{/if}
        {#if pages.stages?.error}<p role="alert">{pages.stages.error}</p><button type="button" class="quiet-button" onclick={() => refresh('stages', `/api/assets/${currentAsset!.id}/stage-history`)}>Refresh stage decisions</button>{/if}
        {#if pages.stages?.loading}<p role="status">Loading stage decisions…</p>{/if}
      {/if}
    </section>
  {/if}
  {#if currentAsset}
    <p class="muted">Current asset: {currentAsset.name} · stage {currentAsset.stage ?? 'none set'}. Historical stage decisions above do not set current stage.</p>
  {:else}
    <p class="muted">Current asset stage history unavailable until the logical asset is loaded; the capture owner is not substituted.</p>
  {/if}
</section>

<style>
  .history-panel { display: grid; gap: 12px; min-width: 0; color: var(--text); }
  .history-panel h3, .history-panel h4, .history-panel p { margin: 0; }
  .history-panel h3 { font-size: 15px; }
  .history-panel h4 { font-size: 13px; }
  .history-panel .muted { color: var(--muted); font-size: 12px; }
  .section-heading { font-weight: 650; overflow-wrap: anywhere; }
  .history-group { display: grid; gap: 8px; border-top: 1px solid var(--line); padding-top: 11px; min-width: 0; }
  .history-group > button:first-child { justify-self: start; text-align: left; }
  .history-item { display: grid; gap: 5px; min-width: 0; padding: 8px; background: var(--surface-raised); border-radius: 5px; overflow-wrap: anywhere; }
  .revision { display: grid; gap: 4px; padding: 6px 0 6px 10px; border-left: 2px solid var(--line); overflow-wrap: anywhere; }
  .text-button { display: inline; width: fit-content; padding: 0; border: 0; background: none; color: var(--accent-ink); font: inherit; text-align: left; text-decoration: underline; cursor: pointer; }
  .recorded-match { display: grid; gap: 7px; padding: 10px; background: var(--surface-raised); border-radius: 6px; overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow-y: auto; font: 12px/1.5 ui-monospace, monospace; }
</style>
