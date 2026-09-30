import { Injectable, ServiceUnavailableException, NotFoundException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import sharp from 'sharp';
import type { StoredMember } from '@assetweave/contracts/capture';
import { mediaLimits, type EncodedTiming, type MediaDescription, type MediaMember, type MediaThumbnail } from '@assetweave/contracts/media';
import { CaptureService } from '../capture/capture.service.js';
import { ContentStore } from '../capture/content-store.js';
import { DatabaseService } from '../database/database.service.js';
import { gifControls, type GifControls } from './gif-controls.js';

class DecodeLimit extends Error {}
class InvalidImage extends Error {}
type ImageDetails = Pick<MediaMember, 'width' | 'height' | 'frameCount' | 'encodedTiming' | 'gifControls'>;

function inferFormat(bytes: Buffer, member: StoredMember): MediaMember['format'] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (member.mediaType === 'image/png' || /\.png$/iu.test(member.sourceName)) return 'png';
  if (member.mediaType === 'image/gif' || /\.gif$/iu.test(member.sourceName)) return 'gif';
  return 'opaque';
}
function uniformFps(durations: readonly number[]): number | null {
  return durations.every(duration => duration === durations[0]) ? 1000 / durations[0]! : null;
}
function timing(controls: GifControls['frames']): EncodedTiming {
  if (controls.some(control => control.delayCentiseconds === null || control.delayCentiseconds === 0)) {
    return { status: 'unknown', source: 'gif-control-blocks', reason: 'missing-or-zero-delay', controls };
  }
  const durationsMs = controls.map(control => control.delayCentiseconds! * 10);
  let total = 0;
  const cumulativeMs = durationsMs.map(duration => total += duration);
  return { status: 'known', source: 'gif-control-blocks', durationsMs, cumulativeMs, cycleMs: total,
    framesPerSecond: uniformFps(durationsMs) };
}
function invalid(message: string): never { throw new BadRequestException({ code: 'INVALID_REQUEST', message }); }
function unavailable(): never {
  throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE', message: 'Captured media is unavailable.' });
}

@Injectable()
export class MediaService {
  private active = 0;
  private readonly pending: Array<() => void> = [];
  /** Only fully decoded, content-addressed results are cached. Every read still verifies immutable bytes. */
  private readonly validated = new Map<string, { format: 'png' | 'gif'; details: ImageDetails }>();
  constructor(private readonly capture: CaptureService, private readonly content: ContentStore,
    private readonly database: DatabaseService) {}

