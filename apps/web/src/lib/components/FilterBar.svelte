<script lang="ts">
  import type { ProjectRecord, AssetRecord, SlotRecord } from '@assetweave/contracts/catalog';
  import type { SearchInput } from '@assetweave/contracts/queries';

  type Filters = SearchInput['filters'];
  let { filters, text, scope, currentSlotId, projects, assets, slots, onApply }:
    { filters: Filters; text: string; scope: 'current' | 'history'; currentSlotId?: string;
      projects: ProjectRecord[]; assets: AssetRecord[]; slots: SlotRecord[];
      onApply: (filters: Filters, text: string, scope: 'current' | 'history') => void } = $props();
  let project = $state(''); let asset = $state(''); let placement = $state('');
  let stage = $state(''); let stageNone = $state(false); let kind = $state('');
  let review = $state(''); let selection = $state(''); let producer = $state('');
  let capturedFrom = $state(''); let capturedThrough = $state('');
  let producedFrom = $state(''); let producedThrough = $state(''); let productionUnknown = $state(false);
  let ancestorOf = $state(''); let descendantOf = $state(''); let searchText = $state('');
  let searchScope = $state<'current' | 'history'>('current'); let formError = $state('');
  let expanded = $state(false);
  const ids = (value: string) => value ? [value] : undefined;
  const day = (value: string, end: boolean) => value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : undefined;
  const dateInput = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  $effect(() => {
    if (filters.projectIds?.length || filters.assetIds?.length || filters.stages?.length || filters.stageNone ||
        filters.kinds?.length || filters.reviews?.length || filters.selection?.length || filters.producers?.length ||
        filters.captured || filters.produced || filters.unknownProductionDate ||
        filters.ancestorOf?.length || filters.descendantOf?.length) expanded = true;
    project = filters.projectIds?.[0] ?? '';
    asset = filters.assetIds?.[0] ?? '';
    placement = currentSlotId ?? (filters.unslotted ? 'unslotted' : filters.slotIds?.[0] ?? '');
    stage = filters.stages?.[0] ?? ''; stageNone = filters.stageNone ?? false;
    kind = filters.kinds?.[0] ?? ''; review = filters.reviews?.[0] ?? '';
    selection = filters.selection?.[0] ?? ''; producer = filters.producers?.[0] ?? '';
    capturedFrom = dateInput(filters.captured?.from); capturedThrough = dateInput(filters.captured?.through);
    producedFrom = dateInput(filters.produced?.from); producedThrough = dateInput(filters.produced?.through);
    productionUnknown = filters.unknownProductionDate ?? false;
    ancestorOf = filters.ancestorOf?.[0] ?? ''; descendantOf = filters.descendantOf?.[0] ?? '';
    searchText = text; searchScope = scope;
  });
  function submit(event: SubmitEvent) {
    event.preventDefault();
    formError = '';
    if (searchScope === 'history' && !searchText.trim()) { formError = 'Historical search requires text.'; return; }
    if ((capturedFrom && capturedThrough && capturedFrom > capturedThrough) ||
        (producedFrom && producedThrough && producedFrom > producedThrough)) {
      formError = 'A date range must end on or after its start.'; return;
    }
    const captured = { from: day(capturedFrom, false), through: day(capturedThrough, true) };
    const produced = { from: day(producedFrom, false), through: day(producedThrough, true) };
    const next: Filters = {
      ...(ids(project) ? { projectIds: ids(project) } : {}),
      ...(ids(asset) ? { assetIds: ids(asset) } : {}),
      ...(placement && placement !== 'unslotted' ? { slotIds: ids(placement) } : {}),
      ...(placement === 'unslotted' ? { unslotted: true } : {}),
      ...(stage.trim() ? { stages: [stage.trim()] } : {}), ...(stageNone ? { stageNone: true } : {}),
      ...(kind.trim() ? { kinds: [kind.trim()] } : {}),
      ...(review ? { reviews: [review as NonNullable<Filters['reviews']>[number]] } : {}),
      ...(selection ? { selection: [selection as NonNullable<Filters['selection']>[number]] } : {}),
      ...(producer.trim() ? { producers: [producer.trim()] } : {}),
      ...(captured.from || captured.through ? { captured } : {}),
      ...(produced.from || produced.through ? { produced } : {}),
      ...(productionUnknown ? { unknownProductionDate: true } : {}),
      ...(ancestorOf.trim() ? { ancestorOf: [ancestorOf.trim()] } : {}),
      ...(descendantOf.trim() ? { descendantOf: [descendantOf.trim()] } : {}),
    };
    onApply(next, searchText.trim(), searchScope);
  }
