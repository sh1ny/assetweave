<script lang="ts">
  import type { CandidateRecord } from '@assetweave/contracts/catalog';
  import { onDestroy } from 'svelte';
  import type { MediaThumbnail } from '@assetweave/contracts/media';
  import type { SearchHit } from '@assetweave/contracts/queries';
  import type { ApiClient } from '../../lib/api/client.js';
  import type { PlacementRecord } from '../catalog/types.js';

  let { api, hits, placements, slotId, viewedArtifactId, viewedCandidateId, viewedRevisionId, selectedCandidateId,
    ownerProjects, ownerAssets, hasMore, loading, error, onOpen, onLoadMore, onRefresh }:
    { api: ApiClient; hits: SearchHit[]; placements: Map<string, PlacementRecord[]>;
      slotId?: string; viewedArtifactId: string; viewedCandidateId?: string; viewedRevisionId?: string;
      selectedCandidateId?: string | null; ownerProjects: Map<string, string>; ownerAssets: Map<string, string>;
      hasMore: boolean; loading: boolean; error: string;
      onOpen: (hit: SearchHit, placement?: PlacementRecord) => void;
      onLoadMore: () => void; onRefresh: () => void } = $props();
  let thumbnails = $state<Record<string, MediaThumbnail | null>>({});
  let visible = $state<Set<string>>(new Set());
  const requested = new Set<string>();
  const observed = new Map<Element, string>();
  let observer: IntersectionObserver | undefined;
  let mediaClient: ApiClient | null = null;
  let thumbnailRequests = 0;
  let destroyed = false;
  function markVisible(id: string) {
    if (destroyed || visible.has(id)) return;
    visible = new Set(visible).add(id);
  }
  function watchThumbnail(node: HTMLElement, artifactId: string) {
    if (typeof IntersectionObserver === 'undefined') { markVisible(artifactId); return; }
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = observed.get(entry.target);
        if (!id) continue;
        markVisible(id);
        observer?.unobserve(entry.target);
        observed.delete(entry.target);
      }
    });
    observed.set(node, artifactId);
    observer.observe(node);
    return { destroy() { observer?.unobserve(node); observed.delete(node); } };
  }
  onDestroy(() => { destroyed = true; observer?.disconnect(); });
  function loadVisible(inView: Set<string>) {
    if (destroyed || api !== mediaClient) return;
    const client = api;
    for (const hit of hits) {
      if (thumbnailRequests >= 2) break;
      const artifactId = hit.artifactId;
      if (!inView.has(artifactId) || requested.has(artifactId)) continue;
      requested.add(artifactId);
      thumbnailRequests++;
      void client.get<MediaThumbnail>(`/api/artifacts/${artifactId}/media/thumbnail`)
        .then(value => { if (!destroyed && api === client) thumbnails = { ...thumbnails, [artifactId]: value }; })
        .catch(() => { if (!destroyed && api === client) thumbnails = { ...thumbnails, [artifactId]: null }; })
        .finally(() => { thumbnailRequests--; loadVisible(visible); });
    }
  }
  $effect(() => {
    const inView = visible;
    if (api !== mediaClient) { mediaClient = api; requested.clear(); thumbnails = {}; }
    loadVisible(inView);
  });
  const entries = $derived(hits.flatMap(hit => slotId
    ? (placements.get(hit.artifactId) ?? []).map(placement => ({ hit, placement }))
    : [{ hit, placement: undefined as PlacementRecord | undefined }]));
  const inLoaded = $derived(entries.some(({ hit, placement }) => hit.artifactId === viewedArtifactId &&
    hit.matchedRevision?.revisionId === viewedRevisionId &&
    (!slotId || placement?.candidate.id === viewedCandidateId)));
  function thumbnail(id: string) {
    return thumbnails[id]?.previewUrl ?? null;
  }
  function review(candidate: CandidateRecord) { return candidate.reviewState.replaceAll('-', ' '); }
</script>