  /** A timed-out caller never releases its native decode slot until the native operation actually settles. */
  private async bounded<T>(action: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + mediaLimits.deadlineMs;
    if (this.active >= mediaLimits.maxConcurrentInspections) {
      if (this.pending.length >= mediaLimits.maxPendingInspections) throw new DecodeLimit('Media inspection queue is full.');
      await new Promise<void>((resolve, reject) => {
        const grant = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this.pending.indexOf(grant);
          if (index !== -1) this.pending.splice(index, 1);
          reject(new DecodeLimit('Media inspection queue deadline expired.'));
        }, mediaLimits.deadlineMs);
        this.pending.push(grant);
      });
    } else this.active++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) { this.release(); throw new DecodeLimit('Media inspection deadline expired.'); }
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.resolve().then(action);
    void work.then(() => this.release(), () => this.release());
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DecodeLimit('Media inspection deadline expired.')), remaining);
      })]);
    } finally { clearTimeout(timer); }
  }
  private release(): void {
    const next = this.pending.shift();
    if (next) next();
    else this.active--;
  }

  private async inspect(bytes: Buffer, format: 'png' | 'gif', remainingPixels: number): Promise<ImageDetails> {
    return this.bounded(async () => {
      const controls = format === 'gif' ? gifControls(bytes) : null;
      const image = sharp(bytes, { animated: true, pages: -1, limitInputPixels: mediaLimits.maxFramePixels,
        failOn: 'error', unlimited: false }).timeout({ seconds: mediaLimits.sharpTimeoutSeconds });
      const metadata = await image.metadata();
      const count = metadata.pages ?? 1;
      const width = metadata.width;
      const frameHeight = metadata.pageHeight ?? metadata.height;
      if (metadata.format !== format || !Number.isSafeInteger(width) || !Number.isSafeInteger(frameHeight) ||
          !Number.isSafeInteger(count) || !width || !frameHeight || count < 1 ||
          width > mediaLimits.maxDimension || frameHeight > mediaLimits.maxDimension ||
          count > mediaLimits.maxFrames || width * frameHeight > mediaLimits.maxFramePixels ||
          width * frameHeight * count > remainingPixels ||
          (format === 'png' && count !== 1) ||
          (format === 'gif' && (count !== controls!.frames.length || width !== controls!.width ||
            frameHeight !== controls!.height))) throw new DecodeLimit('Media dimensions or frame count exceed supported bounds.');
      // Force native decoding of the complete image, including later GIF frames. Header-only metadata is insufficient.
      const { info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
      if (info.width !== width || info.height !== frameHeight * count || (count !== 1 && info.pages !== count)) {
        throw new InvalidImage('Full decode does not match inspected frames.');
      }
      return { width, height: frameHeight, frameCount: count,
        encodedTiming: controls ? timing(controls.frames) : null, gifControls: controls?.frames ?? null };
    });
  }

  private async readBytes(artifactId: string, member: StoredMember): Promise<Buffer> {
    const handle = await open(await this.content.memberPath(artifactId, member), 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.size !== member.byteCount) throw new InvalidImage('Content changed after verification.');
      const bytes = await handle.readFile();
      if (bytes.length !== member.byteCount || createHash('sha256').update(bytes).digest('hex') !== member.sha256) {
        throw new InvalidImage('Content changed after verification.');
      }
      return bytes;
    } finally { await handle.close(); }
  }

  private async member(artifactId: string, member: StoredMember, remainingPixels: number,
    verifiedBytes?: Buffer): Promise<MediaMember> {
    const originalUrl = `/api/artifacts/${artifactId}/members/${member.ordinal}/original`;
    const base = { member, originalUrl, width: null, height: null, frameCount: null,
      encodedTiming: null, gifControls: null, previewUrl: null };
    try {
      const cached = this.validated.get(member.sha256);
      if (cached) {
        const { format, details } = cached;
        if (details.width! * details.height! * details.frameCount! > remainingPixels) {
          return { ...base, format, preview: 'unavailable', reason: 'decode-limit' };
        }
        return { ...base, ...details, format, preview: 'available', reason: null,
          previewUrl: `/api/artifacts/${artifactId}/media/members/${member.ordinal}` };
      }
      const bytes = verifiedBytes ?? await this.readBytes(artifactId, member);
      const format = inferFormat(bytes, member);
      if (format === 'opaque') return { ...base, format, preview: 'unavailable', reason: 'unsupported' };
      try {
        const details = await this.inspect(bytes, format, remainingPixels);
        if (this.validated.size >= 256) this.validated.delete(this.validated.keys().next().value!);
        this.validated.set(member.sha256, { format, details });
        return { ...base, ...details, format, preview: 'available', reason: null,
          previewUrl: `/api/artifacts/${artifactId}/media/members/${member.ordinal}` };
      } catch (error) {
        return { ...base, format, preview: 'unavailable', reason: error instanceof DecodeLimit ? 'decode-limit' : 'invalid-image' };
      }
    } catch {
      return { ...base, format: member.mediaType === 'image/png' ? 'png' : member.mediaType === 'image/gif' ? 'gif' : 'opaque',
        preview: 'unavailable', reason: 'missing-or-corrupt' };
    }
  }

  async describe(artifactId: string): Promise<MediaDescription> {
    const record = await this.capture.getArtifact(artifactId);
    const members: MediaMember[] = [];
    if (record.content === 'available') {
      let remainingPixels: number = mediaLimits.maxDecodedPixels;
      for (const member of record.members) {
        const inspected = await this.member(record.id, member, remainingPixels);
        members.push(inspected);
        if (inspected.preview === 'available') remainingPixels -= inspected.width! * inspected.height! * inspected.frameCount!;
      }
    } else for (const member of record.members) {
      members.push({ member, format: member.mediaType === 'image/png' ? 'png' : member.mediaType === 'image/gif' ? 'gif' : 'opaque',
        preview: 'unavailable', reason: 'missing-or-corrupt', width: null, height: null, frameCount: null,
        encodedTiming: null, gifControls: null, previewUrl: null,
        originalUrl: `/api/artifacts/${record.id}/members/${member.ordinal}/original` });
    }
    const gif = members[0]?.format === 'gif' && members[0].preview === 'available' &&
      members[0].encodedTiming?.status === 'known';
    const clip = this.database.connection.prepare('SELECT 1 FROM clips WHERE artifact_id = ? LIMIT 1').get(record.id);
    return { artifactId: record.id, kind: record.kind, content: record.content,
      playback: clip && (record.content === 'unavailable' || members.some(member => member.preview !== 'available'))
        ? 'unavailable' : gif ? 'encoded' : clip ? 'configured' : 'unconfigured', members };
  }

  /** Cards need only the first eligible still, not an inspection of every frame in an unopened artwork. */
  async thumbnail(artifactId: string): Promise<MediaThumbnail> {
    const record = await this.capture.getArtifact(artifactId, 'metadata');
    if (record.content !== 'available') return { previewUrl: null };
    // The capture schema bounds the member count; stop as soon as one still qualifies.
    for (let index = 0; index < record.members.length; index++) {
      const member = record.members[index]!;
      try {
        const bytes = await this.readBytes(record.id, member);
        const inspected = await this.member(record.id, member, mediaLimits.maxDecodedPixels, bytes);
        if (inspected.preview === 'available') return { previewUrl: inspected.previewUrl };
      } catch { /* A broken member cannot qualify another one by pretending to be a still. */ }
    }
    return { previewUrl: null };
  }

  /** Returns verified original bytes, not a path which can be substituted between validation and response. */
  async preview(artifactId: string, ordinal: number, revisionId?: string): Promise<{ bytes: Buffer; mime: 'image/png' | 'image/gif' }> {
    if (revisionId) {
      const revision = this.database.connection.prepare('SELECT artifact_id AS artifactId, geometry_json AS geometryJson, frames_json AS framesJson FROM playback_revisions WHERE id = ?')
        .get(revisionId) as { artifactId: string; geometryJson: string; framesJson: string } | undefined;
      if (!revision || revision.artifactId !== artifactId) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Playback revision was not found.' });
      const geometry = JSON.parse(revision.geometryJson) as { kind: 'grid' | 'sequence'; memberOrdinal?: number };
      if (geometry.kind === 'grid' ? geometry.memberOrdinal !== ordinal : !(JSON.parse(revision.framesJson) as number[]).includes(ordinal)) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Member does not belong to this playback revision.' });
      }
    }
    const record = await this.capture.getArtifact(artifactId, 'metadata');
    if (record.content !== 'available') unavailable();
    const requested = record.members[ordinal];
    if (!requested || requested.ordinal !== ordinal) invalid('Invalid media member ordinal.');
    // Standalone preview URLs preserve /media's aggregate limit. A pinned revision was
    // validated against the complete capture when recorded and fetches only its own member.
    let remainingPixels: number = mediaLimits.maxDecodedPixels;
    if (!revisionId) {
      for (let index = 0; index < ordinal; index++) {
        const member = record.members[index]!;
        try {
          // A cached decode is not evidence that this predecessor still contributes to today's budget.
          const bytes = await this.readBytes(record.id, member);
          const prior = await this.member(record.id, member, remainingPixels, bytes);
          if (prior.preview === 'available') remainingPixels -= prior.width! * prior.height! * prior.frameCount!;
        } catch { /* Missing or substituted predecessors contribute no verified pixels. */ }
      }
    }
    try {
      const bytes = await this.readBytes(record.id, requested);
      const inspected = await this.member(record.id, requested, remainingPixels, bytes);
      if (inspected.preview !== 'available') unavailable();
      return { bytes, mime: inspected.format === 'png' ? 'image/png' : 'image/gif' };
    } catch { return unavailable(); }
  }
}
