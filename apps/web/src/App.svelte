<script lang="ts">
  import { onMount } from 'svelte';
  import type { ProjectRecord, AssetRecord, SlotRecord, CandidateRecord } from '@assetweave/contracts/catalog';
  import type { CaptureRecord, CaptureReceipt, CaptureMetadata } from '@assetweave/contracts/capture';
  import type { MediaDescription } from '@assetweave/contracts/media';
  import type { ClaimRecord, InputEdgeRecord, LineageGapRecord, RequestRecord } from '@assetweave/contracts/production';
  import type { ClipRecord } from '@assetweave/contracts/playback';
  import type { SlotSelectionDecision } from '@assetweave/contracts/decisions';
  import type { ContextResult, QueryPage, RevisionDetail, SearchHit, SearchInput, TextHit } from '@assetweave/contracts/queries';
  import { ApiClient, ApiClientError } from './lib/api/client.js';
  import { parseNavigation, patchNavigation, pushNavigation, replaceNavigation, type NavigationState } from './lib/navigation.js';
  import WorkbenchShell from './lib/components/WorkbenchShell.svelte';
  import FilterBar from './lib/components/FilterBar.svelte';
  import ProjectBrowser from './features/catalog/ProjectBrowser.svelte';
  import AssetBrowser from './features/catalog/AssetBrowser.svelte';
  import CandidateGrid from './features/catalog/CandidateGrid.svelte';
  import ReviewWorkspace from './features/review/ReviewWorkspace.svelte';
  import ArtifactInspector from './features/review/ArtifactInspector.svelte';
  import DecisionPanel from './features/review/DecisionPanel.svelte';
  import RequestPanel from './features/review/RequestPanel.svelte';
  import ClipEditor from './features/review/ClipEditor.svelte';
  import CaptureForm from './features/capture/CaptureForm.svelte';
  import type { PlacementRecord } from './features/catalog/types.js';
  import './lib/styles/tokens.css';

  type Connection = { origin: string; profile: string };
  type Session = { authenticated: true; csrfToken: string };
  interface Pages<T> { items: T[]; cursor: string | null; watermark: number | null; loading: boolean; error: string }
  const blank = <T,>(): Pages<T> => ({ items: [], cursor: null, watermark: null, loading: false, error: '' });
  const explain = (error: unknown) => error instanceof Error ? error.message : 'The local service could not load these records.';
  const stale = 'Records changed while pages were loading. Refresh this collection to begin a new query; pages were not combined.';
  const conflict = (error: unknown) => error instanceof ApiClientError && error.status === 409;
  const emptyFilters = (): SearchInput['filters'] => ({});
  let route = $state<NavigationState>(parseNavigation());
  let session = $state<Session | null>(null);
  let connection = $state<Connection | null>(null);
  let api = $state<ApiClient | null>(null);
  let pairingCode = $state(''); let busy = $state(false); let message = $state('');
  let sessionCheckGeneration = 0; let disconnecting = false;
  let projects = $state<Pages<ProjectRecord>>(blank());
  let assets = $state<Pages<AssetRecord>>(blank());
  let slots = $state<Pages<SlotRecord>>(blank());
  let results = $state<Pages<SearchHit>>(blank());
  let textResults = $state<Pages<TextHit>>(blank());
  let projectRecord = $state<ProjectRecord | null>(null);
  let assetRecord = $state<AssetRecord | null>(null);
  let slotRecord = $state<SlotRecord | null>(null);
  let requestRecord = $state<RequestRecord | null>(null);
  let placements = $state<Map<string, PlacementRecord[]>>(new Map());
  let selectedSnapshot = $state<{ slotId: string; candidateId: string | null; watermark: number } | null>(null);
  let viewedCandidate = $state<CandidateRecord | null>(null);
  let ownerProjects = $state<Map<string, string>>(new Map());
  let ownerAssets = $state<Map<string, string>>(new Map());
  let resultLoading = $state(false);
  let detail = $state<CaptureRecord | null>(null);
  let media = $state<MediaDescription | null>(null);
  let mediaError = $state('');
  let mediaLoading = $state(false);
  let claims = $state<Pages<ClaimRecord>>(blank());
  let inputs = $state<Pages<InputEdgeRecord>>(blank());
  let gaps = $state<Pages<LineageGapRecord>>(blank());
  let clips = $state<Pages<ClipRecord>>(blank());
  let displayedPlayback = $state<{ artifactId: string; clipId: string; revisionId: string } | null>(null);
  let detailLoading = $state(false); let detailError = $state('');
  let revision = $state<RevisionDetail | null>(null);
  let revisionError = $state(''); let revisionLoading = $state(false);
  let revisionHint = $state<{ id: string; type: string } | null>(null);
  let captureOpen = $state(false);
  let captureContext = $state<{ projectId: string; assetId: string; slots: SlotRecord[]; slotId?: string; requestId?: string } | null>(null);
  let successfulCapture = $state<{ receipt: CaptureReceipt; projectId: string; assetId: string; slotId?: string } | null>(null);
  let operationError = $state(''); let slotName = $state(''); let slotNotes = $state('');
  let slotDraftFor = $state<string | null>(null);
  let slotEditName = $state(''); let slotEditNotes = $state(''); let slotEditFor = $state<string | null>(null);
  let slotEditRevision = $state(0);
  let stageDraft = $state(''); let stageForAsset = $state<string | null>(null);
  let stageEditRevision = $state(0);
  let navigationGeneration = 0; let searchGeneration = 0; let detailGeneration = 0; let revisionGeneration = 0; let candidateGeneration = 0;
  let currentProject = $derived(projectRecord?.id === route.projectId ? projectRecord : projects.items.find(p => p.id === route.projectId) ?? null);
  let currentAsset = $derived(assetRecord?.id === route.assetId ? assetRecord : assets.items.find(a => a.id === route.assetId) ?? null);
  let currentSlot = $derived(slotRecord?.id === route.slotId ? slotRecord : slots.items.find(s => s.id === route.slotId) ?? null);
  let listedProjects = $derived(currentProject && !projects.items.some(item => item.id === currentProject.id)
    ? [currentProject, ...projects.items] : projects.items);
  let listedAssets = $derived(currentAsset && !assets.items.some(item => item.id === currentAsset.id)
    ? [currentAsset, ...assets.items] : assets.items);
  let listedSlots = $derived(currentSlot && !slots.items.some(item => item.id === currentSlot.id)
    ? [currentSlot, ...slots.items] : slots.items);
  let currentApi = $derived(api);
  let workbenchTitle = $derived(currentSlot?.name ?? currentAsset?.name ?? currentProject?.name ?? 'All artwork');
  let workbenchContext = $derived(currentProject?.name ? `${currentProject.name}${currentAsset?.name ? ` / ${currentAsset.name}` : ''}` : 'Local workbench');
  let selectedForView = $derived(route.slotId && selectedSnapshot?.slotId === route.slotId
    ? selectedSnapshot.candidateId : currentSlot?.selectedCandidateId);
  let selectedLoaded = $derived(!!route.slotId && (selectedSnapshot?.slotId === route.slotId || currentSlot?.id === route.slotId));
  let viewedTargetCandidate = $derived.by(() => {
    const target = viewedCandidate;
    return target && target.id === route.candidateId && target.artifactId === route.artifactId &&
      target.slotId === route.slotId && target.clipId === (route.clipId ?? null) ? target : null;
  });
  let pinnedPlaybackRevisionId = $derived(route.revisionId && (
    revision?.revisionId === route.revisionId && revision.type === 'clip' ||
    revisionHint?.id === route.revisionId && revisionHint.type === 'clip') ? route.revisionId : undefined);
  let viewedPlaybackRevisionId = $derived(!route.revisionId && displayedPlayback && detail?.id === route.artifactId &&
    displayedPlayback.artifactId === route.artifactId && displayedPlayback.clipId === route.clipId
    ? displayedPlayback.revisionId : undefined);
  let slotAlternatives = $derived([...placements.values()].flat().filter(item => item.candidate.slotId === route.slotId)
    .map(item => item.candidate));
  let candidateLabels = $derived.by(() => {
    const names = new Map(results.items.map(hit => [hit.artifactId, hit.name]));
    const clipNames = new Map(clips.items.map(clip => [clip.id, clip.name]));
    const labels = new Map<string, { artifactName: string; clipName?: string | null }>();
    for (const [artifactId, entries] of placements) {
      const artifactName = names.get(artifactId) ?? (detail?.id === artifactId ? detail.name : undefined);
      if (!artifactName) continue;
      for (const { candidate, clipName: placedClipName } of entries) {
        const clipName = candidate.clipId ? placedClipName ?? clipNames.get(candidate.clipId) : null;
        labels.set(candidate.id, { artifactName, ...(clipName !== undefined ? { clipName } : {}) });
      }
    }
    if (viewedTargetCandidate && detail?.id === viewedTargetCandidate.artifactId &&
        !labels.has(viewedTargetCandidate.id)) {
      const clipName = viewedTargetCandidate.clipId ? clipNames.get(viewedTargetCandidate.clipId) : null;
      labels.set(viewedTargetCandidate.id, { artifactName: detail.name,
        ...(clipName !== undefined ? { clipName } : {}) });
    }
    return labels;
  });
  let matchedPlacements = $derived.by(() => {
    if (!route.slotId) return placements;
    const filters = route.filters ?? {};
    const filtered = new Map<string, PlacementRecord[]>();
    for (const [id, list] of placements) {
      const matches = list.filter(item =>
        (!filters.reviews?.length || filters.reviews.includes(item.candidate.reviewState)) &&
        (!filters.selection?.length || filters.selection.some(value =>
          value === 'selected' ? item.candidate.id === selectedForView :
          value === 'formerly-selected' ? !!item.formerlySelected && item.candidate.id !== selectedForView :
          item.candidate.id !== selectedForView)));
      if (matches.length) filtered.set(id, matches);
    }
    return filtered;
  });

  function lock(messageText = '') {
    sessionCheckGeneration++;
    navigationGeneration++; searchGeneration++; detailGeneration++; revisionGeneration++; candidateGeneration++;
    session = null; connection = null; api = null;
    projects = blank(); assets = blank(); slots = blank(); results = blank(); textResults = blank();
    projectRecord = null; assetRecord = null; slotRecord = null; requestRecord = null; placements = new Map();
    selectedSnapshot = null; viewedCandidate = null;
    ownerProjects = new Map(); ownerAssets = new Map();
    detail = null; media = null; mediaError = ''; mediaLoading = false;
    claims = blank(); inputs = blank(); gaps = blank(); clips = blank();
    revision = null; revisionError = ''; revisionHint = null;
    successfulCapture = null; captureOpen = false; captureContext = null; message = messageText;
    // Deliberately keep the URL: pairing returns to its intended project/slot/artwork.
  }
  function loadError(error: unknown): string {
    if (error instanceof ApiClientError && error.unauthorized) {
      lock('Browser session ended. Pair again to return to this record.');
      return 'Browser session ended.';
    }
    return conflict(error) ? stale : explain(error);
  }
  async function refreshSession() {
    if (disconnecting) return;
    const generation = ++sessionCheckGeneration;
    try {
      const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (generation !== sessionCheckGeneration) return;
      if (!response.ok) {
        if (response.status === 401) lock(session ? 'Browser session ended. Pair again to return to this record.' : '');
        else message = 'The local service could not check your session. Your unsent entries remain here; try Refresh.';
        return;
      }
      const next = await response.json() as Session;
      if (generation !== sessionCheckGeneration) return;
      const info = await fetch('/api/connection', { credentials: 'same-origin', cache: 'no-store' });
      if (generation !== sessionCheckGeneration) return;
      if (!info.ok) throw new Error('connection unavailable');
      const nextConnection = await info.json() as Connection;
      if (generation !== sessionCheckGeneration) return;
      connection = nextConnection;
      session = next;
      const client = new ApiClient(next.csrfToken, () => {
        if (api === client) lock('Browser session ended. Pair again to return to this record.');
      });
      api = client; message = '';
      void refreshRecords();
    } catch {
      if (generation === sessionCheckGeneration)
        message = 'Cannot reach the local service. Start it from the project terminal, then refresh this page. Unsent entries remain in this tab.';
    }
  }
  async function pair(event: SubmitEvent) {
    event.preventDefault();
    if (!pairingCode.trim() || busy) return;
    busy = true; message = '';
    try {
      const response = await fetch('/api/pair', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capability: pairingCode.trim() }) });
      if (!response.ok) {
        message = response.status === 401 ? 'Code rejected or expired. Request a new code in the terminal and try again.'
          : 'Could not pair with the local service. Check the terminal and try again.';
        return;
      }
      ++sessionCheckGeneration;
      pairingCode = ''; await refreshSession();
    } catch { message = 'Cannot reach the local service. Start it from the project terminal, then try again.'; }
    finally { busy = false; }
  }
  async function disconnect() {
    if (!session || busy || !api) return;
    busy = true; disconnecting = true; ++sessionCheckGeneration;
    try { await api.mutate('/api/session', 'DELETE'); lock(); }
    catch { message = 'Could not end this browser session. Try again.'; }
    finally { disconnecting = false; busy = false; }
  }
  onMount(() => {
    const pop = () => {
      const next = parseNavigation();
      if (next.artifactId !== route.artifactId || next.clipId !== route.clipId || next.revisionId !== route.revisionId) displayedPlayback = null;
      route = next; void refreshRecords();
    };
    const focus = () => { if (document.visibilityState === 'visible') void refreshSession(); };
    window.addEventListener('popstate', pop); window.addEventListener('focus', focus);
    void refreshSession();
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('focus', focus); };
  });
  function navigate(patch: Partial<NavigationState>, replace = false) {
    operationError = '';
    if (patch.revisionId !== undefined && patch.revisionId !== revisionHint?.id) revisionHint = null;
    if ('revisionId' in patch && patch.revisionId === undefined) revisionHint = null;
    const previous = route;
    const next = patchNavigation(previous, patch);
    if (next.artifactId !== previous.artifactId || next.clipId !== previous.clipId || next.revisionId !== previous.revisionId) displayedPlayback = null;
    if (replace) replaceNavigation(next); else pushNavigation(next);
    route = next;
    // Comparing artwork and switching inspector tabs read within the same slot/query.
    // Keep the current result snapshot and form components mounted.
    const sameQuery = next.projectId === previous.projectId && next.assetId === previous.assetId &&
      next.slotId === previous.slotId && next.text === previous.text && next.scope === previous.scope &&
      JSON.stringify(next.filters ?? {}) === JSON.stringify(previous.filters ?? {}) &&
      next.requestId === previous.requestId;
    if (!sameQuery) { void refreshRecords(); return; }
    if (next.candidateId !== previous.candidateId) void refreshViewedCandidate();
    if (next.artifactId !== previous.artifactId) void refreshDetail();
    if (next.revisionId !== previous.revisionId) void refreshRevision();
    if (previous.artifactId && !next.artifactId) void refreshSearch();
  }
  function noteDisplayedPlayback(value: { artifactId: string; clipId: string; revisionId: string } | null) {
    if (value && (value.artifactId !== route.artifactId || value.clipId !== route.clipId)) return;
    if (value?.artifactId === displayedPlayback?.artifactId && value?.clipId === displayedPlayback?.clipId &&
        value?.revisionId === displayedPlayback?.revisionId) return;
    displayedPlayback = value;
  }
  function viewCurrentClipForReview() {
    const clipId = viewedTargetCandidate?.clipId;
    if (!clipId) return;
    viewClip(clipId);
    void refreshDetail();
  }
  function viewClip(clipId?: string) {
    const targetClipId = clipId ?? null;
    const found = route.artifactId && route.slotId
      ? placements.get(route.artifactId)?.find(({ candidate }) =>
          candidate.artifactId === route.artifactId && candidate.slotId === route.slotId &&
          candidate.clipId === targetClipId)?.candidate : undefined;
    // A direct deep link may verify its own candidate before the slot's pages load.
    const candidateId = found?.id ?? (viewedTargetCandidate?.clipId === targetClipId ? viewedTargetCandidate.id : undefined);
    navigate({ clipId, candidateId, revisionId: undefined }, true);
  }
  async function refreshViewedCandidate() {
    const generation = ++candidateGeneration;
    viewedCandidate = null;
    if (!api || !route.candidateId) return;
    const indexed = [...placements.values()].flat().find(item => item.candidate.id === route.candidateId)?.candidate;
    if (indexed) { viewedCandidate = indexed; return; }
    const client = api;
    try {
      const candidate = await client.get<CandidateRecord>(`/api/candidates/${route.candidateId}`);
      if (client === api && generation === candidateGeneration) viewedCandidate = candidate;
    } catch (cause) {
      if (client === api && generation === candidateGeneration) operationError = loadError(cause);
    }
  }
  function goProject(id: string) {
    navigate({ projectId: id, assetId: undefined, slotId: undefined, artifactId: undefined, candidateId: undefined,
      clipId: undefined, requestId: undefined, revisionId: undefined, filters: { projectIds: [id] } });
  }
  function goAsset(id: string) {
    navigate({ assetId: id, slotId: undefined, artifactId: undefined, candidateId: undefined, clipId: undefined,
      requestId: undefined, revisionId: undefined, filters: { projectIds: route.projectId ? [route.projectId] : undefined, assetIds: [id] } });
  }
  function goSlot(id: string) {
    navigate({ slotId: id, artifactId: undefined, candidateId: undefined, clipId: undefined, requestId: undefined,
      revisionId: undefined, filters: { ...route.filters, projectIds: undefined, assetIds: undefined, unslotted: undefined, slotIds: [id] } });
  }
  function applyFilters(filters: SearchInput['filters'], text: string, scope: 'current' | 'history') {
    navigate({ slotId: filters.slotIds?.[0], artifactId: undefined, candidateId: undefined, clipId: undefined,
      revisionId: undefined, filters, text: text || undefined, scope });
  }
  function effectiveFilters(nav: NavigationState): SearchInput['filters'] {
    const f = nav.filters ?? (nav.slotId ? {} : nav.assetId ? { assetIds: [nav.assetId] } : nav.projectId ? { projectIds: [nav.projectId] } : {});
    return nav.slotId ? { ...f, unslotted: undefined, slotIds: [nav.slotId] } : f;
  }
  async function page<T>(state: Pages<T>, path: string, assign: (next: Pages<T>) => void, more = false) {
    if (!api || (more && (!state.cursor || state.loading))) return;
    const client = api;
    const generation = navigationGeneration;
    assign({ ...state, loading: true, error: '' });
    try {
      const result = await client.page<T>(path, more ? state.cursor ?? undefined : undefined);
      if (client !== api || generation !== navigationGeneration) return;
      if (more && state.watermark !== result.watermark) { assign({ ...blank<T>(), error: stale }); return; }
      assign({ items: more ? [...state.items, ...result.items] : result.items,
        cursor: result.nextCursor, watermark: result.watermark, loading: false, error: '' });
    } catch (cause) {
      if (client !== api || generation !== navigationGeneration) return;
      const error = loadError(cause);
      assign(conflict(cause) ? { ...blank<T>(), error } : { ...state, loading: false, error });
    }
  }
  function projectPage(more = false) { return page(projects, '/api/projects', value => projects = value, more); }
  async function assetPage(more = false): Promise<void> {
    if (route.projectId) await page(assets, `/api/projects/${route.projectId}/assets`, value => assets = value, more);
  }
  async function slotPage(more = false): Promise<void> {
    if (route.assetId) await page(slots, `/api/assets/${route.assetId}/slots`, value => slots = value, more);
  }
  async function resolveDeepLink(client: ApiClient, current: NavigationState): Promise<NavigationState> {
    const next = { ...current };
    if (next.candidateId && !next.slotId) {
      const candidate = await client.get<CandidateRecord>(`/api/candidates/${next.candidateId}`);
      next.slotId = candidate.slotId;
      next.artifactId ??= candidate.artifactId;
      next.clipId ??= candidate.clipId ?? undefined;
    }
    if (next.slotId && !next.assetId) {
      const slot = await client.get<SlotRecord>(`/api/slots/${next.slotId}`);
      next.assetId = slot.assetId;
    }
    if (next.requestId && !next.assetId) {
      const request = await client.get<RequestRecord>(`/api/requests/${next.requestId}`);
      next.assetId = request.assetId;
      next.projectId ??= request.projectId;
    }
    if (next.artifactId && !next.assetId) {
      const artwork = await client.get<CaptureRecord>(`/api/artifacts/${next.artifactId}`);
      next.assetId = artwork.assetId;
      next.projectId ??= artwork.projectId;
    }
    if (next.assetId && !next.projectId) {
      const asset = await client.get<AssetRecord>(`/api/assets/${next.assetId}`);
      next.projectId = asset.projectId;
    }
    return next;
  }
  async function refreshRecords() {
    if (!api) return;
    ++candidateGeneration;
    const generation = ++navigationGeneration;
    const client = api;
    let current = { ...route };
    try {
      const resolved = await resolveDeepLink(client, current);
      if (generation !== navigationGeneration || client !== api) return;
      if (resolved.projectId !== current.projectId || resolved.assetId !== current.assetId ||
          resolved.slotId !== current.slotId || resolved.artifactId !== current.artifactId || resolved.clipId !== current.clipId) {
        current = resolved; route = current; replaceNavigation(current);
      }
    } catch (cause) { if (generation === navigationGeneration) operationError = loadError(cause); }
    if (generation !== navigationGeneration || !api) return;
    const work = [projectPage()];
    if (current.projectId) work.push(assetPage()); else { assets = blank(); projectRecord = null; }
    if (current.assetId) work.push(slotPage()); else { slots = blank(); assetRecord = null; }
    if (!current.slotId) slotRecord = null;
    await Promise.all(work);
    if (generation !== navigationGeneration || client !== api) return;
    try {
      const details = await Promise.all([
        current.projectId ? client.get<ProjectRecord>(`/api/projects/${current.projectId}`) : Promise.resolve(null),
        current.assetId ? client.get<AssetRecord>(`/api/assets/${current.assetId}`) : Promise.resolve(null),
        current.slotId ? client.get<SlotRecord>(`/api/slots/${current.slotId}`) : Promise.resolve(null),
        current.requestId ? client.get<RequestRecord>(`/api/requests/${current.requestId}`) : Promise.resolve(null),
        current.candidateId ? client.get<CandidateRecord>(`/api/candidates/${current.candidateId}`) : Promise.resolve(null),
      ]);
      if (generation !== navigationGeneration || client !== api) return;
      projectRecord = details[0]; assetRecord = details[1]; slotRecord = details[2]; requestRecord = details[3];
      if (current.candidateId === route.candidateId) viewedCandidate = details[4];
      if (viewedCandidate && viewedCandidate.id === route.candidateId &&
          (viewedCandidate.artifactId !== route.artifactId || viewedCandidate.slotId !== route.slotId ||
            viewedCandidate.clipId !== (route.clipId ?? null))) {
        operationError = 'Candidate identity does not match this artwork, clip target, and slot. No review is attributed to the viewed target.';
      }
      if (assetRecord && stageForAsset !== assetRecord.id) {
        stageForAsset = assetRecord.id; stageDraft = assetRecord.stage ?? ''; stageEditRevision = assetRecord.revision;
      }
      if (assetRecord && slotDraftFor !== assetRecord.id) {
        slotDraftFor = assetRecord.id; slotName = ''; slotNotes = '';
      }
      if (slotRecord && slotEditFor !== slotRecord.id) {
        slotEditFor = slotRecord.id; slotEditName = slotRecord.name; slotEditNotes = slotRecord.notes;
        slotEditRevision = slotRecord.revision;
      }
      if (current.slotId && slotRecord && current.assetId && slotRecord.assetId !== current.assetId) {
        operationError = 'This slot belongs to a different asset. Open its owner asset before placing artwork.';
      }
    } catch (cause) { if (generation === navigationGeneration) operationError = loadError(cause); }
    if (generation !== navigationGeneration || !api) return;
    void refreshSearch();
    if (current.artifactId === route.artifactId) void refreshDetail();
    if (current.revisionId === route.revisionId) void refreshRevision();
  }
  async function readPlacements(client: ApiClient, nav: NavigationState, watermark: number, hydrate = true):
    Promise<{ items: Map<string, PlacementRecord[]>; selectedCandidateId: string | null }> {
    if (!nav.slotId || !nav.assetId) return { items: new Map(), selectedCandidateId: null };
    const all: PlacementRecord[] = [];
    let cursor: string | null = null;
    let seenWatermark: number | null = null;
    let selectedCandidateId: string | null = null;
    do {
      const params = new URLSearchParams({ assetId: nav.assetId, slotId: nav.slotId, section: 'candidates', limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const context = await client.get<ContextResult>(`/api/queries/context?${params}`);
      if (seenWatermark !== null && context.watermark !== seenWatermark || context.watermark !== watermark) {
        throw new Error(stale);
      }
      seenWatermark = context.watermark;
      if (!context.targetSlot) throw new Error('Slot context is unavailable. Refresh the query.');
      selectedCandidateId = context.targetSlot.selectedCandidateId;
      for (const entry of hydrate ? context.sections.candidates.items : []) {
        const data = entry.record as {
          artifactId: string; artifactName: string; reviewState: CandidateRecord['reviewState']; revision: number;
          placement: { slotId: string; placedAt: string };
          originalOwner: { projectName: string; assetName: string };
          clip: { id: string; name: string } | null;
        };
        all.push({ candidate: { id: entry.id, slotId: data.placement.slotId, artifactId: data.artifactId,
          clipId: data.clip?.id ?? null, reviewState: data.reviewState, revision: data.revision,
          placedAt: data.placement.placedAt }, capturedProjectName: data.originalOwner.projectName,
          capturedAssetName: data.originalOwner.assetName, clipName: data.clip?.name ?? null });
      }
      cursor = context.sections.candidates.nextCursor;
    } while (cursor && hydrate);
    let former = new Set<string>();
    if (hydrate && nav.filters?.selection?.includes('formerly-selected')) {
      let historyCursor: string | null = null; let historyWatermark: number | null = null;
      do {
        const history: QueryPage<SlotSelectionDecision> =
          await client.page<SlotSelectionDecision>(`/api/slots/${nav.slotId}/selection-history`, historyCursor ?? undefined);
        if (historyWatermark !== null && history.watermark !== historyWatermark || history.watermark !== watermark) throw new Error(stale);
        historyWatermark = history.watermark;
        for (const decision of history.items) if (decision.previous?.candidateId) former.add(decision.previous.candidateId);
        historyCursor = history.nextCursor;
      } while (historyCursor);
    }
    const mapped = new Map<string, PlacementRecord[]>();
    for (const value of all) {
      value.formerlySelected = former.has(value.candidate.id);
      mapped.set(value.candidate.artifactId, [...(mapped.get(value.candidate.artifactId) ?? []), value]);
    }
    return { items: mapped, selectedCandidateId };
  }
  async function readOwners(client: ApiClient, hits: Pick<SearchHit, 'projectId' | 'assetId'>[], generation: number) {
    const projectsToRead = [...new Set(hits.map(hit => hit.projectId))].filter(id => !ownerProjects.has(id));
    const assetsToRead = [...new Set(hits.map(hit => hit.assetId))].filter(id => !ownerAssets.has(id));
    const [projectRows, assetRows] = await Promise.all([
      Promise.allSettled(projectsToRead.map(id => client.get<ProjectRecord>(`/api/projects/${id}`))),
      Promise.allSettled(assetsToRead.map(id => client.get<AssetRecord>(`/api/assets/${id}`))),
    ]);
    if (client !== api || generation !== searchGeneration) return;
    const nextProjects = new Map(ownerProjects); const nextAssets = new Map(ownerAssets);
    projectRows.forEach(row => { if (row.status === 'fulfilled') nextProjects.set(row.value.id, row.value.name); });
    assetRows.forEach(row => { if (row.status === 'fulfilled') nextAssets.set(row.value.id, row.value.name); });
    ownerProjects = nextProjects; ownerAssets = nextAssets;
  }
  async function refreshSearch(more = false) {
    if (!api || (more && (!results.cursor || results.loading))) return;
    const generation = more ? searchGeneration : ++searchGeneration;
    const current = { ...route }; const client = api;
    const previous = results;
    if (!more) {
      results = { ...blank(), loading: true }; textResults = blank(); placements = new Map(); selectedSnapshot = null;
      ownerProjects = new Map(); ownerAssets = new Map();
    }
    else results = { ...previous, loading: true, error: '' };
    resultLoading = true;
    try {
      const match = await client.search(effectiveFilters(current), current.text, current.scope ?? 'current', more ? previous.cursor ?? undefined : undefined);
      if (generation !== searchGeneration || client !== api) return;
      if (more && previous.watermark !== match.watermark) throw new Error(stale);
      const resolved = more && previous.watermark === match.watermark &&
        (!current.slotId || selectedSnapshot?.watermark === match.watermark)
        ? { items: placements, selectedCandidateId: selectedSnapshot?.candidateId ?? null }
        : await readPlacements(client, current, match.watermark, match.items.length > 0);
      if (generation !== searchGeneration || client !== api) return;
      placements = resolved.items;
      selectedSnapshot = current.slotId ? { slotId: current.slotId, candidateId: resolved.selectedCandidateId, watermark: match.watermark } : null;
      if (!current.slotId) void readOwners(client, match.items, generation);
      results = { items: more ? [...previous.items, ...match.items] : match.items,
        cursor: match.nextCursor, watermark: match.watermark, loading: false, error: '' };
      if (!more && current.text?.trim()) void refreshText(current, generation, client);
    } catch (cause) {
      if (generation !== searchGeneration || client !== api) return;
      if (conflict(cause) || explain(cause) === stale) { placements = new Map(); selectedSnapshot = null; }
      results = conflict(cause) || explain(cause) === stale ? { ...blank(), error: loadError(cause) }
        : { ...previous, loading: false, error: loadError(cause) };
    } finally { if (generation === searchGeneration) resultLoading = false; }
  }
  async function refreshText(nav: NavigationState, generation: number, client: ApiClient, more = false) {
    if (!nav.text?.trim() || (more && (!textResults.cursor || textResults.loading))) return;
    const previous = textResults;
    textResults = more ? { ...previous, loading: true, error: '' } : { ...blank(), loading: true };
    const params = new URLSearchParams({ text: nav.text, scope: nav.scope ?? 'current' });
    try {
      const result = await client.page<TextHit>(`/api/queries/text?${params}`, more ? previous.cursor ?? undefined : undefined);
      if (generation !== searchGeneration || client !== api) return;
      if (more && result.watermark !== previous.watermark) throw new Error(stale);
      textResults = { items: more ? [...previous.items, ...result.items] : result.items,
        cursor: result.nextCursor, watermark: result.watermark, loading: false, error: '' };
    } catch (cause) {
      if (generation !== searchGeneration || client !== api) return;
      textResults = conflict(cause) || explain(cause) === stale ? { ...blank(), error: loadError(cause) }
        : { ...previous, loading: false, error: loadError(cause) };
    }
  }
  function openText(hit: TextHit) {
    revisionHint = { id: hit.revisionId, type: hit.type };
    const patch: Partial<NavigationState> = { artifactId: undefined, candidateId: undefined, clipId: undefined, requestId: undefined,
      revisionId: hit.revisionId, tab: 'history' };
    if (hit.scope === 'artifact') patch.artifactId = hit.scopeId;
    else if (hit.scope === 'request') Object.assign(patch, { projectId: undefined, assetId: undefined, slotId: undefined,
      requestId: hit.scopeId, filters: {} });
    else if (hit.scope === 'slot') Object.assign(patch, { projectId: undefined, assetId: undefined, slotId: hit.scopeId,
      filters: { slotIds: [hit.scopeId] } });
    else if (hit.scope === 'asset') Object.assign(patch, { projectId: undefined, assetId: hit.scopeId, slotId: undefined,
      filters: { assetIds: [hit.scopeId] } });
    else if (hit.scope === 'project') Object.assign(patch, { projectId: hit.scopeId, assetId: undefined, slotId: undefined,
      filters: { projectIds: [hit.scopeId] } });
    navigate(patch);
  }
  async function refreshRevision() {
    const generation = ++revisionGeneration;
    revision = null; revisionError = ''; revisionLoading = false;
    if (!api || !route.revisionId) return;
    const client = api; const id = route.revisionId;
    revisionLoading = true;
    const foundType = revisionHint?.id === id ? revisionHint.type :
      results.items.find(hit => hit.matchedRevision?.revisionId === id)?.matchedRevision?.type ??
      textResults.items.find(hit => hit.revisionId === id)?.type;
    const types = foundType ? [foundType] : id.includes(':') ? ['project', 'asset', 'slot'] :
      ['artifact', 'request', 'outcome', 'claim', 'clip', 'input', 'gap', 'review', 'selection', 'stage-decision'];
    try {
      for (const type of types) {
        try {
          const found = await client.get<RevisionDetail>(`/api/queries/revisions/${type}/${encodeURIComponent(id)}`);
          if (generation !== revisionGeneration || client !== api) return;
          revision = found; revisionHint = { id, type }; return;
        } catch (cause) {
          if (cause instanceof ApiClientError && cause.status === 404) continue;
          throw cause;
        }
      }
      revisionError = 'The requested recorded revision is unavailable; current facts are shown separately.';
    } catch (cause) {
      if (generation === revisionGeneration && client === api) revisionError = loadError(cause);
    } finally { if (generation === revisionGeneration) revisionLoading = false; }
  }
  async function refreshMedia() {
    if (!api || !route.artifactId) return;
    const client = api; const id = route.artifactId; const generation = detailGeneration;
    media = null; mediaError = ''; mediaLoading = true;
    try {
      const description = await client.get<MediaDescription>(`/api/artifacts/${id}/media`);
      if (client === api && generation === detailGeneration && route.artifactId === id) {
        media = description;
        if (detailError.startsWith('Media description unavailable:')) {
          detailError = claims.error || inputs.error || gaps.error || clips.error
            ? 'Some record details are unavailable. Refresh to retry; missing sections do not imply no history.' : '';
        }
      }
    } catch (cause) {
      if (client === api && generation === detailGeneration && route.artifactId === id) {
        const reason = loadError(cause);
        if (client === api) { mediaError = reason; detailError = `Media description unavailable: ${reason}`; }
      }
    } finally {
      if (client === api && generation === detailGeneration && route.artifactId === id) mediaLoading = false;
    }
  }
  async function refreshDetail() {
    const generation = ++detailGeneration;
    detail = null; media = null; mediaError = ''; mediaLoading = false;
    claims = blank(); inputs = blank(); gaps = blank(); clips = blank(); detailError = '';
    if (!api || !route.artifactId) { detailLoading = false; return; }
    const client = api; const id = route.artifactId;
    detailLoading = true;
    try {
      const artifact = await client.get<CaptureRecord>(`/api/artifacts/${id}`);
      if (generation !== detailGeneration || client !== api) return;
      detail = artifact;
      void readOwners(client, [artifact], searchGeneration);
      void refreshMedia();
      const [claimsPage, inputsPage, gapsPage, clipsPage] = await Promise.allSettled([
        client.page<ClaimRecord>(`/api/artifacts/${id}/claims`),
        client.page<InputEdgeRecord>(`/api/artifacts/${id}/inputs`),
        client.page<LineageGapRecord>(`/api/artifacts/${id}/gaps`),
        client.page<ClipRecord>(`/api/artifacts/${id}/clips`),
      ]);
      if (generation !== detailGeneration || client !== api) return;
      const section = <T,>(result: PromiseSettledResult<QueryPage<T>>): Pages<T> =>
        result.status === 'fulfilled'
          ? { items: result.value.items, cursor: result.value.nextCursor, watermark: result.value.watermark, loading: false, error: '' }
          : { ...blank<T>(), error: explain(result.reason) };
      claims = section(claimsPage); inputs = section(inputsPage); gaps = section(gapsPage); clips = section(clipsPage);
      if (claims.error || inputs.error || gaps.error || clips.error) {
        detailError = 'Some record details are unavailable. Refresh to retry; missing sections do not imply no history.';
      }
    } catch (cause) { if (generation === detailGeneration) detailError = loadError(cause); }
    finally { if (generation === detailGeneration) detailLoading = false; }
  }
  function loadDetailPart(part: 'claims' | 'inputs' | 'gaps' | 'clips') {
    if (!route.artifactId) return;
    const artifactId = route.artifactId;
    const generation = detailGeneration;
    const path = `/api/artifacts/${artifactId}/${part}`;
    const current = () => route.artifactId === artifactId && detailGeneration === generation;
    if (part === 'claims') void page(claims, path, value => { if (current()) claims = value; }, true);
    if (part === 'inputs') void page(inputs, path, value => { if (current()) inputs = value; }, true);
    if (part === 'gaps') void page(gaps, path, value => { if (current()) gaps = value; }, true);
    if (part === 'clips') void page(clips, path, value => { if (current()) clips = value; }, true);
  }
  async function placeCandidate(slotId: string, clipId?: string) {
    if (!api || !detail) return;
    const created = await api.mutate<CandidateRecord>(`/api/slots/${slotId}/candidates`, 'POST',
      { artifactId: detail.id, ...(clipId ? { clipId } : {}) });
    navigate({ slotId, candidateId: created.id, clipId: clipId ?? undefined,
      filters: { ...route.filters, projectIds: undefined, assetIds: undefined, unslotted: undefined, slotIds: [slotId] } });
  }
  async function createSlot(event: SubmitEvent) {
    event.preventDefault();
    if (!api || !route.assetId || slotDraftFor !== route.assetId || !slotName.trim()) return;
    busy = true; operationError = '';
    try {
      const record = await api.mutate<SlotRecord>(`/api/assets/${route.assetId}/slots`, 'POST',
        { name: slotName.trim(), notes: slotNotes });
      if (captureContext?.assetId === record.assetId) captureContext = { ...captureContext, slots: [...captureContext.slots, record] };
      slotName = ''; slotNotes = ''; goSlot(record.id);
    } catch (cause) { operationError = explain(cause); }
    finally { busy = false; }
  }
  async function editSlot(event: SubmitEvent) {
    event.preventDefault();
    if (!api || !currentSlot || slotEditFor !== currentSlot.id ||
        !slotEditName.trim() || slotEditRevision !== currentSlot.revision) return;
    busy = true; operationError = '';
    try {
      const changed = await api.mutate<SlotRecord>(`/api/slots/${currentSlot.id}`, 'PATCH',
        { expectedRevision: slotEditRevision, name: slotEditName.trim(), notes: slotEditNotes });
      slotRecord = changed; slotEditRevision = changed.revision; void refreshRecords();
    } catch (cause) {
      operationError = `${explain(cause)} Your slot entries remain here; review the latest record before retrying a conflict.`;
    } finally { busy = false; }
  }
  async function setStage(event: SubmitEvent) {
    event.preventDefault();
    if (!api || !currentAsset || stageForAsset !== currentAsset.id ||
        stageEditRevision !== currentAsset.revision) return;
    busy = true; operationError = '';
    try { const changed = await api.mutate<{ asset: AssetRecord }>(`/api/assets/${currentAsset.id}/stage`, 'PATCH',
      { expectedAssetRevision: stageEditRevision, stage: stageDraft.trim() || null });
      assetRecord = changed.asset; stageEditRevision = changed.asset.revision; void refreshRecords();
    } catch (cause) { operationError = `${explain(cause)} Your stage entry remains here; refresh the record before retrying a conflict.`; }
    finally { busy = false; }
  }
  function toggleCapture() {
    if (captureOpen) { captureOpen = false; captureContext = null; return; }
    if (!route.projectId || !route.assetId) return;
    captureContext = { projectId: route.projectId, assetId: route.assetId, slots: [...listedSlots],
      slotId: route.slotId, requestId: route.requestId };
    successfulCapture = null;
    captureOpen = true;
  }
  function onCaptureCommitted(receipt: CaptureReceipt, metadata: CaptureMetadata) {
    if (receipt.status !== 'committed') return;
    successfulCapture = { receipt, projectId: metadata.projectId, assetId: metadata.assetId, slotId: metadata.slotId };
    void refreshRecords();
  }
</script>

<svelte:head><meta name="description" content="Find, preserve, and inspect artwork in your private local AssetWeave service." /></svelte:head>

{#if session && connection && currentApi}
  {#snippet decisionControls()}
    <DecisionPanel api={currentApi} candidate={detail?.id === route.artifactId ? viewedTargetCandidate : null}
      slotRecord={currentSlot} asset={route.slotId && currentSlot?.assetId !== currentAsset?.id ? null : currentAsset}
      alternatives={slotAlternatives} {candidateLabels} {viewedPlaybackRevisionId}
      historicalPlayback={!!route.revisionId} onViewCurrentClip={viewCurrentClipForReview}
      onChanged={() => void refreshRecords()} />
  {/snippet}
  {#snippet requestControls()}
    <RequestPanel api={currentApi} projectId={route.projectId} assetId={route.assetId} slotId={route.slotId}
      requestId={detail?.requestId ?? route.requestId ?? undefined} request={requestRecord?.id === (detail?.requestId ?? route.requestId) ? requestRecord : null}
      onNavigate={navigate} onChanged={() => void refreshRecords()} />
  {/snippet}
  {#snippet playbackControls()}
    {#if detail && detail.id === route.artifactId}
      <ClipEditor api={currentApi} record={detail} {media} clips={clips.items} selectedClipId={route.clipId}
        hasMore={!!clips.cursor} onLoadMore={() => loadDetailPart('clips')} onChanged={() => void refreshRecords()} />
    {/if}
  {/snippet}
  <WorkbenchShell title={workbenchTitle} context={workbenchContext} onRefresh={() => void refreshSession()} onDisconnect={() => void disconnect()}
    onCapture={route.projectId && route.assetId ? toggleCapture : undefined}>
    {#snippet navigation()}
      <button class="nav-item" type="button" aria-current={!route.projectId ? 'page' : undefined}
        onclick={() => navigate({ projectId: undefined, assetId: undefined, slotId: undefined, artifactId: undefined, candidateId: undefined, clipId: undefined, requestId: undefined, revisionId: undefined, filters: {} })}>All artwork</button>
      <ProjectBrowser api={currentApi} projects={listedProjects} selectedProjectId={route.projectId}
        hasMore={!!projects.cursor} loading={projects.loading} onSelect={goProject} onLoadMore={() => void projectPage(true)}
        onRefresh={() => void projectPage()} onChanged={record => {
          projectRecord = record;
          if (route.projectId !== record.id) goProject(record.id);
          else void refreshRecords();
        }} />
      {#if projects.error}<p role="alert" class="error">{projects.error}</p>{/if}
      {#if route.projectId}
        <AssetBrowser api={currentApi} assets={listedAssets} project={currentProject} selectedAssetId={route.assetId}
          hasMore={!!assets.cursor} loading={assets.loading} onSelect={goAsset} onLoadMore={() => void assetPage(true)}
          onRefresh={() => void assetPage()} onChanged={record => {
            assetRecord = record;
            if (route.assetId !== record.id) goAsset(record.id);
            else void refreshRecords();
          }} />
        {#if assets.error}<p role="alert" class="error">{assets.error}</p>{/if}
      {/if}
      {#if route.assetId}
        <section class="nav-section" aria-label="Asset slots"><p class="nav-label">Named slots</p>
          <button class="nav-item" type="button" aria-current={!route.slotId && !route.filters?.unslotted ? 'page' : undefined}
            onclick={() => navigate({ slotId: undefined, artifactId: undefined, candidateId: undefined, clipId: undefined, revisionId: undefined,
              filters: { projectIds: route.projectId ? [route.projectId] : undefined, assetIds: [route.assetId!] } })}>All captured artwork</button>
          <button class="nav-item" type="button" aria-current={route.filters?.unslotted ? 'page' : undefined}
            onclick={() => navigate({ slotId: undefined, artifactId: undefined, candidateId: undefined, clipId: undefined, revisionId: undefined,
              filters: { assetIds: [route.assetId!], unslotted: true } })}>Unslotted artwork</button>
          {#each listedSlots as slot (slot.id)}<button type="button" class="nav-item" aria-current={route.slotId === slot.id ? 'page' : undefined} onclick={() => goSlot(slot.id)}>{slot.name}</button>{/each}
          {#if slots.cursor}<button type="button" class="quiet" onclick={() => void slotPage(true)} disabled={slots.loading}>Load more slots</button>{/if}
          {#if slots.error}<p role="alert" class="error">{slots.error}</p>{/if}
        </section>
      {/if}
      <p class="nav-footnote">Local records only · viewing never selects or reviews artwork.</p>
    {/snippet}
    {#snippet content()}
      {#if message}<p role="alert" class="notice">{message}</p>{/if}
      {#if operationError}<p role="alert" class="notice">{operationError}</p>{/if}
      {#if captureOpen && captureContext}
        <div class="content-head"><button class="quiet" type="button" onclick={toggleCapture}>← Return to artwork</button>
          <p class="muted">Capture destination · project {captureContext.projectId} / asset {captureContext.assetId}. Changing navigation does not retarget an open import.</p></div>
        <CaptureForm api={currentApi} projectId={captureContext.projectId} assetId={captureContext.assetId} slots={captureContext.slots}
          slotId={captureContext.slotId} requestId={captureContext.requestId} onCommitted={onCaptureCommitted} />
        {#if successfulCapture?.receipt.status === 'committed'}<p class="notice" role="status">Committed artwork · <button type="button" class="text-link" onclick={() => {
          const saved = successfulCapture!;
          toggleCapture();
          navigate({ projectId: saved.projectId, assetId: saved.assetId, slotId: saved.slotId,
            artifactId: saved.receipt.status === 'committed' ? saved.receipt.artifactId : undefined, candidateId: undefined,
            filters: saved.slotId ? { slotIds: [saved.slotId] } : { assetIds: [saved.assetId], unslotted: true } });
        }}>Open captured record</button></p>{/if}
      {:else if route.artifactId}
        <ReviewWorkspace api={currentApi} record={detail?.id === route.artifactId ? detail : null} viewedArtifactId={route.artifactId}
          {media} {mediaError} {mediaLoading} clips={clips.items} onRefreshMedia={() => void refreshMedia()}
          clipId={route.clipId} pinnedRevisionId={pinnedPlaybackRevisionId} revisionId={route.revisionId} slotRecord={currentSlot}
          candidate={viewedTargetCandidate}
          selectedCandidateId={selectedForView} {selectedLoaded} {candidateLabels}
          capturedProjectName={detail ? ownerProjects.get(detail.projectId) : undefined} capturedAssetName={detail ? ownerAssets.get(detail.assetId) : undefined}
          loading={detailLoading} error={detailError} hits={results.items} placements={matchedPlacements} {ownerProjects} {ownerAssets}
          hasMore={!!results.cursor} hasMoreClips={!!clips.cursor} searchLoading={resultLoading} searchError={results.error}
          onBack={() => navigate({ artifactId: undefined, candidateId: undefined, clipId: undefined, revisionId: undefined })}
          onOpen={(hit, placement) => {
            revisionHint = hit.matchedRevision ? { id: hit.matchedRevision.revisionId, type: hit.matchedRevision.type } : null;
            navigate({ artifactId: hit.artifactId, candidateId: placement?.candidate.id,
              clipId: placement?.candidate.clipId ?? undefined, revisionId: hit.matchedRevision?.revisionId,
              tab: hit.matchedRevision ? 'history' : route.tab === 'history' ? 'facts' : route.tab ?? 'facts' });
          }}
          onLoadMore={() => void refreshSearch(true)} onLoadMoreClips={() => loadDetailPart('clips')} onRefreshSearch={() => void refreshSearch()}
          onClipSelect={viewClip} onDisplayedPlayback={noteDisplayedPlayback} />
      {:else}
        <header class="content-heading"><p class="eyebrow">Artwork workbench</p><h1>{workbenchTitle}</h1>
          <p class="muted">{route.slotId ? 'Candidates placed in this slot, including work captured under other assets or projects.' : route.filters?.unslotted ? 'Captured artwork without any slot placement.' : 'Captured artwork and recorded history.'}</p></header>
        {#if route.slotId}<p class="selection-callout">Current slot selection: <strong>{selectedForView ?? 'No selection recorded'}</strong>. Viewing, filtering, or placing candidates does not change the selection.</p>{/if}
        <FilterBar filters={route.filters ?? emptyFilters()} text={route.text ?? ''} scope={route.scope ?? 'current'}
          currentSlotId={route.slotId} projects={listedProjects} assets={listedAssets} slots={listedSlots} onApply={applyFilters} />
        {#if resultLoading}<p class="muted" role="status">Finding artwork and resolving placements…</p>{/if}
        {#if results.error}<p role="alert" class="notice">{results.error} <button type="button" onclick={() => void refreshSearch()}>Refresh search</button></p>{/if}
        {#if !resultLoading && !results.error && !results.items.length}<p class="empty-state">No artwork matches this view. Rejected candidates are included unless you filter them out; adjust the filters or capture an original.</p>{/if}
        {#if route.slotId && results.items.length && !matchedPlacements.size && !resultLoading}<p class="muted">No matching placement on this results page. Load more results or adjust filters.</p>{/if}
        <CandidateGrid api={currentApi} hits={results.items} placements={matchedPlacements}
          {ownerProjects} {ownerAssets} slotId={route.slotId}
          selectedCandidateId={selectedForView} viewedArtifactId={route.artifactId}
          onOpen={(hit, placement) => {
            revisionHint = hit.matchedRevision ? { id: hit.matchedRevision.revisionId, type: hit.matchedRevision.type } : null;
            navigate({ artifactId: hit.artifactId, candidateId: placement?.candidate.id,
              clipId: placement?.candidate.clipId ?? undefined, revisionId: hit.matchedRevision?.revisionId,
              tab: hit.matchedRevision ? 'history' : 'facts' });
          }} />
        {#if results.cursor}<button class="quiet load-more" type="button" disabled={resultLoading} onclick={() => void refreshSearch(true)}>Load more artwork</button>{/if}
        {#if route.text}
          <section class="text-hits" aria-label="Recorded text search matches"><h2>Other matching records</h2><p class="muted">Includes requests with no captured artwork; historical matches retain their revision IDs.</p>
            {#if textResults.loading}<p role="status" class="muted">Searching recorded text…</p>{/if}
            {#if textResults.error}<p role="alert" class="error">{textResults.error}<button type="button" onclick={() => void refreshText(route, searchGeneration, currentApi)}>Refresh text matches</button></p>{/if}
            {#if !textResults.loading && !textResults.error && !textResults.items.length}<p class="muted">No matching text records in this query.</p>{/if}
            {#each textResults.items as hit, index (`${hit.type}:${hit.recordId}:${hit.revisionId}:${index}`)}
              <button class="text-hit" type="button" onclick={() => openText(hit)}><strong>{hit.type} · {hit.scope}</strong><span>{hit.excerpt}</span><small>{hit.revisionId}{hit.scope === 'request' ? ' · may not have captured artwork' : ''}</small></button>
            {/each}
            {#if textResults.cursor}<button type="button" class="quiet" disabled={textResults.loading} onclick={() => void refreshText(route, searchGeneration, currentApi, true)}>Load more text matches</button>{/if}
          </section>
        {/if}
      {/if}
    {/snippet}
    {#snippet inspector()}
      {#if route.artifactId}
        <ArtifactInspector api={currentApi} record={detail?.id === route.artifactId ? detail : null} {media}
          claims={claims.items} inputs={inputs.items} gaps={gaps.items} clips={clips.items} slots={listedSlots}
          selectedSlotId={route.slotId} selectedCandidateId={selectedForView}
          candidate={viewedTargetCandidate} {candidateLabels}
          currentAsset={route.slotId && currentSlot?.assetId !== currentAsset?.id ? null : currentAsset}
          capturedProjectName={detail ? ownerProjects.get(detail.projectId) : undefined} capturedAssetName={detail ? ownerAssets.get(detail.assetId) : undefined}
          tab={route.tab ?? 'facts'} revisionId={route.revisionId} {revision} {revisionLoading} {revisionError}
          errors={{ claims: claims.error, inputs: inputs.error, gaps: gaps.error, clips: clips.error }}
          more={{ claims: !!claims.cursor, inputs: !!inputs.cursor, gaps: !!gaps.cursor, clips: !!clips.cursor }}
          onNavigate={navigate} onTab={tab => navigate({ tab }, true)} onMore={loadDetailPart}
          onPlace={placeCandidate} onChanged={() => void refreshDetail()}
          decisions={decisionControls} requests={requestControls} editor={playbackControls} />
      {:else}
        <p class="eyebrow">Workspace context</p><h2>{workbenchTitle}</h2>
        <p class="muted">Paired browser · {connection?.origin ?? 'local service'} · private local profile</p>
        {#if currentProject}<p class="muted">Project · {currentProject.name}</p><p>{currentProject.notes || 'No project notes recorded.'}</p>{/if}
        {#if currentAsset}
          <p class="muted">Asset · {currentAsset.name}</p><p>{currentAsset.notes || 'No asset notes recorded.'}</p>
          <form class="inspector-form" onsubmit={setStage}><label>Human-set stage (optional)<input maxlength="200" placeholder="No human stage" bind:value={stageDraft} /></label>
            {#if stageEditRevision !== currentAsset.revision}
              <p class="muted">The asset changed elsewhere. Review its latest stage ({currentAsset.stage ?? 'None'}) before using the new revision with your draft.</p>
              <button class="quiet" type="button" onclick={() => stageEditRevision = currentAsset!.revision}>Use latest asset revision</button>
            {/if}
            <button class="quiet" type="submit" disabled={busy || stageForAsset !== currentAsset.id || stageEditRevision !== currentAsset.revision}>Save human stage</button></form>
          <form class="inspector-form" onsubmit={createSlot}><h3>New named slot</h3><label>Name<input maxlength="200" required bind:value={slotName} placeholder="e.g. Concept, Attack / sword" /></label>
            <label>Notes (optional)<textarea rows="2" maxlength="16384" bind:value={slotNotes}></textarea></label>
            <button class="quiet" type="submit" disabled={busy || slotDraftFor !== currentAsset.id || !slotName.trim()}>Create slot</button></form>
        {/if}
        {#if currentSlot}
          <p class="selection-callout">Selected candidate: <strong>{selectedForView ?? 'None'}</strong></p>
          <p class="muted">Slot notes: {currentSlot.notes || 'No notes recorded.'}</p>
          <form class="inspector-form" onsubmit={editSlot}><h3>Named slot details</h3>
            <label>Name<input maxlength="200" required bind:value={slotEditName} /></label>
            <label>Notes<textarea maxlength="16384" rows="2" bind:value={slotEditNotes}></textarea></label>
            {#if slotEditRevision !== currentSlot.revision}
              <p class="muted">This slot changed elsewhere. Review its latest name and notes above before using the new revision with your draft.</p>
              <button class="quiet" type="button" onclick={() => slotEditRevision = currentSlot!.revision}>Use latest slot revision</button>
            {/if}
            <button class="quiet" type="submit" disabled={busy || slotEditFor !== currentSlot.id || !slotEditName.trim() || slotEditRevision !== currentSlot.revision}>Save slot details</button>
          </form>
        {/if}
        {#if currentAsset || route.requestId}
          <RequestPanel api={currentApi} projectId={route.projectId} assetId={route.assetId} slotId={route.slotId}
            requestId={route.requestId} request={requestRecord} onNavigate={navigate} onChanged={() => void refreshRecords()} />
        {/if}
        {#if route.revisionId}
          <h3>Exact recorded text match</h3>
          {#if revisionLoading}<p role="status" class="muted">Loading revision…</p>{/if}
          {#if revisionError}<p role="alert" class="error">{revisionError}</p>{/if}
          {#if revision}<p class="muted">{revision.type} · {revision.current ? 'current' : 'historical'} revision {revision.revision} · {new Date(revision.at).toLocaleString()}.</p>
            <pre class="revision-body">{JSON.stringify(revision.record, null, 2)}</pre>
            <p class="muted">This is the recorded match; the workspace context above uses current records.</p>{/if}
        {/if}
        {#if !currentProject && !currentAsset}<p class="muted">Select or create a project and asset. Search can also browse all captured artwork.</p>{/if}
      {/if}
    {/snippet}
  </WorkbenchShell>
{:else}
  <div class="pair-frame"><header class="pair-topbar"><span class="pair-mark">A·W</span><strong>AssetWeave</strong><span class="pair-local">LOCAL WORKSPACE</span></header>
    <main class="pair-main"><p class="pair-kicker">YOUR ARTWORK, YOUR MACHINE — CONNECTION</p><section class="pair-panel" aria-labelledby="pair-title">
      <p class="pair-status">NOT PAIRED</p><h1 id="pair-title">Keep your work<br /><em>close to home.</em></h1>
      <p>Pair this browser with the independently running local service. Your artwork and records stay in a private profile on this machine; no cloud account is needed.</p>
      <p>01 · Start the service with <code>corepack pnpm start</code> in a terminal.</p>
      <p>02 · In another terminal run <code>corepack pnpm pair</code> to request a one-time code.</p>
      <form onsubmit={pair}><label for="pair-code">ONE-TIME PAIRING CODE</label><div class="pair-row"><input id="pair-code" name="pair-code" type="password" autocomplete="off" spellcheck="false" bind:value={pairingCode} placeholder="Paste the code from your terminal" required /><button type="submit" disabled={busy || !pairingCode.trim()}>Pair browser</button></div></form>
    </section>{#if message}<p class="pair-notice" role="alert">{message}</p>{/if}<footer>LOCAL FIRST, BY DESIGN. · ASSETWEAVE / PRIVATE CONNECTION</footer></main>
  </div>
{/if}

<style>
  :global(body) { margin:0; font-family:'Segoe UI', Inter, system-ui, sans-serif; }
  :global(button),:global(input) { font:inherit; }
  .pair-frame { min-height:100vh; background:radial-gradient(ellipse 55% 75% at 85% 85%, #1b3734 0%, transparent 82%), #111b20; color:#edf1e9; }
  .pair-topbar { display:flex; align-items:center; gap:12px; padding:28px clamp(18px,4vw,48px); max-width:1280px; margin:auto; border-bottom:1px solid #334147; }
  .pair-mark { border:1px solid #cfaa77; color:#f3c995; padding:7px; border-radius:5px; font:15px Georgia,serif; }
  .pair-local { margin-left:auto; color:#abb8b5; font-size:11px; font-weight:700; letter-spacing:.14em; }
  .pair-main { max-width:950px; margin:auto; padding:clamp(45px,8vw,105px) 18px 28px; }
  .pair-kicker,.pair-status,.pair-panel label,footer { font-size:11px; font-weight:700; letter-spacing:.14em; }
  .pair-kicker { color:#c2a075; }.pair-status { color:#a5d5ad; }
  .pair-panel { background:#19262a; border:1px solid #465555; border-radius:10px; padding:clamp(25px,5vw,60px); box-shadow:0 24px 80px #07131366; }
  .pair-panel h1 { font:normal clamp(39px,6vw,69px)/1.08 Georgia,serif; letter-spacing:-.05em; margin:25px 0; }.pair-panel h1 em { color:#edbd78; }
  .pair-panel p { max-width:650px; color:#c4d1cc; line-height:1.6; }.pair-panel code { color:#edbd78; overflow-wrap:anywhere; }
  .pair-panel form { border-top:1px solid #354549; margin-top:25px; padding-top:25px; display:grid; gap:10px; }
  .pair-row { display:flex; gap:10px; }.pair-row input { flex:1; min-width:0; min-height:50px; background:#101a1e; color:#fff; border:1px solid #576765; border-radius:5px; padding:0 15px; }
  .pair-row button { min-height:50px; background:#edbd78; border:1px solid #edbd78; border-radius:5px; color:#162321; font-weight:700; padding:0 20px; cursor:pointer; }
  .pair-row button:disabled { opacity:.48; }.pair-notice { padding:14px; background:#412d2b; color:#f3c5a8; border:1px solid #a86953; border-radius:5px; }
  .pair-frame :is(button,input):focus-visible { outline:2px solid #edbd78; outline-offset:3px; }
  .pair-main footer { color:#859993; margin-top:25px; }
  .content-heading { margin-bottom:12px; }.content-heading h1 { margin:4px 0; }.content-heading p { margin-top:6px; }
  .selection-callout { background:var(--selection-fill); color:var(--selection-ink); border-radius:8px; padding:11px 14px; margin:12px 0; line-height:1.5; overflow-wrap:anywhere; }
  .content-head { margin-bottom:14px; }.load-more { margin-top:16px; }
  .nav-footnote { font-size:12px; color:var(--muted); line-height:1.5; margin:24px 10px; }
  .inspector-form { display:grid; gap:8px; border-top:1px solid var(--line); padding-top:14px; margin-top:18px; }
  .inspector-form label { display:grid; gap:5px; }.inspector-form button { justify-self:start; }
  .text-hits { margin-top:28px; padding-top:16px; border-top:1px solid var(--line); }
  .text-hits > p { margin:5px 0 12px; }.text-hit { display:grid; width:100%; min-width:0; gap:5px; margin:5px 0; padding:10px; text-align:left; color:var(--text); background:var(--surface); border:0; border-radius:6px; overflow-wrap:anywhere; }
  .text-hit:hover { background:var(--surface-raised); }.text-hit span { font-size:13px; }.text-hit small { color:var(--muted); }
  .revision-body { white-space:pre-wrap; overflow-wrap:anywhere; max-width:100%; padding:10px; background:var(--canvas); border-radius:6px; font-size:12px; }
  .error { color:var(--status-rejected-ink); }.quiet { color:var(--text); background:transparent; border:1px solid var(--control-line); border-radius:6px; padding:6px 10px; cursor:pointer; }
  .quiet:hover { border-color:var(--accent); }.text-link { color:var(--accent-ink); background:transparent; border:0; text-decoration:underline; padding:0; cursor:pointer; overflow-wrap:anywhere; }
  @media(max-width:620px) { .pair-row { flex-direction:column; }.pair-local { font-size:0; }.pair-main { padding-inline:14px; } }
</style>
