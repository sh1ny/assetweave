<script lang="ts">
  import type { ProjectRecord } from '@assetweave/contracts/catalog';
  import { ApiClientError, type ApiClient } from '../../lib/api/client';

  let {
    api,
    projects,
    selectedProjectId,
    hasMore,
    loading,
    onSelect,
    onLoadMore,
    onRefresh,
    onChanged
  }: {
    api: ApiClient;
    projects: ProjectRecord[];
    selectedProjectId?: string;
    hasMore: boolean;
    loading: boolean;
    onSelect: (id: string) => void;
    onLoadMore: () => void;
    onRefresh: () => void;
    onChanged: (record: ProjectRecord) => void;
  } = $props();

  let selected = $derived(projects.find((item) => item.id === selectedProjectId));
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

  async function createProject(event: SubmitEvent) {
    event.preventDefault();
    if (creating || !newName.trim()) return;
    creating = true;
    createError = '';
    let record: ProjectRecord;
    try {
      record = await api.mutate<ProjectRecord>('/api/projects', 'POST', {
        name: newName.trim(), notes: newNotes
      });
    } catch {
      createError = 'Could not create the project. Your entries are still here; please try again.';
      return;
    } finally {
      creating = false;
    }
    newName = '';
    newNotes = '';
    onChanged(record);
  }

  function startEditing(record: ProjectRecord) {
    editingId = record.id;
    editRevision = record.revision;
    editName = record.name;
    editNotes = record.notes;
    editError = '';
  }

  async function saveProject(event: SubmitEvent) {
    event.preventDefault();
    if (!selected || selected.id !== editingId || saving || !editName.trim()) return;
    saving = true;
    editError = '';
    let record: ProjectRecord;
    try {
      record = await api.mutate<ProjectRecord>(`/api/projects/${selected.id}`, 'PATCH', {
        expectedRevision: editRevision, name: editName.trim(), notes: editNotes
      });
    } catch (error) {
      editError = error instanceof ApiClientError && error.status === 409
        ? 'This project changed elsewhere. Your draft is still here. Refresh, review the current details, then use the latest revision to retry.'
        : 'Could not save the project. Your draft is still here; please try again.';
      return;
    } finally {
      saving = false;
    }
    editingId = null;
    onChanged(record);
  }
</script>

<section class="browser" aria-label="Projects">
  <div class="heading">
    <h2>Projects</h2>
    <button type="button" class="quiet-button" onclick={onRefresh} disabled={loading}>Refresh projects</button>
  </div>
  {#if loading}<p class="hint" role="status">Loading projects…</p>{/if}
  {#if projects.length}
    <nav aria-label="Project list">
      <ul>
        {#each projects as item (item.id)}
          <li>
            <button type="button" class="nav-item" aria-current={selectedProjectId === item.id ? 'true' : undefined} onclick={() => onSelect(item.id)}>
              <span class="name">{item.name}</span>
              <span class="meta">{item.notes.trim() ? 'Notes available' : 'No notes'}</span>
            </button>
          </li>
        {/each}
      </ul>
    </nav>
  {:else if !loading}
    <p class="hint">No projects yet. Create one below.</p>
  {/if}
  {#if hasMore}
    <button type="button" class="quiet-button more" onclick={onLoadMore} disabled={loading}>{loading ? 'Loading more…' : 'Load more projects'}</button>
  {/if}

  {#if selected}
    <details class="details">
      <summary>Project details and notes: {selected.name}</summary>
      <p class="notes">{selected.notes || 'No notes yet.'}</p>
      <p class="hint">Revision {selected.revision}</p>
      {#if editingId === selected.id}
        <form onsubmit={saveProject}>
          <label for="project-edit-name">Project name</label>
          <input id="project-edit-name" bind:value={editName} maxlength="200" required disabled={saving} />
          <label for="project-edit-notes">Project notes (optional)</label>
          <textarea id="project-edit-notes" bind:value={editNotes} maxlength="16384" rows="3" disabled={saving}></textarea>
          {#if editRevision !== selected.revision}
            <p class="hint">A newer revision is displayed above. Review it before using the latest revision with your draft.</p>
            <button type="button" class="quiet-button" onclick={() => { editRevision = selected.revision; editError = ''; }} disabled={saving}>Use latest revision</button>
          {/if}
          {#if editError}<p role="alert" class="error">{editError}</p>{/if}
          <div class="actions">
            <button type="submit" class="primary-button" disabled={saving || !editName.trim() || editRevision !== selected.revision}>{saving ? 'Saving…' : 'Save project'}</button>
            <button type="button" class="quiet-button" onclick={() => { editingId = null; editError = ''; }} disabled={saving}>Cancel</button>
          </div>
        </form>
      {:else}
        <button type="button" class="quiet-button" onclick={() => startEditing(selected)}>Edit name and notes</button>
      {/if}
    </details>
  {/if}

  <details class="details create">
    <summary>Create project</summary>
    <form onsubmit={createProject}>
      <label for="project-new-name">Project name</label>
      <input id="project-new-name" bind:value={newName} maxlength="200" required disabled={creating} />
      <label for="project-new-notes">Project notes (optional)</label>
      <textarea id="project-new-notes" bind:value={newNotes} maxlength="16384" rows="3" disabled={creating}></textarea>
      {#if createError}<p role="alert" class="error">{createError}</p>{/if}
      <button type="submit" class="primary-button" disabled={creating || !newName.trim()}>{creating ? 'Creating…' : 'Create project'}</button>
    </form>
  </details>
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
  .more { margin-top: .5rem; width: 100%; }
  .details { margin-top: .9rem; border-top: 1px solid var(--line); padding-top: .75rem; }
  summary { cursor: pointer; font-weight: 600; overflow-wrap: anywhere; }
  .notes { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; font-size: 13px; }
  form { display: grid; gap: .4rem; margin-top: .85rem; }
  input, textarea { width: 100%; }
  .actions { display: flex; flex-wrap: wrap; gap: .5rem; }
  .error { color: var(--status-rejected-ink); font-size: 13px; margin: .25rem 0; }
</style>
