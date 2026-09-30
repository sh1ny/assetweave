<script lang="ts">
  import type { CandidateRecord, SlotRecord } from '@assetweave/contracts/catalog';
  import type { CaptureRecord } from '@assetweave/contracts/capture';
  import type { MediaDescription } from '@assetweave/contracts/media';
  import type { ClipRecord } from '@assetweave/contracts/playback';
  import type { SearchHit } from '@assetweave/contracts/queries';
  import type { ApiClient } from '../../lib/api/client.js';
  import type { PlacementRecord } from '../catalog/types.js';
  import AlternativesFilmstrip from './AlternativesFilmstrip.svelte';
  import MediaViewer from './MediaViewer.svelte';

  let { api, record, viewedArtifactId, media, mediaError, mediaLoading, clips, clipId, pinnedRevisionId, revisionId, slotRecord, candidate,
    selectedCandidateId, selectedLoaded, candidateLabels, capturedProjectName, capturedAssetName,
    loading, error, hits, placements, ownerProjects, ownerAssets, hasMore, hasMoreClips, searchLoading, searchError,
    onBack, onOpen, onLoadMore, onLoadMoreClips, onRefreshSearch, onRefreshMedia, onClipSelect, onDisplayedPlayback }:
    { api: ApiClient; record: CaptureRecord | null; viewedArtifactId: string; media: MediaDescription | null;
      mediaError: string; mediaLoading: boolean; clips: ClipRecord[];
      clipId?: string; pinnedRevisionId?: string; revisionId?: string; slotRecord: SlotRecord | null; candidate: CandidateRecord | null;
      selectedCandidateId?: string | null; selectedLoaded: boolean;
      candidateLabels: ReadonlyMap<string, { artifactName: string; clipName?: string | null }>;
      capturedProjectName?: string; capturedAssetName?: string; loading: boolean; error: string;
      hits: SearchHit[]; placements: Map<string, PlacementRecord[]>; ownerProjects: Map<string, string>;
      ownerAssets: Map<string, string>; hasMore: boolean; hasMoreClips: boolean; searchLoading: boolean; searchError: string;
      onBack: () => void; onOpen: (hit: SearchHit, placement?: PlacementRecord) => void;
      onLoadMore: () => void; onLoadMoreClips: () => void; onRefreshSearch: () => void;
      onRefreshMedia: () => void; onClipSelect: (clipId?: string) => void;
      onDisplayedPlayback: (playback: { artifactId: string; clipId: string; revisionId: string } | null) => void } = $props();
  const recordMatchesCandidate = $derived(!!record && candidate?.artifactId === record.id &&
    candidate.slotId === slotRecord?.id && candidate.clipId === (clipId ?? null));
  function candidateName(id: string) {
    const label = candidateLabels.get(id);
    if (!label) return id;
    const target = label.clipName === null ? 'Whole artwork' : label.clipName?.trim() || 'Named clip (name unavailable)';
    return `${label.artifactName} · ${target} · #${id.slice(0, 8)}`;
  }
  const viewedTarget = $derived(record
    ? `${record.name} · ${clipId ? clips.find(clip => clip.id === clipId)?.name ?? 'Named clip (name unavailable)' : 'Whole artwork'}`
    : '');
</script>

