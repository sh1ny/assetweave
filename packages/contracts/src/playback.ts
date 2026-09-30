import * as z from 'zod';
import { catalogId } from './catalog.js';
import { mediaLimits } from './media.js';

const dimension = z.number().int().positive().max(mediaLimits.maxDimension);
const frame = z.number().int().nonnegative().max(127);
const sourcedBy = z.strictObject({
  kind: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(16_384).optional(),
});
const grid = z.strictObject({
  kind: z.literal('grid'), memberOrdinal: frame,
  cellWidth: dimension, cellHeight: dimension,
  columns: z.number().int().positive().max(mediaLimits.maxFrames),
  rows: z.number().int().positive().max(mediaLimits.maxFrames),
  offsetX: z.number().int().nonnegative().max(mediaLimits.maxDimension).optional(),
  offsetY: z.number().int().nonnegative().max(mediaLimits.maxDimension).optional(),
  gapX: z.number().int().nonnegative().max(mediaLimits.maxDimension).optional(),
  gapY: z.number().int().nonnegative().max(mediaLimits.maxDimension).optional(),
});
const sequence = z.strictObject({ kind: z.literal('sequence'), width: dimension, height: dimension });
export const playbackDescription = z.strictObject({
  geometry: z.discriminatedUnion('kind', [grid, sequence]),
  /** Grid frame numbers are row-major cell indices. Sequence numbers are captured member ordinals. */
  frames: z.array(frame).min(1).max(mediaLimits.maxFrames),
  durationsMs: z.array(z.number().int().positive().max(60_000)).min(1).max(mediaLimits.maxFrames),
  source: sourcedBy,
}).superRefine((value, context) => {
  if (value.frames.length !== value.durationsMs.length) {
    context.addIssue({ code: 'custom', path: ['durationsMs'], message: 'Each ordered frame needs one positive duration.' });
  }
  if (value.durationsMs.reduce((sum, duration) => sum + duration, 0) > 3_600_000) {
    context.addIssue({ code: 'custom', path: ['durationsMs'], message: 'A clip cycle must not exceed one hour.' });
  }
});
export const createClipInput = playbackDescription.safeExtend({ name: z.string().trim().min(1).max(200) });
export const correctPlaybackInput = playbackDescription.safeExtend({ expectedRevision: z.number().int().positive() });
export const clipId = catalogId;
export type PlaybackDescription = z.output<typeof playbackDescription>;
export type CreateClipInput = z.output<typeof createClipInput>;
export type CorrectPlaybackInput = z.output<typeof correctPlaybackInput>;
export interface PlaybackRevision {
  id: string; clipId: string; artifactId: string; revision: number;
  description: PlaybackDescription;
  /** Derived from the recorded ordered durations; absolute boundaries for a canvas scheduler. */
  cumulativeMs: number[]; cycleMs: number; framesPerSecond: number | null;
  actor: string; at: string;
  /** A revision-scoped URL cannot silently switch to the next correction. */
  memberPreviewUrls: { ordinal: number; url: string }[];
}
export interface ClipRecord {
  id: string; artifactId: string; name: string; revision: number;
  currentRevisionId: string; current: PlaybackRevision;
  createdAt: string;
}
export interface ClipHistory { clip: ClipRecord; revisions: PlaybackRevision[] }
