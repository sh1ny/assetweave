import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlaybackRevision } from '@assetweave/contracts/playback';
import { frameSource, hasValidTimeline, parseOrderedIntegers, playbackPosition } from './playback.js';

const revision: PlaybackRevision = {
  id: 'revision', clipId: 'clip', artifactId: 'artifact', revision: 1,
  description: {
    geometry: { kind: 'grid', memberOrdinal: 0, cellWidth: 7, cellHeight: 11,
      columns: 3, rows: 2, offsetX: 4, offsetY: 6, gapX: 2, gapY: 3 },
    frames: [5, 1, 3], durationsMs: [90, 210, 50], source: { kind: 'human supplied' },
  },
  cumulativeMs: [90, 300, 350], cycleMs: 350, framesPerSecond: null,
  actor: 'browser', at: '2026-09-29T00:00:00Z', memberPreviewUrls: [{ ordinal: 0, url: '/api/clip-preview' }],
};

test('variable frame durations have exact boundaries and loop against elapsed clock, not tick count', () => {
  assert.equal(hasValidTimeline(revision), true);
  const cases: Array<readonly [elapsed: number, index: number, remaining: number]> = [
    [0, 0, 90], [89, 0, 1], [90, 1, 210], [299, 1, 1], [300, 2, 50],
    [349, 2, 1], [350, 0, 90], [350 * 137 + 301, 2, 49],
  ];
  for (const [elapsed, index, remaining] of cases) {
    const position = playbackPosition(revision.cumulativeMs, revision.cycleMs, elapsed);
    assert.equal(position?.index, index, `frame for elapsed ${elapsed}`);
    assert.equal(position?.untilNextFrameMs, remaining, `next boundary for elapsed ${elapsed}`);
  }
});

test('grid extraction follows nonlexical clip order, row-major geometry, offsets and gaps', () => {
  assert.deepEqual(revision.description.frames.map((_, index) => frameSource(revision.description, index)), [
    { memberOrdinal: 0, x: 22, y: 20, width: 7, height: 11 },
    { memberOrdinal: 0, x: 13, y: 6, width: 7, height: 11 },
    { memberOrdinal: 0, x: 4, y: 20, width: 7, height: 11 },
  ]);
});

test('sequence frame indices resolve captured ordinals in recorded playback order, including repetition', () => {
  const description = {
    ...revision.description, geometry: { kind: 'sequence' as const, width: 20, height: 24 },
    frames: [2, 0, 2, 1], durationsMs: [60, 110, 40, 90],
  };
  assert.deepEqual(description.frames.map((_, index) => frameSource(description, index)?.memberOrdinal), [2, 0, 2, 1]);
  assert.deepEqual(frameSource(description, 1), { memberOrdinal: 0, x: 0, y: 0, width: 20, height: 24 });
});

test('unknown or malformed timing cannot be interpreted as a playback clock', () => {
  assert.equal(hasValidTimeline({ ...revision, cumulativeMs: [90, 300, 349] }), false);
  assert.equal(hasValidTimeline({ ...revision, description: { ...revision.description, durationsMs: [90, 0, 260] } }), false);
  assert.equal(playbackPosition([], 0, 0), null);
  assert.equal(playbackPosition(revision.cumulativeMs, revision.cycleMs, Number.NaN), null);
});

test('ordered lists reject missing entries and invalid numbers without inventing defaults', () => {
  assert.deepEqual(parseOrderedIntegers(' 10, 2\n0, 2 ', 0), [10, 2, 0, 2]);
  assert.deepEqual(parseOrderedIntegers('100 250, 50', 1), [100, 250, 50]);
  for (const text of ['', ' ', '1,', '-1', '1.5', '0, 20', '1,NaN', '999999999999999999999999999']) {
    assert.equal(parseOrderedIntegers(text, 1), null, text);
  }
});
