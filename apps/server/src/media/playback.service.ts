import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeSlotName } from '@assetweave/contracts/catalog';
import { mediaLimits, type MediaDescription } from '@assetweave/contracts/media';
import { playbackDescription, type ClipRecord, type CorrectPlaybackInput,
  type CreateClipInput, type PlaybackDescription, type PlaybackRevision } from '@assetweave/contracts/playback';
import type { PageInput, QueryPage } from '@assetweave/contracts/queries';
import { DatabaseService } from '../database/database.service.js';
import { requireArtifact } from '../lineage/lineage.service.js';
import { paginate } from '../queries/pagination.js';
import { MediaService } from './media.service.js';

interface ClipRow { id: string; artifactId: string; name: string; revision: number; currentRevisionId: string; createdAt: string }
interface RevisionRow {
  id: string; clipId: string; artifactId: string; revision: number; geometryJson: string; framesJson: string;
  timingJson: string; sourceKind: string; sourceDetail: string | null; actor: string; at: string;
}
const revisionColumns = `r.id, r.clip_id AS clipId, r.artifact_id AS artifactId, r.revision,
  r.geometry_json AS geometryJson, r.frames_json AS framesJson, r.timing_json AS timingJson,
  r.source_kind AS sourceKind, r.source_detail AS sourceDetail, a.actor, a.recorded_at AS at`;
const clipColumns = 'id, artifact_id AS artifactId, name, revision, current_revision_id AS currentRevisionId, created_at AS createdAt';

function invalid(message: string): never { throw new BadRequestException({ code: 'INVALID_REQUEST', message }); }
function revisionFromRow(row: RevisionRow): PlaybackRevision {
  const frames = JSON.parse(row.framesJson) as PlaybackDescription['frames'];
  const durationsMs = JSON.parse(row.timingJson) as number[];
  const geometry = JSON.parse(row.geometryJson) as PlaybackDescription['geometry'];
  let cycleMs = 0;
  const cumulativeMs = durationsMs.map(duration => cycleMs += duration);
  const memberOrdinals = geometry.kind === 'grid' ? [geometry.memberOrdinal] : [...new Set(frames)];
  return { id: row.id, clipId: row.clipId, artifactId: row.artifactId, revision: row.revision,
    description: { geometry, frames, durationsMs,
      source: { kind: row.sourceKind, ...(row.sourceDetail === null ? {} : { detail: row.sourceDetail }) } },
    cumulativeMs, cycleMs, framesPerSecond: durationsMs.every(duration => duration === durationsMs[0]) ? 1000 / durationsMs[0]! : null,
    actor: row.actor, at: row.at,
    memberPreviewUrls: memberOrdinals.map(ordinal => ({ ordinal,
      url: `/api/playback-revisions/${row.id}/members/${ordinal}/preview` })) };
}

@Injectable()
export class PlaybackService {
  constructor(private readonly database: DatabaseService, private readonly media: MediaService) {}

  private clipRow(id: string, connection = this.database.connection): ClipRow {
    const row = connection.prepare(`SELECT ${clipColumns} FROM clips WHERE id = ?`).get(id) as ClipRow | undefined;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Clip was not found.' });
    return row;
  }
  getRevision(id: string, connection = this.database.connection): PlaybackRevision {
    const row = connection.prepare(`SELECT ${revisionColumns} FROM playback_revisions r
      JOIN audit_events a ON a.id = r.audit_event_id WHERE r.id = ?`).get(id) as RevisionRow | undefined;
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Playback revision was not found.' });
    return revisionFromRow(row);
  }
  private fromRow(row: ClipRow, connection = this.database.connection): ClipRecord {
    return { ...row, current: this.getRevision(row.currentRevisionId, connection) };
  }
  getClip(id: string): ClipRecord { return this.fromRow(this.clipRow(id)); }
  listClips(artifactId: string, input: PageInput): QueryPage<ClipRecord> {
    requireArtifact(this.database.connection, artifactId);
    return paginate(this.database, input, ['artifacts', artifactId, 'clips'], (after, count) => {
      const rows = this.database.connection.prepare(`SELECT ${clipColumns} FROM clips
        WHERE artifact_id = ? ${after ? 'AND (name > ? OR (name = ? AND id > ?))' : ''}
        ORDER BY name, id LIMIT ?`)
        .all(artifactId, ...(after ? [after[0]!, after[0]!, after[1]!] : []), count) as unknown as ClipRow[];
      if (!rows.length) return [];
      const revisionIds = rows.map(row => row.currentRevisionId);
      const revisions = this.database.connection.prepare(`SELECT ${revisionColumns} FROM playback_revisions r
        JOIN audit_events a ON a.id = r.audit_event_id
        WHERE r.id IN (${revisionIds.map(() => '?').join(', ')})`)
        .all(...revisionIds) as unknown as RevisionRow[];
      const byId = new Map(revisions.map(row => [row.id, row]));
      return rows.map(row => {
        const revision = byId.get(row.currentRevisionId);
        if (!revision) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Playback revision was not found.' });
        return { ...row, current: revisionFromRow(revision) };
      });
    }, row => [row.name, row.id]);
  }
  history(id: string, input: PageInput): QueryPage<PlaybackRevision> {
    this.clipRow(id);
    return paginate(this.database, input, ['clips', id, 'history'], (after, count) => {
      const rows = this.database.connection.prepare(`SELECT ${revisionColumns} FROM playback_revisions r
        JOIN audit_events a ON a.id = r.audit_event_id
        WHERE r.clip_id = ? ${after ? 'AND r.revision > ?' : ''}
        ORDER BY r.revision, r.id LIMIT ?`)
        .all(id, ...(after ? [Number(after[0])] : []), count) as unknown as RevisionRow[];
      return rows.map(revisionFromRow);
    }, row => [String(row.revision)]);
  }

