<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import type { CaptureRecord } from '@assetweave/contracts/capture';
  import type { MediaDescription } from '@assetweave/contracts/media';
  import type { ClipRecord, PlaybackRevision } from '@assetweave/contracts/playback';
  import type { ApiClient } from '../../lib/api/client.js';
  import { frameSource, hasValidTimeline, playbackPosition } from '../../lib/playback.js';

  interface Props {
    api: ApiClient;
    record: CaptureRecord | null;
    media: MediaDescription | null;
    mediaLoading?: boolean;
    mediaError?: string;
    onRefreshMedia?: () => void;
    clips: ClipRecord[];
    clipId?: string;
    pinnedRevisionId?: string;
    hasMoreClips?: boolean;
    onLoadMoreClips?: () => void;
    onClipSelect: (clipId?: string) => void;
    onDisplayedPlayback: (playback: { artifactId: string; clipId: string; revisionId: string } | null) => void;
  }
  let { api, record, media, mediaLoading = false, mediaError, onRefreshMedia, clips, clipId, pinnedRevisionId,
    hasMoreClips = false, onLoadMoreClips, onClipSelect, onDisplayedPlayback }: Props = $props();
  let pinnedRevision = $state<PlaybackRevision | null>(null);
  let missingClip = $state<ClipRecord | null>(null);
  let missingClipId = $state('');
  let missingClipError = $state('');
  let fetchedRevisionId = $state('');
  let pinnedError = $state('');
  let decodedPlayback = $state.raw<{
    revision: PlaybackRevision; media: MediaDescription; images: Map<number, HTMLImageElement>;
  } | null>(null);
  let playbackError = $state('');
  let stillError = $state('');
  let canvas = $state<HTMLCanvasElement | undefined>(undefined);
  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let zoom = $state<'fit' | 'actual'>('fit');
  let playing = $state(false);
  let elapsedMs = $state(0);
  let displayedFrame = $state(-1);
  let clockStart = 0;
  let timeout: number | undefined;
  let revisionKey = '';
  let paintedRevision: PlaybackRevision | null = null;
  let paintedCanvas: HTMLCanvasElement | undefined;
  let reportedPlayback: { artifactId: string; clipId: string; revisionId: string } | null = null;
  function reportDisplayedPlayback(value: typeof reportedPlayback) {
    if (reportedPlayback?.artifactId === value?.artifactId &&
        reportedPlayback?.clipId === value?.clipId &&
        reportedPlayback?.revisionId === value?.revisionId) return;
    reportedPlayback = value;
    untrack(() => onDisplayedPlayback(value));
  }
  let drag: { pointer: number; x: number; y: number; left: number; top: number } | null = null;

  const resolvedClipId = $derived(clipId ?? (pinnedRevisionId && fetchedRevisionId === pinnedRevisionId ? pinnedRevision?.clipId : undefined));
  const clip = $derived(clips.find(item => item.id === resolvedClipId) ??
    (missingClipId === resolvedClipId ? missingClip : null));
  $effect(() => {
    const id = resolvedClipId;
    const artifactId = record?.id;
    const client = api;
    missingClip = null;
    missingClipId = '';
    missingClipError = '';
    if (!id || !artifactId || clips.some(item => item.id === id)) return;
    let active = true;
    void client.get<ClipRecord>(`/api/clips/${id}`).then(value => {
      if (!active) return;
      if (value.id !== id || value.artifactId !== artifactId) {
        missingClipError = 'The selected clip does not belong to this artwork.';
        return;
      }
      missingClip = value;
      missingClipId = id;
    }).catch(cause => {
      if (active) missingClipError = cause instanceof Error ? cause.message : 'The selected clip is unavailable.';
    });
    return () => { active = false; };
  });
  // A requested historical revision cannot temporarily fall back to today's corrected clip.
  const revision = $derived(pinnedRevisionId
    ? (fetchedRevisionId === pinnedRevisionId ? pinnedRevision : null)
    : (clip && clip.current.artifactId === record?.id ? clip.current : null));
  const playableRevision = $derived(revision && hasValidTimeline(revision) ? revision : null);
  const loadedImages = $derived(decodedPlayback?.revision === playableRevision && decodedPlayback.media === media
    ? decodedPlayback.images : null);
  const gifMember = $derived(media?.members.length === 1 && media.members[0]?.format === 'gif' ? media.members[0] : null);
  const firstMember = $derived(media?.members[0] ?? null);

  function localUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
      const resolved = new URL(url, window.location.href);
      return resolved.origin === window.location.origin && resolved.pathname.startsWith('/api/') ? resolved.href : null;
    } catch { return null; }
  }
  const stillUrl = $derived(localUrl(firstMember?.previewUrl));

  $effect(() => {
    const id = pinnedRevisionId;
    const artifactId = record?.id;
    const expectedClipId = clipId;
    const client = api;
    pinnedRevision = null;
    fetchedRevisionId = '';
    pinnedError = '';
    if (!id || !artifactId) return;
    let active = true;
    void client.get<PlaybackRevision>(`/api/playback-revisions/${id}`).then(value => {
      if (!active) return;
      if (value.id !== id || value.artifactId !== artifactId || (expectedClipId && value.clipId !== expectedClipId)) {
        pinnedError = 'This playback revision does not belong to the viewed artwork and clip.';
        return;
      }
      pinnedRevision = value;
      fetchedRevisionId = id;
    }).catch(cause => {
      if (active) pinnedError = cause instanceof Error ? cause.message : 'The pinned playback revision is unavailable.';
    });
    return () => { active = false; };
  });

  $effect(() => {
    const id = `${record?.id ?? ''}:${pinnedRevisionId ?? ''}:${playableRevision?.id ?? ''}`;
    if (revisionKey === id) return;
    revisionKey = id;
    playing = false;
    elapsedMs = 0;
    displayedFrame = -1;
  });

  $effect(() => {
    const selected = playableRevision;
    const description = media;
    if (!selected || !description || gifMember || description.content !== 'available') {
      decodedPlayback = null;
      playbackError = '';
      return;
    }
    let active = true;
    const images: HTMLImageElement[] = [];
    decodedPlayback = null;
    displayedFrame = -1;
    playbackError = '';
    void (async () => {
      const decoded = new Map<number, HTMLImageElement>();
      for (const reference of selected.memberPreviewUrls) {
        const member = description.members.find(item => item.member.ordinal === reference.ordinal);
        const src = localUrl(reference.url);
        if (!src || !member || member.preview !== 'available' || member.format !== 'png') {
          throw new Error('A PNG frame in this playback revision is unavailable.');
        }
        const image = new Image();
        images.push(image);
        image.decoding = 'async';
        image.src = src;
        await image.decode();
        if (!active) return;
        decoded.set(reference.ordinal, image);
      }
      if (!selected.description.frames.every((_, index) => {
        const source = frameSource(selected.description, index);
        return source && decoded.has(source.memberOrdinal);
      })) throw new Error('The recorded frame order cannot be resolved to available PNG members.');
      if (active) decodedPlayback = { revision: selected, media: description, images: decoded };
    })().catch(cause => {
      if (active) playbackError = cause instanceof Error ? cause.message : 'Playback frames could not be loaded.';
    });
    return () => {
      active = false;
      for (const image of images) image.removeAttribute('src');
    };
  });

  $effect(() => { const url = stillUrl; void url; stillError = ''; });

  function stopClock() {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = undefined;
  }
  function paint(selected: PlaybackRevision, images: Map<number, HTMLImageElement>, time: number) {
    const position = playbackPosition(selected.cumulativeMs, selected.cycleMs, time);
    if (!position || !canvas || selected !== playableRevision || images !== loadedImages ||
        selected.artifactId !== record?.id || gifMember || playbackError) {
      reportDisplayedPlayback(null);
      return null;
    }
    if (position.index !== displayedFrame || paintedRevision !== selected || paintedCanvas !== canvas) {
      const source = frameSource(selected.description, position.index);
      const image = source && images.get(source.memberOrdinal);
      const context = canvas.getContext('2d');
      if (!source || !image || !context || source.x + source.width > image.naturalWidth ||
          source.y + source.height > image.naturalHeight) {
        playbackError = 'The recorded frame geometry cannot be drawn from the preserved image.';
        playing = false;
        reportDisplayedPlayback(null);
        return null;
      }
      try {
        if (canvas.width !== source.width) canvas.width = source.width;
        if (canvas.height !== source.height) canvas.height = source.height;
        context.clearRect(0, 0, source.width, source.height);
        context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, source.width, source.height);
      } catch {
        playbackError = 'The recorded frame geometry cannot be drawn from the preserved image.';
        playing = false;
        reportDisplayedPlayback(null);
        return null;
      }
      paintedRevision = selected;
      paintedCanvas = canvas;
      displayedFrame = position.index;
      reportDisplayedPlayback({ artifactId: selected.artifactId, clipId: selected.clipId, revisionId: selected.id });
    }
    elapsedMs = Math.floor(position.elapsedInCycleMs);
    return position;
  }
  $effect(() => {
    const selected = playableRevision;
    const images = loadedImages;
    const isPlaying = playing;
    const element = canvas;
    stopClock();
    if (element && paintedCanvas === element &&
        (paintedRevision !== selected || !images || playbackError || gifMember)) {
      element.getContext('2d')?.clearRect(0, 0, element.width, element.height);
    }
    if (!selected || !images || !element || playbackError || gifMember) {
      paintedRevision = null;
      paintedCanvas = undefined;
      reportDisplayedPlayback(null);
      return;
    }
    if (reportedPlayback?.artifactId !== selected.artifactId ||
        reportedPlayback?.clipId !== selected.clipId || reportedPlayback?.revisionId !== selected.id) {
      reportDisplayedPlayback(null);
    }
    // Every timeout reads the monotonic clock afresh. A delayed tab/timer skips frames rather than drifting.
    untrack(() => {
      if (!isPlaying) { paint(selected, images, elapsedMs); return; }
      clockStart = performance.now() - elapsedMs;
      function advance() {
        const position = paint(selected!, images!, performance.now() - clockStart);
        if (!position) return;
        timeout = window.setTimeout(advance, Math.max(1, Math.ceil(position.untilNextFrameMs)));
      }
      advance();
    });
    return stopClock;
  });
  onDestroy(() => {
    stopClock();
    reportDisplayedPlayback(null);
  });

  function togglePlayback() {
    if (!playableRevision || !loadedImages || playbackError) return;
    if (playing) elapsedMs = (performance.now() - clockStart) % playableRevision.cycleMs;
    playing = !playing;
  }
  function scrub(event: Event) {
    if (!playableRevision) return;
    const target = event.currentTarget as HTMLInputElement;
    const position = Number(target.value);
    if (!Number.isFinite(position)) return;
    elapsedMs = Math.max(0, Math.min(playableRevision.cycleMs - 1, position));
    if (playing) clockStart = performance.now() - elapsedMs;
    if (loadedImages) paint(playableRevision, loadedImages, elapsedMs);
  }
  async function showActualSize() {
    zoom = 'actual';
    await tick();
    viewport?.focus();
  }
  function startPan(event: PointerEvent) {
    if (zoom !== 'actual' || event.pointerType === 'touch' || event.button !== 0 || !viewport ||
        (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight)) return;
    event.preventDefault();
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY,
      left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
  }
  function movePan(event: PointerEvent) {
    const element = viewport;
    if (!drag || drag.pointer !== event.pointerId || !element) return;
    element.scrollLeft = drag.left - (event.clientX - drag.x);
    element.scrollTop = drag.top - (event.clientY - drag.y);
  }
  function stopPan(event: PointerEvent) {
    if (drag?.pointer !== event.pointerId) return;
    drag = null;
    const element = viewport;
    if (element?.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  }
  function duration(milliseconds: number): string {
    return `${Math.floor(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, '0')} s`;
  }
</script>

<section class="media-viewer" aria-label="Artwork media">
  {#if record}
    {#if clips.length || clipId || pinnedRevisionId || hasMoreClips}
      <div class="clip-picker">
        <label>Named clip
          <select value={resolvedClipId ?? ''} onchange={event => onClipSelect(event.currentTarget.value || undefined)}>
            <option value="">Whole artwork · still</option>
            {#if resolvedClipId && !clips.some(item => item.id === resolvedClipId)}
              <option value={resolvedClipId}>{clip?.name ?? `Clip ${resolvedClipId}`}</option>
            {/if}
            {#each clips as available (available.id)}<option value={available.id}>{available.name}</option>{/each}
          </select>
        </label>
        {#if hasMoreClips && onLoadMoreClips}<button class="quiet-button" type="button" onclick={onLoadMoreClips}>Load more clips</button>{/if}
        {#if pinnedRevisionId}
          <span class="revision-label">Pinned historical playback · {clip?.name ?? (resolvedClipId ? `clip ${resolvedClipId}` : 'loading clip')} · {revision ? `revision ${revision.revision}` : pinnedRevisionId}</span>
          {#if revision}<button class="quiet-button" type="button" onclick={() => onClipSelect(revision!.clipId)}>View current clip</button>{/if}
        {:else if clip}<span class="revision-label">Current clip · {clip.name} · revision {clip.revision}</span>{/if}
      </div>
      {#if missingClipError}<p class="notice" role="alert">Clip unavailable: {missingClipError}</p>{/if}
    {/if}
    {#if !media}
      {#if mediaError}<p class="notice" role="alert">Artwork media could not be loaded: {mediaError}. The captured record remains available.</p>
      {:else if mediaLoading}<p class="notice" role="status">Loading artwork media…</p>
      {:else}<p class="notice" role="status">Artwork media is unavailable. The captured record remains available.</p>{/if}
      {#if !mediaLoading}<button class="quiet-button" type="button" disabled={!onRefreshMedia} onclick={() => onRefreshMedia?.()}>Refresh media</button>{/if}
    {:else if media.content === 'unavailable' || !firstMember || firstMember.preview !== 'available'}
      <p class="notice" role="status">Image preview unavailable{firstMember?.reason ? ` (${firstMember.reason})` : ''}. Captured metadata remains available for review.</p>
      {#if media.content === 'available' && localUrl(firstMember?.originalUrl)}
        <a href={localUrl(firstMember?.originalUrl)!}>Download preserved original (not previewable here)</a>
      {/if}
    {:else}
      <div class="viewer-toolbar">
        <span class="hint">
          {#if pinnedRevisionId && !revision}{pinnedError || 'Loading exact playback revision…'}
          {:else if gifMember}
            {#if gifMember.frameCount && gifMember.frameCount > 1}GIF · browser-native encoded playback{:else}GIF image{/if}
          {:else if playableRevision}PNG {playableRevision.description.geometry.kind === 'grid' ? 'regular grid' : 'frame sequence'}
          {:else if clipId}Playback unavailable · named clip not loaded or invalid timing
          {:else if media.kind === 'irregular-atlas'}Irregular atlas · still image only
          {:else}Playback unconfigured · still image{/if}
        </span>
        <span class="zoom-actions" role="group" aria-label="Image scale">
          <button class="quiet-button" type="button" aria-pressed={zoom === 'fit'} onclick={() => zoom = 'fit'}>Fit</button>
          <button class="quiet-button" type="button" aria-pressed={zoom === 'actual'} onclick={showActualSize}>1:1</button>
        </span>
      </div>
      <div bind:this={viewport} class="media-viewport" class:actual={zoom === 'actual'} role="region" tabindex="-1"
        aria-label={zoom === 'actual' ? 'Artwork image, scroll or drag to pan at one-to-one size' : 'Artwork image fitted to the viewer'}
        onpointerdown={startPan} onpointermove={movePan} onpointerup={stopPan} onpointercancel={stopPan}>
        <div class="image-space">
          {#if !gifMember && playableRevision && !pinnedError && !playbackError}
            {#key playableRevision.id}
              <canvas bind:this={canvas} class="display-image"
                aria-label={displayedFrame < 0 ? `Clip frame loading, ${record.name}` :
                  `Clip frame ${displayedFrame + 1} of ${playableRevision.description.frames.length}, ${record.name}`}>Clip frame of {record.name}</canvas>
            {/key}
            {#if !loadedImages}<p class="media-message" role="status">Loading revision-scoped PNG frames…</p>{/if}
          {:else if stillUrl && !stillError}
            <img class="display-image" src={stillUrl} alt={`${record.name} captured artwork`} draggable={false}
              onerror={() => stillError = 'Image preview could not be loaded.'} />
          {:else}<p class="media-message" role="status">{stillError || 'Image preview unavailable.'}</p>{/if}
        </div>
      </div>
      {#if zoom === 'actual'}<p class="hint">At 1:1, scroll or drag inside the image to pan; the page width stays unchanged.</p>{/if}
      {#if playbackError}<p class="notice" role="alert">{playbackError} The still image remains available.</p>{/if}
      {#if pinnedError}<p class="notice" role="alert">Pinned revision unavailable: {pinnedError}</p>{/if}
      {#if gifMember}
        {#if gifMember.frameCount && gifMember.frameCount > 1}
          {#if gifMember.encodedTiming?.status === 'known'}
            <p class="media-stat">{gifMember.frameCount} frames · {duration(gifMember.encodedTiming.cycleMs)} cycle · {gifMember.encodedTiming.framesPerSecond === null ? 'variable encoded frame timing' : `${gifMember.encodedTiming.framesPerSecond} encoded fps`}</p>
          {:else}<p class="media-stat">{gifMember.frameCount} frames · encoded timing unknown (missing or zero delay). Browser-native GIF playback has no frame scrub or pause control.</p>{/if}
        {/if}
      {:else if playableRevision && !pinnedError}
        <div class="playback-controls">
          <button class="secondary-button" type="button" disabled={!loadedImages || !!playbackError} onclick={togglePlayback}>{playing ? 'Pause' : 'Play'}</button>
          <label>Playback position
            <input type="range" min="0" max={Math.max(0, playableRevision.cycleMs - 1)} step="1" value={elapsedMs}
              disabled={!loadedImages || !!playbackError} oninput={scrub} aria-valuetext={`${duration(elapsedMs)} of ${duration(playableRevision.cycleMs)}`} />
          </label>
          <span class="media-stat">Frame {Math.max(0, displayedFrame + 1)} / {playableRevision.description.frames.length} · {duration(elapsedMs)} / {duration(playableRevision.cycleMs)}</span>
        </div>
        <p class="media-stat">{playableRevision.description.frames.length} ordered frames · {playableRevision.framesPerSecond === null ? 'variable frame timing; no single frame rate' : `${playableRevision.framesPerSecond} fps (recorded)`} · source: {playableRevision.description.source.kind}{playableRevision.description.source.detail ? ` — ${playableRevision.description.source.detail}` : ''}</p>
      {:else if !gifMember && !pinnedRevisionId}<p class="media-stat">No animation rate inferred. Configure a named regular-grid or PNG-sequence clip to enable playback.</p>{/if}
    {/if}
  {:else}<p class="empty-state">Open captured artwork to inspect its media.</p>{/if}
</section>

<style>
  .media-viewer { display:grid; gap:10px; min-width:0; width:100%; }
  .viewer-toolbar,.clip-picker { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px 15px; min-width:0; }
  .clip-picker label { display:grid; gap:5px; min-width:min(100%,220px); }
  .clip-picker select { width:100%; }
  .revision-label,.media-stat,.hint { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
  .zoom-actions { display:flex; gap:5px; }
  .zoom-actions button[aria-pressed='true'] { background:var(--accent-fill); color:var(--accent-ink); border-color:var(--accent); }
  .media-viewport { width:100%; max-width:100%; min-width:0; overflow:auto;
    overscroll-behavior:contain; background:var(--stage); border-radius:7px; touch-action:pan-x pan-y; }
  .media-viewport.actual { height:clamp(280px,52vh,640px); cursor:grab; }
  .media-viewport.actual:active { cursor:grabbing; }
  .image-space { width:100%; min-height:100%; height:100%; display:flex; align-items:center; justify-content:center; position:relative; }
  .image-space .display-image { display:block; width:100%; height:100%; max-width:100%; max-height:100%; object-fit:contain; }
  .image-space canvas { image-rendering:pixelated; }
  /* Fit mode: the stage hugs the image instead of holding empty height, so the filmstrip stays near the fold.
     The image still scales up to fill the width and is only capped in height; object-fit keeps the pixels true. */
  .media-viewport:not(.actual) .image-space { height:auto; min-height:120px; }
  .media-viewport:not(.actual) .image-space .display-image { height:auto; max-height:clamp(220px,38vh,420px); }
  .actual .image-space { width:max-content; min-width:100%; height:max-content; min-height:100%; }
  .actual .image-space .display-image { width:auto; height:auto; max-width:none; max-height:none; }
  .media-message { position:absolute; z-index:1; padding:10px; color:#e8edf0; text-align:center; }
  .playback-controls { display:flex; align-items:center; flex-wrap:wrap; gap:10px 14px; min-width:0; }
  .playback-controls label { display:grid; gap:3px; flex:1 1 160px; min-width:0; }
  .playback-controls input[type='range'] { width:100%; padding:0; min-height:20px; }
  @media (max-width:600px) { .viewer-toolbar { align-items:flex-start; }
    .media-viewport.actual { height:clamp(240px,44vh,460px); }
    .media-viewport:not(.actual) .image-space .display-image { max-height:clamp(240px,52vh,460px); } }
</style>
