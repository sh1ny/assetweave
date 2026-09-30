<script module lang="ts">
  interface EditorDraft {
    name: string;
    cellWidth: string; cellHeight: string; columns: string; rows: string;
    offsetX: string; offsetY: string; gapX: string; gapY: string;
    sequenceWidth: string; sequenceHeight: string;
    frames: string; durations: string; sourceKind: string; sourceDetail: string;
    expectedRevision: number | null;
    conflict: boolean;
  }
  // Keep unsent edits in this tab across brief detail-panel unmounts, without mutating a service record.
  const draftCache = new Map<string, EditorDraft>();
  function cacheKey(artifactId: string, clipId: string): string { return `${artifactId}:${clipId || 'new'}`; }
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { CaptureRecord } from '@assetweave/contracts/capture';
  import type { MediaDescription } from '@assetweave/contracts/media';
  import { correctPlaybackInput, createClipInput, type ClipRecord, type PlaybackDescription } from '@assetweave/contracts/playback';
  import { mediaLimits } from '@assetweave/contracts/media';
  import { ApiClientError, type ApiClient } from '../../lib/api/client.js';
  import { parseOrderedIntegers } from '../../lib/playback.js';

  interface Props {
    api: ApiClient;
    record: CaptureRecord;
    media: MediaDescription | null;
    clips: ClipRecord[];
    selectedClipId?: string;
    hasMore: boolean;
    onLoadMore: () => void;
    onChanged: () => void;
  }
  let { api, record, media, clips, selectedClipId, hasMore, onLoadMore, onChanged }: Props = $props();

  function initialDraft(clip: ClipRecord | undefined, description: MediaDescription | null): EditorDraft {
    const current = clip?.current.description;
    const grid = current?.geometry.kind === 'grid' ? current.geometry : null;
    const sequence = current?.geometry.kind === 'sequence' ? current.geometry : null;
    const first = description?.members[0];
    return {
      name: clip?.name ?? '',
      cellWidth: grid ? String(grid.cellWidth) : '', cellHeight: grid ? String(grid.cellHeight) : '',
      columns: grid ? String(grid.columns) : '', rows: grid ? String(grid.rows) : '',
      offsetX: grid?.offsetX === undefined ? '' : String(grid.offsetX),
      offsetY: grid?.offsetY === undefined ? '' : String(grid.offsetY),
      gapX: grid?.gapX === undefined ? '' : String(grid.gapX),
      gapY: grid?.gapY === undefined ? '' : String(grid.gapY),
      sequenceWidth: sequence ? String(sequence.width) : first?.width ? String(first.width) : '',
      sequenceHeight: sequence ? String(sequence.height) : first?.height ? String(first.height) : '',
      frames: current?.frames.join(', ') ?? '', durations: current?.durationsMs.join(', ') ?? '',
      sourceKind: current?.source.kind ?? '', sourceDetail: current?.source.detail ?? '',
      expectedRevision: clip?.revision ?? null, conflict: false,
    };
  }
  function readDraft(artifactId: string, clipId: string, available: ClipRecord[], description: MediaDescription | null): EditorDraft {
    return { ...(draftCache.get(cacheKey(artifactId, clipId)) ?? initialDraft(available.find(item => item.id === clipId), description)) };
  }
  let artifactId = untrack(() => record.id);
  let externalSelection = untrack(() => selectedClipId ?? '');
  let editClipId = $state(externalSelection);
  let draft = $state<EditorDraft>(untrack(() => readDraft(artifactId, editClipId, clips, media)));
  let error = $state('');
  let message = $state('');
  let busy = $state(false);
  const currentClip = $derived(clips.find(item => item.id === editClipId));
  const kind = $derived(record.kind === 'png-sequence' ? 'sequence' : 'grid');
  const canEdit = $derived(!!media && media.content === 'available' && record.kind !== 'irregular-atlas' &&
    (kind === 'sequence' ? media.members.length >= 2 : media.members.length === 1) &&
    media.members.every(item => item.preview === 'available' && item.format === 'png'));
  const latestRevision = $derived(currentClip?.revision ?? null);
  $effect(() => {
    const loaded = currentClip;
    if (loaded && editClipId && draft.expectedRevision === null) draft = initialDraft(loaded, media);
  });

  function remember() { draftCache.set(cacheKey(artifactId, editClipId), { ...draft }); }
  onDestroy(remember);
  $effect(() => {
    const nextArtifact = record.id;
    const nextExternal = selectedClipId ?? '';
    if (artifactId === nextArtifact && externalSelection === nextExternal) return;
    remember();
    artifactId = nextArtifact;
    externalSelection = nextExternal;
    editClipId = nextExternal;
    draft = readDraft(nextArtifact, nextExternal, clips, media);
    error = '';
    message = '';
  });
  $effect(() => {
    // Subscribe to each field rather than the object identity so bound inputs persist even before unmount.
    const snapshot: EditorDraft = {
      name: draft.name, cellWidth: draft.cellWidth, cellHeight: draft.cellHeight,
      columns: draft.columns, rows: draft.rows, offsetX: draft.offsetX, offsetY: draft.offsetY,
      gapX: draft.gapX, gapY: draft.gapY, sequenceWidth: draft.sequenceWidth,
      sequenceHeight: draft.sequenceHeight, frames: draft.frames, durations: draft.durations,
      sourceKind: draft.sourceKind, sourceDetail: draft.sourceDetail,
      expectedRevision: draft.expectedRevision, conflict: draft.conflict,
    };
    draftCache.set(cacheKey(artifactId, editClipId), snapshot);
  });
  function chooseClip(id: string) {
    if (busy || id === editClipId) return;
    remember();
    editClipId = id;
    draft = readDraft(artifactId, id, clips, media);
    error = '';
    message = '';
  }
  function resetDraft() {
    if (busy) return;
    draftCache.delete(cacheKey(artifactId, editClipId));
    draft = initialDraft(currentClip, media);
    error = '';
    message = 'Unsaved changes discarded. No service record changed.';
  }
  function adoptRevision() {
    if (!draft.conflict || !currentClip || latestRevision === null || latestRevision === draft.expectedRevision) return;
    draft.expectedRevision = latestRevision;
    draft.conflict = false;
    error = '';
    message = `Revision ${latestRevision} adopted as the correction base. Your unsent fields have not been replaced; review them before saving.`;
  }
  function integer(text: string): number { return /^\d+$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN; }

  function validate(): { description: PlaybackDescription; name: string } | null {
    const frames = parseOrderedIntegers(draft.frames, 0);
    const durationsMs = parseOrderedIntegers(draft.durations, 1);
    if (!frames || !durationsMs || frames.length !== durationsMs.length) {
      error = 'Enter ordered frame indices and exactly one positive duration in milliseconds for each frame. No frame rate is inferred.';
      return null;
    }
    const optional = (text: string) => text.trim() === '' ? undefined : integer(text);
    const geometry = kind === 'grid' ? {
      kind: 'grid' as const, memberOrdinal: media?.members[0]?.member.ordinal ?? 0,
      cellWidth: integer(draft.cellWidth), cellHeight: integer(draft.cellHeight),
      columns: integer(draft.columns), rows: integer(draft.rows),
      ...(draft.offsetX.trim() ? { offsetX: optional(draft.offsetX) } : {}),
      ...(draft.offsetY.trim() ? { offsetY: optional(draft.offsetY) } : {}),
      ...(draft.gapX.trim() ? { gapX: optional(draft.gapX) } : {}),
      ...(draft.gapY.trim() ? { gapY: optional(draft.gapY) } : {}),
    } : { kind: 'sequence' as const, width: integer(draft.sequenceWidth), height: integer(draft.sequenceHeight) };
    const input = {
      geometry, frames, durationsMs,
      source: { kind: draft.sourceKind.trim(), ...(draft.sourceDetail.trim() ? { detail: draft.sourceDetail.trim() } : {}) },
    };
    const parsed = editClipId ? correctPlaybackInput.safeParse({ ...input, expectedRevision: draft.expectedRevision }) :
      createClipInput.safeParse({ ...input, name: draft.name.trim() });
    if (!parsed.success) {
      error = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' · ');
      return null;
    }
    if (!media || !canEdit) { error = 'All PNG members must be available before describing or correcting playback.'; return null; }
    if (geometry.kind === 'grid') {
      const member = media.members[0]!;
      if (geometry.columns * geometry.rows > mediaLimits.maxFrames ||
          (geometry.offsetX ?? 0) + geometry.columns * geometry.cellWidth + (geometry.columns - 1) * (geometry.gapX ?? 0) > member.width! ||
          (geometry.offsetY ?? 0) + geometry.rows * geometry.cellHeight + (geometry.rows - 1) * (geometry.gapY ?? 0) > member.height! ||
          frames.some(frame => frame >= geometry.columns * geometry.rows)) {
        error = 'Recorded cells or ordered grid indices extend outside the preserved PNG.';
        return null;
      }
    } else if (media.members.some((item, index) => item.member.ordinal !== index || item.width !== geometry.width || item.height !== geometry.height) ||
               frames.some(frame => frame >= media.members.length)) {
      error = 'Sequence indices must identify captured member ordinals, and every member must match the recorded dimensions.';
      return null;
    }
    return { description: input, name: draft.name.trim() };
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || draft.conflict || (editClipId && !currentClip)) return;
    const valid = validate();
    if (!valid) return;
    busy = true;
    error = '';
    message = '';
    let refresh = false;
    try {
      if (editClipId) {
        const result = await api.mutate<ClipRecord>(`/api/clips/${editClipId}`, 'PATCH', {
          ...valid.description, expectedRevision: draft.expectedRevision,
        });
        draftCache.delete(cacheKey(artifactId, editClipId));
        draft = initialDraft(result, media);
        message = `Corrected ${result.name} to revision ${result.revision}. Earlier revisions remain in history.`;
      } else {
        const result = await api.mutate<ClipRecord>(`/api/artifacts/${record.id}/clips`, 'POST', {
          ...valid.description, name: valid.name,
        });
        draftCache.delete(cacheKey(artifactId, editClipId));
        draft = initialDraft(undefined, media);
        message = `Created named clip ${result.name}. It can now be chosen for this artwork.`;
      }
      refresh = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Clip changes could not be saved.';
      if (cause instanceof ApiClientError && cause.code === 'CONFLICT') {
        if (editClipId) {
          draft.conflict = true;
          error += ' Your draft is retained. Refresh the clip list, then explicitly adopt the latest revision before another attempt.';
        } else error += ' Your draft is retained; use a distinct clip name before submitting again.';
        refresh = true;
      }
      remember();
    } finally { busy = false; }
    if (refresh) onChanged();
  }