<section class="alternatives" aria-label="Other artwork in this view">
  <div class="heading"><div><h2>Alternatives in this view</h2>
    <p>Compare recorded candidates; opening one never changes a review or selection.</p></div>
    <span>{entries.length} loaded</span></div>
  {#if !inLoaded && !loading && !error}
    <p class="context-note">{hasMore ? 'Viewed target is not among the loaded alternatives yet; more pages remain.' : 'Viewed target is not among the alternatives for this slot or filter. It remains open for inspection.'}</p>
  {/if}
  {#if loading}<p role="status" class="context-note">Loading more alternatives…</p>{/if}
  {#if error}<p role="alert" class="context-note">Alternatives unavailable: {error} <button class="quiet-button" type="button" onclick={onRefresh}>Refresh alternatives</button></p>{/if}
  {#if entries.length}
    <div class="filmstrip">
      {#each entries as { hit, placement }, index (`${hit.artifactId}:${hit.matchedRevision?.revisionId ?? 'current'}:${placement?.candidate.id ?? 'unplaced'}:${index}`)}
        <button class="alternative" type="button" aria-current={hit.artifactId === viewedArtifactId && hit.matchedRevision?.revisionId === viewedRevisionId && (!slotId || placement?.candidate.id === viewedCandidateId) ? 'true' : undefined}
          aria-label={`View ${hit.name}${placement?.clipName ? `, clip ${placement.clipName}` : ''}`} use:watchThumbnail={hit.artifactId} onclick={() => onOpen(hit, placement)}>
          <span class="thumbnail">{#if thumbnail(hit.artifactId)}<img src={thumbnail(hit.artifactId)!} loading="lazy" alt="" />
            {:else}<span>{Object.hasOwn(thumbnails, hit.artifactId) ? 'Preview unavailable' : 'Loading preview…'}</span>{/if}</span>
          <span class="details"><strong>{hit.name}</strong>
            {#if placement}<small>{placement.clipName ? `Clip: ${placement.clipName} · ` : ''}Review: {review(placement.candidate)}</small>
              <small>{placement.candidate.id === selectedCandidateId ? 'Current slot selection' : placement.formerlySelected ? 'Formerly selected' : 'Not selected for this slot'}</small>
            {:else}<small>{slotId ? 'Placement not verified' : `Captured by ${ownerProjects.get(hit.projectId) ?? hit.projectId} / ${ownerAssets.get(hit.assetId) ?? hit.assetId}`}</small>{/if}
            {#if hit.matchedRevision}<small>Historical match · revision {hit.matchedRevision.revision}</small>{/if}
            {#if hit.artifactId === viewedArtifactId && hit.matchedRevision?.revisionId === viewedRevisionId && (!slotId || placement?.candidate.id === viewedCandidateId)}<small class="viewed">Viewed now</small>{/if}
          </span>
        </button>
      {/each}
    </div>
  {:else if !loading && !error}<p class="context-note">No alternatives loaded for these filters. This does not change the viewed artwork.</p>{/if}
  {#if hasMore}<button class="quiet-button more" type="button" disabled={loading} onclick={onLoadMore}>Load more artwork</button>{/if}
</section>

<style>
  .alternatives { min-width:0; margin-top:8px; } .heading { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:8px; }
  h2 { font-size:15px; } .heading p,.heading span,.context-note { color:var(--muted); font-size:12px; }
  .heading span { white-space:nowrap; } .context-note { margin:8px 0; overflow-wrap:anywhere; }
  .filmstrip { display:flex; gap:8px; min-width:0; overflow-x:auto; padding:2px 2px 10px; scrollbar-color:var(--control-line) transparent; }
  .alternative { flex:0 0 clamp(112px,17%,160px); min-width:0; padding:0; border:0; border-radius:6px; background:var(--surface); color:var(--text); overflow:hidden; text-align:left; }
  .alternative:hover { background:var(--surface-raised); } .alternative[aria-current] { outline:2px solid var(--accent); outline-offset:-2px; }
  .thumbnail { display:grid; place-items:center; width:100%; aspect-ratio:1; background:var(--stage); color:#d0d9dc; text-align:center; font-size:11px; }
  .thumbnail img { max-width:100%; max-height:100%; object-fit:contain; }   .details { display:grid; gap:2px; min-height:64px; padding:6px 8px 8px; overflow-wrap:anywhere; }
  .details strong { font-size:12px; } .details small { color:var(--muted); font-size:11px; line-height:1.3; } .details .viewed { color:var(--accent-ink); font-weight:650; }
  .more { margin-top:6px; } @media(max-width:620px) { .heading span { display:none; } .alternative { flex-basis:112px; } }
</style>
