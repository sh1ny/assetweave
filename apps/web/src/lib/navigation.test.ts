import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { navigationHref, parseNavigation, patchNavigation } from './navigation.js';

test('opening a different viewed artifact preserves the filtered slot URL for Back', () => {
  const projectId = randomUUID();
  const assetId = randomUUID();
  const slotId = randomUUID();
  const artifactId = randomUUID();
  const before = {
    projectId, assetId, slotId,
    filters: { projectIds: [projectId], reviews: ['rejected' as const], unslotted: true },
    text: 'draft texture', scope: 'history' as const,
  };
  const slotHref = navigationHref(before);
  const opened = patchNavigation(parseNavigation(slotHref), { artifactId, tab: 'history' });
  const viewedHref = navigationHref(opened);

  assert.equal(parseNavigation(viewedHref).artifactId, artifactId);
  assert.deepEqual(parseNavigation(viewedHref).filters, before.filters);
  assert.equal(parseNavigation(viewedHref).scope, 'history');
  assert.deepEqual(parseNavigation(slotHref), before);
  assert.equal(new URL(viewedHref, 'http://local.test').searchParams.get('slotId'), slotId);
});

test('malformed identities and filters do not replace valid deep-link context', () => {
  const projectId = randomUUID();
  const artifactId = randomUUID();
  const params = new URLSearchParams({ projectId, assetId: '../escape', artifactId,
    revisionId: `${artifactId}:0`, filters: '{"reviews":["invented"]}',
    scope: 'wrong', tab: '<script>', unrelated: 'ignored' });
  assert.deepEqual(parseNavigation(`/?${params}`), { projectId, artifactId });
});

test('links use only canonical keys, retain revision identity, and never imply a decision', () => {
  const artifactId = randomUUID();
  const candidateId = randomUUID();
  const revisionId = `${artifactId}:2`;
  const href = navigationHref({ artifactId, candidateId, revisionId, filters: { selection: ['not-selected'] } });
  const url = new URL(href, 'http://local.test');
  assert.equal(url.pathname, '/');
  assert.deepEqual([...url.searchParams.keys()], ['artifactId', 'candidateId', 'revisionId', 'filters']);
  assert.deepEqual(parseNavigation(href), { artifactId, candidateId, revisionId,
    filters: { selection: ['not-selected'] } });
});