</script>

<section class="clip-editor" aria-label="Named clip configuration">
  <div class="editor-heading"><div><p class="section-kicker">Playback description</p><h3>Named clips</h3></div>
    <span class="hint">Sourced geometry, ordered frames, recorded timing</span></div>
  <div class="editor-choice">
    <label>Edit
      <select value={editClipId} disabled={busy} onchange={event => chooseClip(event.currentTarget.value)}>
        <option value="">Create named clip</option>
        {#if editClipId && !currentClip}<option value={editClipId}>Clip not loaded ({editClipId})</option>{/if}
        {#each clips as available (available.id)}<option value={available.id}>{available.name} · revision {available.revision}</option>{/each}
      </select>
    </label>
    {#if hasMore}<button class="quiet-button" type="button" disabled={busy} onclick={onLoadMore}>Load more clips</button>{/if}
  </div>
  {#if !media}<p class="notice">Loading media information before configuring playback…</p>
  {:else if !canEdit}<p class="notice">Playback description unavailable here. Only fully decoded regular-grid PNGs and ordered PNG sequences are supported; irregular atlases, GIFs, and unavailable images remain still/native media.</p>{/if}
  {#if editClipId && !currentClip}<p class="notice" role="status">This clip is not in the loaded page. Load more clips to correct it; unsent fields are retained.</p>{/if}
  {#if draft.conflict}<p class="notice" role="alert">The recorded clip changed before your correction. Your geometry, order, timing and source are unchanged.
    {#if currentClip && latestRevision !== draft.expectedRevision}
      Current revision: {latestRevision}; your base: {draft.expectedRevision}.
      <button class="secondary-button" type="button" onclick={adoptRevision}>Adopt revision {latestRevision} as base, keep my draft</button>
    {:else}Waiting for the refreshed clip revision. Do not resubmit until you explicitly adopt it.{/if}
  </p>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if message}<p class="notice" role="status">{message}</p>{/if}
  <form onsubmit={submit}>
    {#if !editClipId}<label>Clip name <input bind:value={draft.name} disabled={busy || !canEdit} required maxlength="200" placeholder="Name this clip for later selection" /></label>
    {:else}<p class="hint">Correcting {currentClip?.name ?? editClipId} · base revision {draft.expectedRevision ?? 'not loaded'}. The clip name stays stable; prior playback revisions are retained.</p>{/if}
    {#if kind === 'grid'}
      <fieldset disabled={busy || !canEdit || !!editClipId && !currentClip}><legend>Regular grid · row-major cell indices</legend>
        <p class="hint">Member #{media?.members[0]?.member.ordinal ?? 0} · {media?.members[0]?.member.sourceName ?? 'image unavailable'} · {media?.members[0]?.width ?? '?'} × {media?.members[0]?.height ?? '?'} px. Cells cannot extend outside the image.</p>
        <div class="field-grid">
          <label>Cell width (px)<input bind:value={draft.cellWidth} inputmode="numeric" required /></label>
          <label>Cell height (px)<input bind:value={draft.cellHeight} inputmode="numeric" required /></label>
          <label>Columns<input bind:value={draft.columns} inputmode="numeric" required /></label>
          <label>Rows<input bind:value={draft.rows} inputmode="numeric" required /></label>
          <label>Left offset (px)<input bind:value={draft.offsetX} inputmode="numeric" placeholder="Optional" /></label>
          <label>Top offset (px)<input bind:value={draft.offsetY} inputmode="numeric" placeholder="Optional" /></label>
          <label>Horizontal gap (px)<input bind:value={draft.gapX} inputmode="numeric" placeholder="Optional" /></label>
          <label>Vertical gap (px)<input bind:value={draft.gapY} inputmode="numeric" placeholder="Optional" /></label>
        </div>
      </fieldset>
    {:else}
      <fieldset disabled={busy || !canEdit || !!editClipId && !currentClip}><legend>PNG sequence · captured member ordinals</legend>
        <p class="hint">Files are shown in preserved capture order, never filename order.</p>
        <ol class="member-list">{#each media?.members ?? [] as item (item.member.ordinal)}<li>#{item.member.ordinal} · {item.member.sourceName} · {item.width ?? '?'} × {item.height ?? '?'} px</li>{/each}</ol>
        <div class="field-grid">
          <label>Frame width (px)<input bind:value={draft.sequenceWidth} inputmode="numeric" required /></label>
          <label>Frame height (px)<input bind:value={draft.sequenceHeight} inputmode="numeric" required /></label>
        </div>
      </fieldset>
    {/if}
    <div class="field-grid">
      <label>Frame order (indices, comma or space separated)<textarea bind:value={draft.frames} disabled={busy || !canEdit || !!editClipId && !currentClip} required rows="2" placeholder={kind === 'grid' ? 'Enter row-major cell indices' : 'Enter captured member ordinals'}></textarea></label>
      <label>Per-frame duration (ms, same order)<textarea bind:value={draft.durations} disabled={busy || !canEdit || !!editClipId && !currentClip} required rows="2" placeholder="Enter one positive millisecond value per frame"></textarea></label>
    </div>
    <p class="hint">Repeat indices only when intentionally playing a frame more than once. Timing is supplied, never derived from the number of frames.</p>
    <div class="field-grid">
      <label>Playback information supplied by<input bind:value={draft.sourceKind} disabled={busy || !canEdit || !!editClipId && !currentClip} required maxlength="200" placeholder="State the actual source of this description" /></label>
      <label>Source detail (optional)<input bind:value={draft.sourceDetail} disabled={busy || !canEdit || !!editClipId && !currentClip} maxlength="16384" placeholder="Where the geometry and timing came from" /></label>
    </div>
    <div class="form-actions">
      <button class="primary-button" type="submit" disabled={busy || !canEdit || !!editClipId && !currentClip || draft.conflict}>{busy ? 'Saving…' : editClipId ? 'Correct playback' : 'Create clip'}</button>
      <button class="quiet-button" type="button" disabled={busy} onclick={resetDraft}>Discard unsaved changes</button>
    </div>
  </form>
</section>

<style>
  .clip-editor { display:grid; gap:12px; min-width:0; width:100%; }
  .editor-heading,.editor-choice,.form-actions { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 12px; }
  .editor-heading h3 { margin-top:4px; }
  .editor-choice label { display:grid; gap:5px; min-width:min(100%,210px); }
  .editor-choice select { width:100%; }
  .clip-editor form { display:grid; gap:13px; min-width:0; }
  .clip-editor form > label,.field-grid label { display:grid; gap:5px; min-width:0; }
  .clip-editor :is(input,textarea) { width:100%; }
  .field-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 12px; min-width:0; }
  .member-list { margin:8px 0; padding-left:24px; max-height:140px; overflow:auto; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
  .hint { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
  .notice button { margin-top:8px; }
  @media (max-width:560px) { .field-grid { grid-template-columns:minmax(0,1fr); } }
</style>
