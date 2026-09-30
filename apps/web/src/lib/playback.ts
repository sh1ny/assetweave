import type { PlaybackDescription, PlaybackRevision } from '@assetweave/contracts/playback';

/** The server's immutable revision supplies both the ordered frames and cumulative boundaries. */
export function hasValidTimeline(revision: PlaybackRevision): boolean {
  const { frames, durationsMs } = revision.description;
  if (!frames.length || frames.length !== durationsMs.length || revision.cumulativeMs.length !== frames.length ||
      !Number.isSafeInteger(revision.cycleMs) || revision.cycleMs <= 0) return false;
  let sum = 0;
  for (let index = 0; index < durationsMs.length; index++) {
    const duration = durationsMs[index];
    if (duration === undefined || !Number.isSafeInteger(duration) || duration <= 0) return false;
    sum += duration;
    if (revision.cumulativeMs[index] !== sum) return false;
  }
  return sum === revision.cycleMs;
}

export interface PlaybackPosition {
  /** Position in the recorded clip order, not a grid cell index or a filename index. */
  index: number;
  elapsedInCycleMs: number;
  untilNextFrameMs: number;
}

/** Exact boundaries: frame N begins at the cumulative end of frame N-1. */
export function playbackPosition(cumulativeMs: readonly number[], cycleMs: number, elapsedMs: number): PlaybackPosition | null {
  if (!cumulativeMs.length || !Number.isFinite(elapsedMs) || !Number.isFinite(cycleMs) || cycleMs <= 0) return null;
  const elapsedInCycleMs = Math.max(0, elapsedMs) % cycleMs;
  let low = 0;
  let high = cumulativeMs.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (elapsedInCycleMs < cumulativeMs[middle]!) high = middle;
    else low = middle + 1;
  }
  const boundary = cumulativeMs[low]!;
  if (!(boundary > elapsedInCycleMs)) return null;
  return { index: low, elapsedInCycleMs, untilNextFrameMs: boundary - elapsedInCycleMs };
}

export interface FrameSource { memberOrdinal: number; x: number; y: number; width: number; height: number }

/** Grid indices are row-major; sequence indices are captured member ordinals, never filename order. */
export function frameSource(description: PlaybackDescription, index: number): FrameSource | null {
  const frame = description.frames[index];
  if (frame === undefined || !Number.isSafeInteger(frame) || frame < 0) return null;
  const geometry = description.geometry;
  if (geometry.kind === 'sequence') return {
    memberOrdinal: frame, x: 0, y: 0, width: geometry.width, height: geometry.height,
  };
  if (frame >= geometry.columns * geometry.rows) return null;
  return {
    memberOrdinal: geometry.memberOrdinal,
    x: (geometry.offsetX ?? 0) + (frame % geometry.columns) * (geometry.cellWidth + (geometry.gapX ?? 0)),
    y: (geometry.offsetY ?? 0) + Math.floor(frame / geometry.columns) * (geometry.cellHeight + (geometry.gapY ?? 0)),
    width: geometry.cellWidth, height: geometry.cellHeight,
  };
}

/** Empty and malformed fields are errors, not implicit frame 0 or an assumed FPS. */
export function parseOrderedIntegers(text: string, minimum: number): number[] | null {
  const trimmed = text.trim();
  if (!trimmed || !/^\d+(?:[\s,]+\d+)*$/u.test(trimmed)) return null;
  const values = trimmed.split(/[\s,]+/u).map(Number);
  return values.every(value => Number.isSafeInteger(value) && value >= minimum) ? values : null;
}
