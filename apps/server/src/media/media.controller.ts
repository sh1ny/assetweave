import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { catalogId } from '@assetweave/contracts/catalog';
import type { MediaDescription, MediaThumbnail } from '@assetweave/contracts/media';
import { correctPlaybackInput, createClipInput, type ClipRecord, type PlaybackRevision } from '@assetweave/contracts/playback';
import { pageInput, type QueryPage } from '@assetweave/contracts/queries';
import { RevisionConflict } from '../database/database.service.js';
import { MediaService } from './media.service.js';
import { PlaybackService } from './playback.service.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid media or playback input.',
    issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  return result.data;
}
function ordinal(value: string): number {
  if (!/^\d{1,3}$/u.test(value)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid media member ordinal.' });
  return parse(z.coerce.number().int().min(0).max(127), value);
}
function actor(request: FastifyRequest): string {
  const authorization = request.localAuthorization;
  if (!authorization || authorization.kind === 'launcher') {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Playback changes require a browser or bridge.' });
  }
  return authorization.kind;
}

@Controller('api')
export class MediaController {
  constructor(private readonly media: MediaService, private readonly playback: PlaybackService) {}

  @Get('artifacts/:artifactId/media')
  describe(@Param('artifactId') artifactId: string): Promise<MediaDescription> {
    return this.media.describe(parse(catalogId, artifactId));
  }
  @Get('artifacts/:artifactId/media/thumbnail')
  thumbnail(@Param('artifactId') artifactId: string): Promise<MediaThumbnail> {
    return this.media.thumbnail(parse(catalogId, artifactId));
  }
  private async sendPreview(artifactId: string, memberOrdinal: string, reply: FastifyReply, revisionId?: string): Promise<void> {
    const { bytes, mime } = await this.media.preview(artifactId, ordinal(memberOrdinal), revisionId);
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Disposition', 'inline');
    reply.header('Content-Length', String(bytes.length));
    reply.send(bytes);
  }
  @Get('artifacts/:artifactId/media/members/:ordinal')
  preview(@Param('artifactId') artifactId: string, @Param('ordinal') memberOrdinal: string,
    @Res() reply: FastifyReply): Promise<void> {
    return this.sendPreview(parse(catalogId, artifactId), memberOrdinal, reply);
  }
  @Get('playback-revisions/:revisionId/members/:ordinal/preview')
  pinnedPreview(@Param('revisionId') revisionId: string, @Param('ordinal') memberOrdinal: string,
    @Res() reply: FastifyReply): Promise<void> {
    const revision = this.playback.getRevision(parse(catalogId, revisionId));
    return this.sendPreview(revision.artifactId, memberOrdinal, reply, revision.id);
  }
  @Get('artifacts/:artifactId/clips')
  clips(@Param('artifactId') artifactId: string, @Query() query: unknown): QueryPage<ClipRecord> {
    return this.playback.listClips(parse(catalogId, artifactId), parse(pageInput, query));
  }
  @Post('artifacts/:artifactId/clips')
  create(@Param('artifactId') artifactId: string, @Body() body: unknown, @Req() request: FastifyRequest): Promise<ClipRecord> {
    return this.playback.createClip(parse(catalogId, artifactId), parse(createClipInput, body), actor(request));
  }
  @Get('clips/:clipId')
  clip(@Param('clipId') clipId: string): ClipRecord { return this.playback.getClip(parse(catalogId, clipId)); }
  @Get('clips/:clipId/history')
  history(@Param('clipId') clipId: string, @Query() query: unknown): QueryPage<PlaybackRevision> {
    return this.playback.history(parse(catalogId, clipId), parse(pageInput, query));
  }
  @Patch('clips/:clipId')
  async correct(@Param('clipId') clipId: string, @Body() body: unknown, @Req() request: FastifyRequest): Promise<ClipRecord> {
    try { return await this.playback.correctClip(parse(catalogId, clipId), parse(correctPlaybackInput, body), actor(request)); }
    catch (error) {
      if (error instanceof RevisionConflict) throw new ConflictException({ code: 'CONFLICT',
        message: error.message, expectedRevision: error.expectedRevision, current: error.current });
      throw error;
    }
  }
  @Get('playback-revisions/:revisionId')
  revision(@Param('revisionId') revisionId: string): PlaybackRevision {
    return this.playback.getRevision(parse(catalogId, revisionId));
  }
}
