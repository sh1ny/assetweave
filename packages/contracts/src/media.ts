import type { StoredMember } from './capture.js';

/** Inspection limits apply to every supported image; originals can exceed these bounds and remain preserved. */
export const mediaLimits = {
  maxDimension: 8192,
  maxFrames: 64,
  maxFramePixels: 4_194_304,
  maxDecodedPixels: 16_777_216,
  maxPendingInspections: 16,
  maxConcurrentInspections: 2,
  deadlineMs: 8_000,
  sharpTimeoutSeconds: 7,
} as const;

export interface GifFrameControl {
  /** Null means no encoded Graphic Control Extension precedes the frame. Zero is encoded zero. */
  delayCentiseconds: number | null;
  disposal: number | null;
}
export type EncodedTiming =
  | { status: 'known'; source: 'gif-control-blocks'; durationsMs: number[]; cumulativeMs: number[]; cycleMs: number; framesPerSecond: number | null }
  | { status: 'unknown'; source: 'gif-control-blocks'; reason: 'missing-or-zero-delay'; controls: GifFrameControl[] };
export interface MediaMember {
  member: StoredMember;
  format: 'png' | 'gif' | 'opaque';
  preview: 'available' | 'unavailable';
  /** Opaque originals stay downloadable even though they cannot be displayed inline. */
  reason: 'unsupported' | 'missing-or-corrupt' | 'invalid-image' | 'decode-limit' | null;
  width: number | null;
  height: number | null;
  frameCount: number | null;
  encodedTiming: EncodedTiming | null;
  /** Browser GIF disposal is preserved by serving the exact original, never re-encoding it. */
  gifControls: GifFrameControl[] | null;
  previewUrl: string | null;
  originalUrl: string;
}
/** Card eligibility stops at the first previewable member; it does not certify whole-artwork availability. */
export interface MediaThumbnail { previewUrl: string | null }

export interface MediaDescription {
  artifactId: string;
  kind: string;
  content: 'available' | 'unavailable';
  /** Unconfigured is explicit: a still PNG sheet or a sequence without a sourced clip has no invented rate. */
  playback: 'encoded' | 'configured' | 'unconfigured' | 'unavailable';
  members: MediaMember[];
}