<section class="review-workspace" aria-label="Opened artwork and slot alternatives">
  <div class="review-navigation"><button type="button" class="back-button" onclick={onBack}>← Back to candidates</button>
    <span>{slotRecord ? `Slot · ${slotRecord.name}` : 'Captured artwork'}</span></div>
  {#if loading}<p role="status" class="muted">Loading verified artwork…</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if record}
    <div class="review-heading"><div><p class="eyebrow">Viewed artwork · reads only</p><h1>{record.name}</h1>
      <p class="muted">{record.kind} · captured {new Date(record.capturedAt).toLocaleString()} · originally {capturedProjectName ?? record.projectId} / {capturedAssetName ?? record.assetId}</p></div></div>
    {#if revisionId}<p class="revision-notice">Recorded match · revision {revisionId}. The current image and current decisions are separate; open the History tab for this exact recorded revision.</p>{/if}
    <div class="states"><p><strong>Viewed record</strong><span>{recordMatchesCandidate ? candidateName(candidate!.id) : `${viewedTarget} · candidate not verified`}</span></p>
      <p><strong>Review for this slot</strong><span>{recordMatchesCandidate ? candidate!.reviewState.replaceAll('-', ' ') : slotRecord ? 'Unavailable for this viewed target until its candidate is verified' : 'No slot in this view'}</span></p>
      <p><strong>Current slot selection</strong><span>{slotRecord ? selectedLoaded ? selectedCandidateId ? candidateName(selectedCandidateId) : 'None recorded' : 'Loading current selection…' : 'No slot in this view'}</span></p></div>
    <details><summary>Record and candidate IDs</summary><dl><dt>Viewed artwork</dt><dd><code>{record.id}</code></dd>
      {#if recordMatchesCandidate}<dt>Viewed candidate</dt><dd><code>{candidate!.id}</code></dd>{/if}
      {#if selectedCandidateId}<dt>Current slot selection</dt><dd><code>{selectedCandidateId}</code></dd>{/if}
      {#if clipId}<dt>Viewed clip</dt><dd><code>{clipId}</code></dd>{/if}
    </dl></details>
    {#if candidate && !recordMatchesCandidate}<p class="notice" role="alert">Candidate identity does not match this artwork and slot. No review or placement is attributed to the viewed record.</p>{/if}
    <MediaViewer {api} {record} {media} {mediaLoading} {mediaError} {onRefreshMedia}
      {clips} {clipId} {pinnedRevisionId} {hasMoreClips} {onLoadMoreClips} {onClipSelect} {onDisplayedPlayback} />
  {:else if !loading && !error}
    <p class="muted">This artwork record is not available. Return to the same candidates and filters.</p>
  {/if}
  <AlternativesFilmstrip {api} {hits} {placements} slotId={slotRecord?.id} {viewedArtifactId}
    viewedCandidateId={candidate?.artifactId === viewedArtifactId && candidate.slotId === slotRecord?.id &&
      candidate.clipId === (clipId ?? null) ? candidate.id : undefined}
    viewedRevisionId={revisionId} {selectedCandidateId} {ownerProjects} {ownerAssets} {hasMore}
    loading={searchLoading} error={searchError} {onOpen} {onLoadMore} onRefresh={onRefreshSearch} />
</section>

<style>
  .review-workspace { min-width:0; display:grid; align-content:start; gap:10px; }
  .review-navigation { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; align-items:center; color:var(--muted); font-size:12px; }
  .back-button { border:0; background:transparent; color:var(--accent-ink); padding:4px 0; font-size:13px; font-weight:650; }
  .back-button:hover { text-decoration:underline; text-underline-offset:3px; }
  .review-heading { margin:2px 0 0; overflow-wrap:anywhere; } .review-heading h1 { margin:2px 0; }
  .review-heading .muted { font-size:13px; } .states { display:flex; flex-wrap:wrap; gap:6px 14px; padding:8px 12px; background:var(--surface); border-radius:7px; }
  .states p { display:grid; gap:2px; min-width:0; flex:1 1 150px; font-size:12px; overflow-wrap:anywhere; }
  .states strong { color:var(--subtle); text-transform:uppercase; letter-spacing:.05em; font-size:11px; }
  .states span { color:var(--text); display:-webkit-box; -webkit-line-clamp:2; line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .error { color:var(--status-rejected-ink); }
  .revision-notice { padding:9px 12px; background:var(--accent-fill); color:var(--accent-ink); border-radius:6px; overflow-wrap:anywhere; }
  @media(max-width:620px) { .states { gap:10px; } .states p { flex-basis:100%; } }
</style>
