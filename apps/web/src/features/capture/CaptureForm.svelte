<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { captureReceiptSchema, type CaptureMetadata, type CaptureReceipt } from '@assetweave/contracts/capture';
  import { claimInput, exactInput, lineageGapInput, productionFields, type ClaimInput, type ExactInput, type LineageGapInput } from '@assetweave/contracts/production';
  import type { SlotRecord } from '@assetweave/contracts/catalog';
  import type { ApiClient } from '../../lib/api/client.js';
  import { buildCaptureManifest, recoverCaptureOperation, validateCaptureSelection, verifyCaptureReplay } from '../../lib/capture-manifest.js';
  import { navigationHref } from '../../lib/navigation.js';

  interface Props {
    api: ApiClient;
    projectId: string;
    assetId: string;
    slots: SlotRecord[];
    slotId?: string;
    requestId?: string;
    onCommitted: (receipt: CaptureReceipt, metadata: CaptureMetadata) => void;
  }
  let { api, projectId, assetId, slots, slotId, requestId, onCommitted }: Props = $props();
  let files = $state<File[]>([]);
  let kind = $state('png');
  let name = $state('');
  let notes = $state('');
  // The initial route proposes a destination; later focus refreshes must not overwrite an unsent choice.
  let chosenSlot = $state(untrack(() => slotId ?? ''));
  let associateRequest = $state(true);
  let claims = $state<ClaimInput[]>([]);
  let claimField = $state('');
  let claimState = $state<'known' | 'unknown' | 'absent'>('known');
  let claimValue = $state('');
  let claimSourceKind = $state('');
  let claimSourceDetail = $state('');
  let inputs = $state<ExactInput[]>([]);
  let inputArtifactId = $state('');
  let inputRole = $state('');
  let inputClipId = $state('');
  let inputPlaybackRevisionId = $state('');
  let gaps = $state<LineageGapInput[]>([]);
  let gapArtifactId = $state('');
  let gapDescription = $state('');
  let gapSourceKind = $state('');
  let operationId = $state<string | null>(null);
  let pendingMetadata = $state<CaptureMetadata | null>(null);
  let receipt = $state<CaptureReceipt | null>(null);
  let error = $state('');
  let message = $state('');
  let busy = $state(false);
  const selectedKind = $derived(operationId && pendingMetadata ? pendingMetadata.kind : kind);
  const selectedError = $derived(files.length ? validateCaptureSelection(files, selectedKind) : null);
  const canReplay = $derived(!!pendingMetadata && !!operationId &&
    (receipt?.status === 'orphan' || receipt?.status === 'absent'));
  const storageKey = $derived(`assetweave:capture-operation:${projectId}:${assetId}`);

  onMount(() => {
    try {
      const stored = recoverCaptureOperation(sessionStorage.getItem(storageKey), projectId, assetId);
      if (stored) {
        operationId = stored.operationId;
        pendingMetadata = stored.metadata;
        message = stored.metadata
          ? 'An earlier capture may have reached the service. Check its receipt before any deliberate replay; reselect the exact original files.'
          : 'An earlier capture may have reached the service. Its original metadata is unavailable here. Keep its operation ID and check the receipt; do not resend altered context.';
      }
    } catch { /* Capture will be blocked before transfer unless the operation can be saved. */ }
  });

  function chooseFiles(incoming: FileList | null) {
    if (busy || !incoming?.length) return;
    files = [...files, ...Array.from(incoming)];
    error = '';
    if (!operationId) receipt = null;
  }
  function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    chooseFiles(input.files);
    input.value = '';
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    chooseFiles(event.dataTransfer?.files ?? null);
  }
  function move(index: number, offset: number) {
    const next = [...files];
    const current = next.at(index);
    const neighbor = next.at(index + offset);
    if (!current || !neighbor) return;
    next[index] = neighbor;
    next[index + offset] = current;
    files = next;
  }
  function addClaim() {
    error = '';
    const candidate = {
      field: claimField.trim(), state: claimState,
      ...(claimState === 'known' ? { value: claimValue } : {}),
      source: { kind: claimSourceKind.trim(), ...(claimSourceDetail.trim() ? { detail: claimSourceDetail.trim() } : {}) },
    };
    const parsed = claimInput.safeParse(candidate);
    if (!parsed.success) { error = 'Supply a claim field and source; known facts also need a value.'; return; }
    if (claims.some(claim => claim.field === parsed.data.field)) { error = 'A field can have only one initial claim.'; return; }
    if (claimState === 'known' && !claimValue.trim()) { error = 'Enter the known value, or record it as unknown or absent.'; return; }
    claims = [...claims, parsed.data];
    claimField = ''; claimValue = ''; claimSourceKind = ''; claimSourceDetail = '';
  }
  function addInput() {
    error = '';
    const parsed = exactInput.safeParse({
      artifactId: inputArtifactId.trim(),
      ...(inputRole.trim() ? { role: inputRole.trim() } : {}),
      ...(inputClipId.trim() ? { clipId: inputClipId.trim() } : {}),
      ...(inputPlaybackRevisionId.trim() ? { playbackRevisionId: inputPlaybackRevisionId.trim() } : {}),
    });
    if (!parsed.success) {
      error = 'Enter an actual input artifact UUID. For playback inputs, supply both clip UUID and pinned playback revision UUID.';
      return;
    }
    inputs = [...inputs, parsed.data];
    inputArtifactId = ''; inputRole = ''; inputClipId = ''; inputPlaybackRevisionId = '';
  }
  function addGap() {
    error = '';
    const parsed = lineageGapInput.safeParse({
      kind: 'upstream', description: gapDescription.trim(), sourceKind: gapSourceKind.trim(),
      ...(gapArtifactId.trim() ? { inputArtifactId: gapArtifactId.trim() } : {}),
    });
    if (!parsed.success) {
      error = 'Describe the missing upstream input and its source kind; any linked input artifact must have a valid UUID.';
      return;
    }
    gaps = [...gaps, parsed.data];
    gapArtifactId = ''; gapDescription = ''; gapSourceKind = '';
  }
  function describe(cause: unknown): string {
    return cause instanceof Error ? cause.message : 'Capture could not be completed. Check the receipt before another attempt.';
  }
  function storeOperation(metadata: CaptureMetadata | null): boolean {
    try {
      if (metadata) sessionStorage.setItem(storageKey, JSON.stringify({ operationId: metadata.operationId, metadata }));
      else sessionStorage.removeItem(storageKey);
    } catch {
      error = 'Browser session storage is unavailable. The operation ID and original metadata must be saved before sending or clearing a capture.';
      return false;
    }
    operationId = metadata?.operationId ?? null;
    pendingMetadata = metadata;
    return true;
  }
  function committed(result: CaptureReceipt, metadata: CaptureMetadata) {
    receipt = result;
    message = `Capture committed: artifact ${result.status === 'committed' ? result.artifactId : ''}.`;
    error = '';
    files = [];
    onCommitted(result, metadata);
  }
  async function fetchReceipt(id: string): Promise<CaptureReceipt> {
    const raw = await api.get<CaptureReceipt>(`/api/captures/operations/${id}`);
    const parsed = captureReceiptSchema.safeParse(raw);
    if (!parsed.success || parsed.data.operationId !== id) {
      throw new Error('The service returned an invalid receipt. Do not resend files.');
    }
    return parsed.data;
  }
  async function checkReceipt() {
    if (!operationId || busy) return;
    busy = true; error = ''; message = '';
    try {
      receipt = await fetchReceipt(operationId);
      if (receipt.status === 'committed' && pendingMetadata?.operationId === receipt.operationId) {
        committed(receipt, pendingMetadata);
      } else if (receipt.status === 'absent') {
        message = pendingMetadata
          ? 'No receipt for this operation. You may deliberately resend the matching original files and metadata with the same operation ID.'
          : 'No receipt for this operation. The original metadata is not saved here; you may explicitly start a new operation.';
      } else if (receipt.status === 'orphan') {
        message = pendingMetadata
          ? 'Verified published orphan. Reselect the exact original files and explicitly replay this operation to complete its registration.'
          : 'Published orphan, but its original metadata is unavailable here. Keep this operation ID for recovery; do not send altered context.';
      } else if (receipt.status === 'committed') message = `This operation committed artifact ${receipt.artifactId}. Do not upload it again.`;
      else message = `Operation ${receipt.status}. Keep this operation ID; do not upload again while its status is unresolved.`;
    } catch (cause) {
      error = `${describe(cause)} Keep this operation ID and check again before resending.`;
    } finally { busy = false; }
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || operationId || !files.length || selectedError) return;
    if (!name.trim()) { error = 'Give the captured artwork a name.'; return; }
    busy = true; error = ''; message = '';
    const id = crypto.randomUUID();
    const selectedFiles = [...files];
    try {
      const metadata = await buildCaptureManifest(selectedFiles, {
        operationId: id, projectId, assetId, kind, name: name.trim(),
        ...(notes ? { notes } : {}),
        ...(chosenSlot ? { slotId: chosenSlot } : {}),
        ...(requestId && associateRequest ? { requestId } : {}),
        ...(claims.length ? { claims } : {}),
        ...(inputs.length ? { inputs } : {}),
        ...(gaps.length ? { gaps } : {}),
      });
      if (!storeOperation(metadata)) return;
      receipt = null; // An interrupted transfer is not a committed artifact.
      const raw = await api.upload(metadata, selectedFiles);
      const parsed = captureReceiptSchema.safeParse(raw);
      if (!parsed.success || parsed.data.operationId !== id) throw new Error('The service did not return a valid receipt. Check this operation before resending.');
      if (parsed.data.status === 'committed') committed(parsed.data, metadata);
      else {
        receipt = parsed.data;
        message = `Capture is ${parsed.data.status}; no artwork was reported as committed. Check the operation receipt before another attempt.`;
      }
    } catch (cause) {
      error = describe(cause);
      if (operationId) error += ' Check the original operation receipt before trying again.';
      if (/no longer readable|changed while hashing/u.test(error)) {
        files = [];
        error += ' Files must be reselected.';
      }
    } finally { busy = false; }
  }
  async function replay() {
    if (busy || !canReplay || !pendingMetadata || !operationId || !files.length || selectedError) return;
    const id = operationId;
    const metadata = pendingMetadata;
    const selectedFiles = [...files];
    busy = true; error = ''; message = '';
    try {
      const current = await fetchReceipt(id);
      receipt = current;
      if (current.status === 'committed') { committed(current, metadata); return; }
      if (current.status !== 'orphan' && current.status !== 'absent') {
        message = `Operation ${current.status}. Keep this operation ID; no files were sent.`;
        return;
      }
      await verifyCaptureReplay(selectedFiles, metadata);
      const raw = await api.upload(metadata, selectedFiles);
      const parsed = captureReceiptSchema.safeParse(raw);
      if (!parsed.success || parsed.data.operationId !== id) throw new Error('The service did not return a valid receipt. Check this operation before resending.');
      if (parsed.data.status === 'committed') committed(parsed.data, metadata);
      else {
        receipt = parsed.data;
        message = `Capture is ${parsed.data.status}; no artwork was reported as committed. Check the operation receipt before another attempt.`;
      }
    } catch (cause) {
      error = `${describe(cause)} Keep this operation ID and check its receipt before another attempt.`;
      if (/no longer readable|changed while hashing/u.test(error)) {
        files = [];
        error += ' Files must be reselected.';
      }
    } finally { busy = false; }
  }
  function startNew() {
    if (busy || (operationId && receipt?.status !== 'committed' && receipt?.status !== 'absent')) return;
    if (!storeOperation(null)) return;
    receipt = null; message = ''; error = '';
  }
