<script lang="ts">
  import type { SearchHit } from '@assetweave/contracts/queries';
  import { onDestroy } from 'svelte';
  import type { MediaThumbnail } from '@assetweave/contracts/media';
  import type { ApiClient } from '../../lib/api/client.js';
  import type { PlacementRecord } from './types.js';

  let { api, hits, placements, ownerProjects, ownerAssets, slotId, selectedCandidateId, viewedArtifactId, onOpen }:
    { api: ApiClient; hits: SearchHit[]; placements: Map<string, PlacementRecord[]>;
      ownerProjects: Map<string, string>; ownerAssets: Map<string, string>;
      slotId?: string; selectedCandidateId?: string | null; viewedArtifactId?: string;
      onOpen: (hit: SearchHit, placement?: PlacementRecord) => void } = $props();
  let media = $state<Record<string, MediaThumbnail | null>>({});
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
        .then(thumbnail => { if (!destroyed && client === api) media = { ...media, [artifactId]: thumbnail }; })
        .catch(() => { if (!destroyed && client === api) media = { ...media, [artifactId]: null }; })
        .finally(() => { thumbnailRequests--; loadVisible(visible); });
    }
  }
  $effect(() => {
    const inView = visible;
    if (api !== mediaClient) { mediaClient = api; requested.clear(); media = {}; }
    loadVisible(inView);
  });
  const entries = $derived(hits.flatMap(hit => {
    if (!slotId) return [{ hit, placement: undefined as PlacementRecord | undefined }];
    return (placements.get(hit.artifactId) ?? []).map(placement => ({ hit, placement }));
  }));
  function thumbnail(artifactId: string) {
    return media[artifactId]?.previewUrl ?? null;
  }
</script>

{#if entries.length}
  <div class="gallery" aria-label="Artwork results">
    {#each entries as {hit, placement}, index (`${hit.artifactId}:${hit.matchedRevision?.revisionId ?? 'current'}:${placement?.candidate.id ?? 'unplaced'}:${index}`)}
      <button type="button" class="candidate-card" aria-label={`View ${hit.name}${placement?.clipName ? `, clip ${placement.clipName}` : ''}`}
        use:watchThumbnail={hit.artifactId} onclick={() => onOpen(hit, placement)}>
        <span class="image-area">
          {#if thumbnail(hit.artifactId)}<img src={thumbnail(hit.artifactId)!} loading="lazy" alt="" />
          {:else}<span class="image-label">{Object.hasOwn(media, hit.artifactId) ? 'Preview unavailable' : 'Loading preview…'}</span>{/if}
        </span>
        <span class="card-content">
          <span class="card-head"><strong>{hit.name}</strong><span class="kind">{hit.kind}</span></span>
          {#if placement?.clipName}<span class="minor">Clip placement · {placement.clipName}</span>{/if}
          {#if placement}<span class="minor">Placed here · captured by {placement.capturedProjectName} / {placement.capturedAssetName}</span>
          {:else if !slotId}<span class="minor">Captured by {ownerProjects.get(hit.projectId) ?? hit.projectId} / {ownerAssets.get(hit.assetId) ?? hit.assetId}</span>{/if}
          <span class="meta">
            {#if placement}<span class={`status status-${placement.candidate.reviewState}`}>{placement.candidate.reviewState.replaceAll('-', ' ')}</span>
              {#if placement.candidate.id === selectedCandidateId}<span class="badge selection">Selected for this slot</span>
              {:else if placement.formerlySelected}<span class="badge">Formerly selected</span>{/if}
            {:else if !slotId}<span class="badge">Placement not checked</span>{/if}
            {#if viewedArtifactId === hit.artifactId}<span class="badge viewing">Viewed record</span>{/if}
            {#if hit.matchedRevision}<span class="badge">Historical match · revision {hit.matchedRevision.revision}</span>{/if}
          </span>
          <time datetime={hit.capturedAt} class="minor">Captured {new Date(hit.capturedAt).toLocaleString()}</time>
        </span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .gallery { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
  .candidate-card { min-width:0; overflow:hidden; display:block; width:100%; border:0; border-radius:8px; background:var(--surface); color:var(--text); text-align:left; padding:0; }
  .candidate-card:hover { background:var(--surface-raised); }
  .image-area { display:grid; place-items:center; background:var(--stage); aspect-ratio:1.12; overflow:hidden; }
  .image-area img { max-width:100%; max-height:100%; object-fit:contain; }
  .image-label { color:#d0d9dc; font-size:12px; text-align:center; padding:10px; }
  .card-content { display:grid; gap:6px; min-width:0; padding:11px 12px 13px; }
  .card-head { display:flex; align-items:baseline; flex-wrap:wrap; justify-content:space-between; gap:4px 9px; }
  .card-head strong { font-size:14px; overflow-wrap:anywhere; } .kind,.minor { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
  .meta { display:flex; flex-wrap:wrap; gap:5px; margin:3px 0; }
  .status,.badge { display:inline-block; font-size:11px; font-weight:600; border-radius:4px; padding:3px 6px; }
  .status-unreviewed { background:var(--status-unreviewed-bg); color:var(--status-unreviewed-ink); }
  .status-reviewed-undecided { background:var(--status-undecided-bg); color:var(--status-undecided-ink); }
  .status-approved { background:var(--status-approved-bg); color:var(--status-approved-ink); }
  .status-rejected { background:var(--status-rejected-bg); color:var(--status-rejected-ink); }
  .badge { background:var(--surface-raised); color:var(--text); }
  .badge.selection { background:var(--selection-fill); color:var(--selection-ink); }
  .badge.viewing { background:var(--accent-fill); color:var(--accent-ink); }
  @media (max-width:1150px) { .gallery { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  @media (max-width:360px) { .gallery { grid-template-columns:minmax(0,1fr); } }
</style>
