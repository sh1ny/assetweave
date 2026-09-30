<script lang="ts">
  import type { AssetRecord, ProjectRecord } from '@assetweave/contracts/catalog';
  import { ApiClientError, type ApiClient } from '../../lib/api/client';

  let {
    api,
    assets,
    project,
    selectedAssetId,
    hasMore,
    loading,
    onSelect,
    onLoadMore,
    onRefresh,
    onChanged
  }: {
    api: ApiClient;
    assets: AssetRecord[];
    project: ProjectRecord | null;
    selectedAssetId?: string;
    hasMore: boolean;
    loading: boolean;
    onSelect: (id: string) => void;
    onLoadMore: () => void;
    onRefresh: () => void;
    onChanged: (record: AssetRecord) => void;
  } = $props();

  let selected = $derived(assets.find((item) => item.id === selectedAssetId));
  let newName = $state('');
  let newNotes = $state('');
  let creating = $state(false);
  let createError = $state('');
  let editingId = $state<string | null>(null);
  let editName = $state('');
  let editNotes = $state('');
  let editRevision = $state(0);
  let saving = $state(false);
  let editError = $state('');

  async function createAsset(event: SubmitEvent) {
    event.preventDefault();
    if (!project || creating || !newName.trim()) return;
    creating = true;
    createError = '';
    let record: AssetRecord;
    try {
      record = await api.mutate<AssetRecord>(`/api/projects/${project.id}/assets`, 'POST', {
        name: newName.trim(), notes: newNotes
      });
    } catch {
      createError = 'Could not create the asset. Your entries are still here; please try again.';
      return;
    } finally {
      creating = false;
    }
    newName = '';
    newNotes = '';
    onChanged(record);
  }

  function startEditing(record: AssetRecord) {
    editingId = record.id;
    editRevision = record.revision;
    editName = record.name;
    editNotes = record.notes;
    editError = '';
  }

  async function saveAsset(event: SubmitEvent) {
    event.preventDefault();
    if (!selected || selected.id !== editingId || saving || !editName.trim()) return;
    saving = true;
    editError = '';
    let record: AssetRecord;
    try {
      record = await api.mutate<AssetRecord>(`/api/assets/${selected.id}`, 'PATCH', {
        expectedRevision: editRevision, name: editName.trim(), notes: editNotes
      });
    } catch (error) {
      editError = error instanceof ApiClientError && error.status === 409
        ? 'This asset changed elsewhere. Your draft is still here. Refresh, review the current details, then use the latest revision to retry.'
        : 'Could not save the asset. Your draft is still here; please try again.';
      return;
    } finally {
      saving = false;
    }
    editingId = null;
    onChanged(record);
  }
</script>

<section class="browser" aria-label="Assets">
  <div class="heading">
    <h2>Assets</h2>
    <button type="button" class="quiet-button" onclick={onRefresh} disabled={loading}>Refresh assets</button>
  </div>
  {#if project}<p class="hint context">Project: {project.name}</p>{/if}
  {#if loading}<p class="hint" role="status">Loading assets…</p>{/if}
  {#if assets.length}
    <nav aria-label="Asset list">
      <ul>
        {#each assets as item (item.id)}
          <li>
            <button type="button" class="nav-item" aria-current={selectedAssetId === item.id ? 'true' : undefined} onclick={() => onSelect(item.id)}>
              <span class="name">{item.name}</span>
              <span class="meta">Project: {project?.id === item.projectId ? project.name : item.projectId}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  {:else if !loading}
    <p class="hint">{project ? 'No assets in this project yet. Create one below.' : 'Select a project to browse its assets.'}</p>
  {/if}
  {#if hasMore}
    <button type="button" class="quiet-button more" onclick={onLoadMore} disabled={loading}>{loading ? 'Loading more…' : 'Load more assets'}</button>
  {/if}

  {#if selected}
    <details class="details">
      <summary>Asset details and notes: {selected.name}</summary>
      <p class="hint">Project: {project?.id === selected.projectId ? project.name : selected.projectId}</p>
      <p class="notes">{selected.notes || 'No notes yet.'}</p>
      <p class="hint">Revision {selected.revision}</p>
      {#if editingId === selected.id}
        <form onsubmit={saveAsset}>
          <label for="asset-edit-name">Asset name</label>
          <input id="asset-edit-name" bind:value={editName} maxlength="200" required disabled={saving} />
          <label for="asset-edit-notes">Asset notes (optional)</label>
          <textarea id="asset-edit-notes" bind:value={editNotes} maxlength="16384" rows="3" disabled={saving}></textarea>
          {#if editRevision !== selected.revision}
            <p class="hint">A newer revision is displayed above. Review it before using the latest revision with your draft.</p>
            <button type="button" class="quiet-button" onclick={() => { editRevision = selected.revision; editError = ''; }} disabled={saving}>Use latest revision</button>
          {/if}
          {#if editError}<p role="alert" class="error">{editError}</p>{/if}
          <div class="actions">
            <button type="submit" class="primary-button" disabled={saving || !editName.trim() || editRevision !== selected.revision}>{saving ? 'Saving…' : 'Save asset'}</button>
            <button type="button" class="quiet-button" onclick={() => { editingId = null; editError = ''; }} disabled={saving}>Cancel</button>
          </div>
        </form>
      {:else}
        <button type="button" class="quiet-button" onclick={() => startEditing(selected)}>Edit name and notes</button>
      {/if}
    </details>
  {/if}

  {#if project}
    <details class="details create">
      <summary>Create asset in {project.name}</summary>
      <form onsubmit={createAsset}>
        <label for="asset-new-name">Asset name</label>
        <input id="asset-new-name" bind:value={newName} maxlength="200" required disabled={creating} />
        <label for="asset-new-notes">Asset notes (optional)</label>
        <textarea id="asset-new-notes" bind:value={newNotes} maxlength="16384" rows="3" disabled={creating}></textarea>
        {#if createError}<p role="alert" class="error">{createError}</p>{/if}
        <button type="submit" class="primary-button" disabled={creating || !newName.trim()}>{creating ? 'Creating…' : 'Create asset'}</button>
      </form>
    </details>
  {/if}
</section>

<style>
  .browser { min-width: 0; color: var(--text); }
  .heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
  ul { list-style: none; margin: .65rem 0 0; padding: 0; display: grid; gap: .2rem; }
  li { min-width: 0; }
  .browser .nav-item { display: grid; gap: .1rem; min-width: 0; justify-items: start; }
  .name { overflow-wrap: anywhere; }
  .meta, .hint { color: var(--muted); font-size: 12px; }
  .meta { overflow-wrap: anywhere; font-weight: 400; }
  .hint { margin: .65rem 0; }
  .context { overflow-wrap: anywhere; }
  .more { margin-top: .5rem; width: 100%; }
  .details { margin-top: .9rem; border-top: 1px solid var(--line); padding-top: .75rem; }
  summary { cursor: pointer; font-weight: 600; overflow-wrap: anywhere; }
  .notes { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; font-size: 13px; }
  form { display: grid; gap: .4rem; margin-top: .85rem; }
  input, textarea { width: 100%; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .error { color: var(--status-rejected-ink); font-size: 13px; margin: .25rem 0; }
</style>