</script>

<section class="capture" aria-labelledby="capture-title">
  <header><p class="eyebrow">PRESERVE ORIGINALS</p><h2 id="capture-title">Capture artwork</h2><p>Selected bytes are hashed and stored by the paired local service. Capturing does not review or select a candidate.</p></header>
  {#if operationId}
    <aside class="operation" aria-label="Capture operation">
      <strong>Operation to check</strong><code>{operationId}</code>
      <button type="button" onclick={checkReceipt} disabled={busy}>Check receipt</button>
      {#if receipt?.status === 'committed'}
        <p><strong>Capture committed.</strong> Artifact <code>{receipt.artifactId}</code>. Checking the receipt never sends files.</p>
        <a href={navigationHref({
          projectId, assetId, artifactId: receipt.artifactId,
          ...(pendingMetadata?.slotId ? { slotId: pendingMetadata.slotId } : {}),
        })}>Open committed artwork</a>
      {:else if receipt?.status === 'orphan'}
        <p><strong>Published orphan verified.</strong> The service preserved these bytes but has not registered the artwork.
          {pendingMetadata ? 'Reselect the exact original files and explicitly replay this operation below.' : 'The original metadata is not available in this browser session. Keep this ID for recovery; do not send changed context.'}</p>
      {:else if receipt?.status === 'in-progress' || receipt?.status === 'unavailable'}
        <p>Do not resend while this operation is {receipt.status}. Keep its ID for recovery.</p>
      {/if}
      {#if pendingMetadata}
        <details><summary>Review saved original operation context and ordered file hashes</summary>
          <pre>{JSON.stringify(pendingMetadata, null, 2)}</pre></details>
      {/if}
      {#if receipt?.status === 'absent' || receipt?.status === 'committed'}<button type="button" onclick={startNew} disabled={busy}>Start a new operation</button>{/if}
    </aside>
  {/if}
  <form onsubmit={submit}>
    {#if operationId}<p class="notice">The fields below are a separate draft. They cannot change the saved operation; replay uses only its original context and matching reselected files. Start a new operation explicitly to capture edited details.</p>{/if}
    <div class="row">
      <label>Artwork name <input bind:value={name} maxlength="200" required placeholder="Name this capture" /></label>
      <label>Input type <select bind:value={kind}><option value="png">PNG still</option><option value="png-spritesheet">PNG spritesheet (regular grid)</option><option value="irregular-atlas">PNG irregular atlas (still only)</option><option value="gif">GIF</option><option value="png-sequence">Ordered PNG frames</option><option value="opaque">Other original file</option></select></label>
    </div>
    <label>Notes (optional) <textarea bind:value={notes} maxlength="16384" rows="2" placeholder="What should you remember about this capture?"></textarea></label>
    <div class="row">
      <label>Candidate slot (optional) <select bind:value={chosenSlot}><option value="">Leave unslotted</option>{#each slots.filter(slot => slot.assetId === assetId) as slot (slot.id)}<option value={slot.id}>{slot.name}</option>{/each}</select></label>
      {#if requestId}<label class="inline"><input type="checkbox" bind:checked={associateRequest} /> Associate this capture with request {requestId}</label>{/if}
    </div>
    <div class="file-area" ondragover={(event) => event.preventDefault()} ondrop={drop} role="group" aria-label="Capture files">
      <label>Choose originals or drop them here <input type="file" multiple disabled={busy} accept={selectedKind === 'opaque' ? undefined : selectedKind === 'gif' ? '.gif,image/gif' : '.png,image/png'} onchange={pick} /></label>
      <small>For sequences, add every frame and move rows to set the exact stored order. Up to 128 files; 32 MiB each; 128 MiB total.</small>
    </div>
    {#if files.length}
      <ol class="files" aria-label="Ordered capture files">
        {#each files as file, index (index)}
          <li><span><b>{index + 1}.</b> {file.name} <small>({file.size.toLocaleString()} bytes)</small></span><span class="actions"><button type="button" onclick={() => move(index, -1)} disabled={busy || index === 0} aria-label={`Move ${file.name} up`}>↑</button><button type="button" onclick={() => move(index, 1)} disabled={busy || index === files.length - 1} aria-label={`Move ${file.name} down`}>↓</button><button type="button" onclick={() => { files = files.filter((_, position) => position !== index); }} disabled={busy} aria-label={`Remove ${file.name}`}>Remove</button></span></li>
        {/each}
      </ol>
      {#if selectedError}<p class="problem" role="alert">{selectedError}</p>{/if}
    {/if}
    {#if canReplay}
      <button class="primary" type="button" onclick={replay} disabled={busy || !files.length || !!selectedError}>
        {busy ? 'Checking operation…' : receipt?.status === 'orphan' ? 'Replay this published orphan' : 'Resend this absent operation'}
      </button>
      <p>Only this click can send files. Before upload, the receipt is checked again and every reselected file is hashed and compared in order with the saved original metadata.</p>
    {/if}
    <fieldset>
      <legend>Sourced production facts (optional)</legend>
      <p>Only record what you know from an identified source. Leaving a field unrecorded does not assert that it is unknown or absent.</p>
      {#if claims.length}<ul class="claims">{#each claims as claim, index}<li>{claim.field}: {claim.state}{claim.state === 'known' ? ` — ${String(claim.value)}` : ''} · source: {claim.source.kind} <button type="button" onclick={() => { claims = claims.filter((_, position) => position !== index); }}>Remove</button></li>{/each}</ul>{/if}
      <div class="row"><label>Field <input list="production-fields" bind:value={claimField} maxlength="200" placeholder="e.g. model or prompt" /></label><datalist id="production-fields">{#each productionFields as field}<option value={field}></option>{/each}</datalist><label>State <select bind:value={claimState}><option value="known">Known</option><option value="unknown">Explicitly unknown</option><option value="absent">Explicitly absent</option></select></label></div>
      {#if claimState === 'known'}<label>Known value <textarea bind:value={claimValue} rows="2" placeholder="Exact value you can source"></textarea></label>{/if}
      <div class="row"><label>Source kind <input bind:value={claimSourceKind} maxlength="200" placeholder="e.g. artist notes" /></label><label>Source detail (optional) <input bind:value={claimSourceDetail} maxlength="16384" /></label></div>
      <button type="button" onclick={addClaim} disabled={busy || claims.length >= 128}>Add sourced fact</button>
    </fieldset>
    <fieldset>
      <legend>Actual input artifacts (optional)</legend>
      <p>Add only specific artifacts used to create this artwork. These become recorded lineage, not proposed request inputs. Playback references must pin both the clip and its revision.</p>
      {#if inputs.length}<ol class="claims">{#each inputs as input, index}<li>Artifact <code>{input.artifactId}</code>{input.role ? ` · ${input.role}` : ''}{input.clipId ? ` · clip ${input.clipId}, revision ${input.playbackRevisionId}` : ''} <button type="button" disabled={busy} onclick={() => { inputs = inputs.filter((_, position) => position !== index); }}>Remove</button></li>{/each}</ol>{/if}
      <div class="row"><label>Input artifact UUID <input bind:value={inputArtifactId} placeholder="Existing artifact ID" /></label><label>Role (optional) <input bind:value={inputRole} maxlength="200" placeholder="e.g. reference, source" /></label></div>
      <div class="row"><label>Input clip UUID (optional) <input bind:value={inputClipId} placeholder="Known clip ID" /></label><label>Pinned playback revision UUID (required with clip) <input bind:value={inputPlaybackRevisionId} placeholder="Immutable revision ID" /></label></div>
      <button type="button" onclick={addInput} disabled={busy || inputs.length >= 128}>Add actual input</button>
    </fieldset>
    <fieldset>
      <legend>Known upstream gap (optional)</legend>
      <p>Record a missing or unidentifiable source only when you can describe the gap. This does not claim an exact input.</p>
      {#if gaps.length}<ol class="claims">{#each gaps as gap, index}<li>{gap.description} · source: {gap.sourceKind} <button type="button" disabled={busy} onclick={() => { gaps = gaps.filter((_, position) => position !== index); }}>Remove</button></li>{/each}</ol>{/if}
      <div class="row"><label>Missing input description <textarea bind:value={gapDescription} maxlength="16384" rows="2"></textarea></label><label>Source kind <input bind:value={gapSourceKind} maxlength="200" placeholder="e.g. artist account" /></label></div>
      <label>Related input artifact UUID (optional) <input bind:value={gapArtifactId} placeholder="Only if an artifact is known" /></label>
      <button type="button" onclick={addGap} disabled={busy || gaps.length >= 128}>Add upstream gap</button>
    </fieldset>
    {#if error}<p class="problem" role="alert">{error}</p>{/if}
    {#if message}<p class="notice" role="status">{message}</p>{/if}
    <button class="primary" type="submit" disabled={busy || !!operationId || !files.length || !!selectedError}>{busy ? 'Working…' : 'Capture selected originals'}</button>
  </form>
</section>

<style>
  .capture { min-width: 0; color: var(--text, #edf1e9); background: var(--surface, #19262a); border: 1px solid var(--line, #465555); border-radius: 9px; padding: clamp(18px, 3vw, 32px); }
  header { margin-bottom: 22px; } h2 { font-family: Georgia, serif; font-size: clamp(26px, 3vw, 38px); font-weight: 400; margin: 4px 0 8px; } p { line-height: 1.5; color: var(--muted, #b9c5c1); margin: 7px 0; }
  .eyebrow { color: var(--accent, #edbd78); font-size: 11px; font-weight: 700; letter-spacing: .13em; }
  form, fieldset { display: grid; gap: 16px; } fieldset { border: 1px solid var(--line, #465555); padding: 16px; min-width: 0; } legend { padding: 0 6px; font-weight: 700; } .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: end; }
  label { display: grid; gap: 6px; min-width: 0; font-size: 13px; font-weight: 650; } label.inline { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; } label.inline input { width: auto; }
  input, select, textarea { font: inherit; box-sizing: border-box; width: 100%; min-width: 0; padding: 10px; color: var(--text, #edf1e9); background: var(--canvas, #111b20); border: 1px solid var(--control-line, #576765); border-radius: 4px; }
  input[type="file"] { padding: 10px 0; border: 0; background: transparent; } textarea { resize: vertical; } :is(button, input, select, textarea):focus-visible { outline: 2px solid var(--accent, #edbd78); outline-offset: 2px; }
  button { font: inherit; cursor: pointer; color: var(--text, #edf1e9); background: transparent; border: 1px solid var(--control-line, #576765); border-radius: 4px; padding: 8px 12px; } button:disabled { opacity: .52; cursor: not-allowed; } button.primary { background: var(--accent-fill, #edbd78); color: var(--accent-ink, #162321); border-color: var(--accent-fill, #edbd78); justify-self: start; font-weight: 700; }
  .file-area { border: 1px dashed var(--control-line, #576765); border-radius: 5px; padding: 16px; } small { color: var(--muted, #b9c5c1); } .file-area small { display: block; line-height: 1.5; }
  .files, .claims { padding: 0; margin: 0; list-style: none; display: grid; gap: 6px; }   .files li, .claims li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; border: 1px solid var(--line, #465555); padding: 7px 10px; overflow-wrap: anywhere; } .actions { display: flex; flex-wrap: wrap; gap: 4px; }
  .operation { border: 1px solid var(--accent, #edbd78); padding: 14px; margin-bottom: 20px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; } .operation code { overflow-wrap: anywhere; } .operation p, .operation details { width: 100%; } .operation pre { overflow: auto; max-height: 320px; padding: 10px; background: var(--canvas, #111b20); white-space: pre-wrap; overflow-wrap: anywhere; } .operation summary { cursor: pointer; } .operation a { color: var(--accent, #edbd78); text-underline-offset: 3px; } .operation a:focus-visible { outline: 2px solid var(--focus, #edbd78); outline-offset: 2px; } .problem { color: var(--text, #edf1e9); border-left: 3px solid #b95e4a; padding-left: 10px; } .notice { color: var(--text, #edf1e9); border-left: 3px solid var(--accent, #edbd78); padding-left: 10px; }
  @media (max-width: 620px) { .row { grid-template-columns: minmax(0, 1fr); } .capture { padding: 17px; } .actions button { min-height: 40px; } }
</style>