  /** Full decode and geometry checks happen before the short synchronous mutation transaction. */
  private async validate(artifactId: string, description: PlaybackDescription): Promise<void> {
    const parsed = playbackDescription.safeParse(description);
    if (!parsed.success) invalid('Invalid playback description.');
    const media: MediaDescription = await this.media.describe(artifactId);
    if (media.content !== 'available') {
      throw new ServiceUnavailableException({ code: 'SERVICE_UNAVAILABLE', message: 'Captured content is unavailable.' });
    }
    const { geometry, frames } = description;
    if (geometry.kind === 'grid') {
      if (media.kind === 'irregular-atlas') invalid('Irregular atlases are still images, not regular-grid playback.');
      if (media.members.length !== 1 || geometry.memberOrdinal !== 0) invalid('A regular grid needs one PNG member.');
      const member = media.members[0]!;
      if (member.format !== 'png' || member.preview !== 'available') invalid('A regular grid needs a fully decoded PNG.');
      if (geometry.columns * geometry.rows > mediaLimits.maxFrames ||
          (geometry.offsetX ?? 0) + geometry.columns * geometry.cellWidth + (geometry.columns - 1) * (geometry.gapX ?? 0) > member.width! ||
          (geometry.offsetY ?? 0) + geometry.rows * geometry.cellHeight + (geometry.rows - 1) * (geometry.gapY ?? 0) > member.height! ||
          frames.some(frame => frame >= geometry.columns * geometry.rows)) invalid('Cells or ordered frame indices exceed the PNG grid.');
    } else {
      if (media.members.length < 2 || media.members.some((member, index) => member.member.ordinal !== index ||
          member.format !== 'png' || member.preview !== 'available' ||
          member.width !== geometry.width || member.height !== geometry.height) ||
          frames.some(frame => frame >= media.members.length)) {
        invalid('A sequence needs equally sized, fully decoded PNG members and valid ordered frame indices.');
      }
    }
  }

  async createClip(artifactId: string, input: CreateClipInput, actor: string): Promise<ClipRecord> {
    const { name, ...description } = input;
    await this.validate(artifactId, description);
    const clipId = randomUUID();
    const revisionId = randomUUID();
    return this.database.mutate({ actor, targetType: 'clip', targetId: clipId }, context => {
      requireArtifact(context.connection, artifactId);
      const normalized = normalizeSlotName(name);
      if (context.connection.prepare('SELECT 1 FROM clips WHERE artifact_id = ? AND normalized_name = ?')
        .get(artifactId, normalized)) throw new ConflictException({ code: 'CONFLICT', message: 'A clip with this name already exists.' });
      context.connection.prepare(`INSERT INTO clips(id, artifact_id, name, normalized_name, current_revision_id, revision, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`).run(clipId, artifactId, name, normalized, revisionId, context.at);
      this.insertRevision(context.connection, { clipId, artifactId, revisionId, revision: 1, input: description, eventId: context.eventId });
      const after = this.fromRow(this.clipRow(clipId, context.connection), context.connection);
      return { before: null, after, result: after };
    });
  }

  async correctClip(id: string, input: CorrectPlaybackInput, actor: string): Promise<ClipRecord> {
    const { expectedRevision, ...description } = input;
    const observed = this.clipRow(id);
    await this.validate(observed.artifactId, description);
    return this.database.mutate({ actor, targetType: 'clip', targetId: id,
      expected: [{ expectedRevision, readCurrent: connection => this.clipRow(id, connection) }],
    }, context => {
      const before = this.fromRow(this.clipRow(id, context.connection), context.connection);
      const revisionId = randomUUID();
      this.insertRevision(context.connection, { clipId: id, artifactId: before.artifactId,
        revisionId, revision: before.revision + 1, input: description, eventId: context.eventId });
      context.connection.prepare('UPDATE clips SET current_revision_id = ?, revision = ? WHERE id = ?')
        .run(revisionId, before.revision + 1, id);
      const after = this.fromRow(this.clipRow(id, context.connection), context.connection);
      return { before, after, result: after };
    });
  }

  private insertRevision(connection: DatabaseSync, options: {
    clipId: string; artifactId: string; revisionId: string; revision: number;
    input: PlaybackDescription; eventId: number;
  }): void {
    const { clipId, artifactId, revisionId, revision, input, eventId } = options;
    connection.prepare(`INSERT INTO playback_revisions
      (id, clip_id, artifact_id, revision, geometry_json, frames_json, timing_json, source_kind, source_detail, audit_event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(revisionId, clipId, artifactId, revision,
        JSON.stringify(input.geometry), JSON.stringify(input.frames), JSON.stringify(input.durationsMs),
        input.source.kind, input.source.detail ?? null, eventId);
  }
}