</script>

<form class="filters" onsubmit={submit} aria-label="Find artwork">
  <div class="filter-primary">
    <label>Search recorded text<input type="search" placeholder="Names, notes, prompts…" maxlength="1000" bind:value={searchText} /></label>
    <label>Text scope<select bind:value={searchScope}><option value="current">Current records</option><option value="history">Current and history</option></select></label>
    <label>Placement<select bind:value={placement}><option value="">All placements</option><option value="unslotted">Unslotted artwork</option>{#each slots as slot (slot.id)}<option value={slot.id}>{slot.name}</option>{/each}</select></label>
    <button class="primary" type="submit">Find artwork</button>
    <button type="button" class="quiet" aria-expanded={expanded} onclick={() => expanded = !expanded}>{expanded ? 'Fewer filters' : 'More filters'}</button>
  </div>
  {#if expanded}
    <div class="filter-extra">
      <label>Captured project<select bind:value={project}><option value="">Any project</option>{#each projects as item (item.id)}<option value={item.id}>{item.name}</option>{/each}</select></label>
      <label>Captured asset<select bind:value={asset}><option value="">Any asset</option>{#each assets as item (item.id)}<option value={item.id}>{item.name} · {projects.find(p => p.id === item.projectId)?.name ?? 'Project not loaded'}</option>{/each}</select></label>
      <label>Human stage<input list="stage-options" placeholder="Any stage" maxlength="200" bind:value={stage} /><datalist id="stage-options">{#each [...new Set(assets.map(item => item.stage).filter((value): value is string => value !== null))] as value}<option value={value}></option>{/each}</datalist></label>
      <label class="checkbox"><input type="checkbox" bind:checked={stageNone} /> Include only assets with no stage when no named stage is entered</label>
      <label>Artifact kind<input list="kind-options" placeholder="Any kind" maxlength="200" bind:value={kind} /><datalist id="kind-options"><option value="png"></option><option value="png-spritesheet"></option><option value="png-sequence"></option><option value="gif"></option></datalist></label>
      <label>Review state<select bind:value={review}><option value="">All, including rejected</option><option value="unreviewed">Unreviewed</option><option value="reviewed-undecided">Reviewed · undecided</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
      <label>Slot selection<select bind:value={selection}><option value="">Any selection</option><option value="selected">Currently selected</option><option value="not-selected">Not selected (including unslotted)</option><option value="formerly-selected">Formerly selected</option></select></label>
      <label>Recorded producer<input maxlength="200" placeholder="Exact known producer" bind:value={producer} /></label>
      <label>Captured from<input type="date" bind:value={capturedFrom} /></label><label>Captured through<input type="date" bind:value={capturedThrough} /></label>
      <label>Produced from<input type="date" bind:value={producedFrom} /></label><label>Produced through<input type="date" bind:value={producedThrough} /></label>
      <label class="checkbox"><input type="checkbox" bind:checked={productionUnknown} /> Include unknown production date</label>
      <label>Ancestor of artifact ID<input type="text" placeholder="Artifact UUID" pattern="[0-9a-fA-F-]{36}" bind:value={ancestorOf} /></label>
      <label>Descendant of artifact ID<input type="text" placeholder="Artifact UUID" pattern="[0-9a-fA-F-]{36}" bind:value={descendantOf} /></label>
      <p class="muted filter-explanation">Production date is a recorded claim, not capture time. Stage, producer and lineage filters use recorded facts only. Project and asset here describe captured ownership, not the slot holding a candidate.</p>
    </div>
  {/if}
  {#if formError}<p role="alert" class="error">{formError}</p>{/if}
</form>

<style>
  .filters { margin: 18px 0; }
  .filter-primary,.filter-extra { display:flex; flex-wrap:wrap; align-items:end; gap:10px; }
  .filter-primary label { flex:1 1 160px; }
  .filter-primary label:first-child { flex:2 1 210px; }
  .filter-extra { margin-top:12px; padding:14px; background:var(--surface); border-radius:8px; }
  .filter-extra label { flex:1 1 185px; }
  .filter-extra .checkbox { display:flex; align-items:center; gap:8px; flex-basis:200px; min-height:38px; font-size:12px; text-transform:none; letter-spacing:0; }
  .checkbox input { flex:none; }
  .filter-explanation { width:100%; margin:4px 0 0; font-size:12px; }
  @media(max-width:620px) { .filter-primary label { flex-basis:calc(50% - 8px); } .filter-primary label:first-child { flex-basis:100%; } }
</style>