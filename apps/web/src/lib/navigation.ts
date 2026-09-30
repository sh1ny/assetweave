import { catalogId } from '@assetweave/contracts/catalog';
import { artifactFilters, revisionKey, type SearchInput } from '@assetweave/contracts/queries';

/** URL state is browsing context only; selection and review are server decisions. */
export interface NavigationState {
  projectId?: string;
  assetId?: string;
  slotId?: string;
  artifactId?: string;
  candidateId?: string;
  clipId?: string;
  requestId?: string;
  revisionId?: string;
  filters?: SearchInput['filters'];
  text?: string;
  scope?: 'current' | 'history';
  tab?: string;
}

const ids = ['projectId', 'assetId', 'slotId', 'artifactId', 'candidateId', 'clipId', 'requestId', 'revisionId'] as const;
const tabName = /^[a-z][a-z0-9-]{0,39}$/u;

function validId(key: typeof ids[number], value: string): boolean {
  return (key === 'revisionId' ? revisionKey : catalogId).safeParse(value).success;
}

/** Discard unknown query keys and invalid values, while preserving valid deep-link context. */
export function parseNavigation(input: string | URL = window.location.href): NavigationState {
  const params = new URL(input, 'http://localhost').searchParams;
  const state: NavigationState = {};
  for (const key of ids) {
    const value = params.get(key);
    if (value && validId(key, value)) state[key] = value;
  }
  const rawFilters = params.get('filters');
  if (rawFilters !== null) {
    try {
      const filters: unknown = JSON.parse(rawFilters);
      const parsed = artifactFilters.safeParse(filters);
      if (parsed.success) state.filters = parsed.data;
    } catch { /* An invalid bookmark must not block the rest of the link. */ }
  }
  const text = params.get('text');
  if (text?.trim()) state.text = text;
  const scope = params.get('scope');
  if (scope === 'current' || scope === 'history') state.scope = scope;
  const tab = params.get('tab');
  if (tab && tabName.test(tab)) state.tab = tab;
  return state;
}

/** Canonical root URL, independent of pairing and without any mutation semantics. */
export function navigationHref(state: NavigationState): string {
  const params = new URLSearchParams();
  for (const key of ids) {
    const value = state[key];
    if (value && validId(key, value)) params.set(key, value);
  }
  if (state.filters) {
    const parsed = artifactFilters.safeParse(state.filters);
    if (parsed.success) params.set('filters', JSON.stringify(parsed.data));
  }
  if (state.text?.trim()) params.set('text', state.text);
  if (state.scope === 'current' || state.scope === 'history') params.set('scope', state.scope);
  if (state.tab && tabName.test(state.tab)) params.set('tab', state.tab);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

/** Undefined in a patch clears only that field; all other context survives opening a record. */
export function patchNavigation(current: NavigationState, patch: Partial<NavigationState>): NavigationState {
  const next = { ...current, ...patch };
  for (const key of Object.keys(next) as (keyof NavigationState)[]) {
    if (next[key] === undefined) delete next[key];
  }
  return next;
}

/** Updating history does not fire popstate: callers update their own state on push/replace. */
export function pushNavigation(state: NavigationState): void {
  window.history.pushState(null, '', navigationHref(state));
}

export function replaceNavigation(state: NavigationState): void {
  window.history.replaceState(null, '', navigationHref(state));
}

/** The caller's popstate listener restores the previous URL's filters and slot context. */
export function backNavigation(): void {
  window.history.back();
}
