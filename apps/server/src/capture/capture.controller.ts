import { BadRequestException, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';
import { catalogId } from '@assetweave/contracts/catalog';
import { pageInput, type QueryPage } from '@assetweave/contracts/queries';
import type { CaptureReceipt, CaptureRecord, CaptureRecovery } from '@assetweave/contracts/capture';
import { CaptureService, type ArtifactSummary } from './capture.service.js';

function id(value: string): string {
  const parsed = catalogId.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid capture identity.' });
  return parsed.data;
}
function ordinal(value: string): number {
  const parsed = z.coerce.number().int().min(0).max(127).safeParse(value);
  if (!/^\d{1,3}$/u.test(value) || !parsed.success) {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid content member ordinal.' });
  }
  return parsed.data;
}

@Controller('api')
export class CaptureController {
  constructor(private readonly capture: CaptureService) {}

  @Post('captures')
  async store(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<CaptureReceipt> {
    if (!request.localAuthorization || request.localAuthorization.kind === 'launcher') {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Capture requires a browser or bridge.' });
    }
    const result = await this.capture.capture(request, request.localAuthorization.kind);
    reply.code(result.status === 'in-progress' ? 202 : 201);
    return result;
  }
  @Get('captures/operations/:operationId')
  receipt(@Param('operationId') operationId: string): Promise<CaptureReceipt> {
    return this.capture.receipt(id(operationId));
  }
  @Get('captures/recovery')
  recovery(): Promise<CaptureRecovery> { return this.capture.recovery(); }
  @Get('assets/:assetId/artifacts')
  list(@Param('assetId') assetId: string, @Query() query: unknown): QueryPage<ArtifactSummary> {
    const parsed = pageInput.safeParse(query);
    if (!parsed.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid artifact list query.',
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    return this.capture.listArtifacts(id(assetId), parsed.data);
  }
  @Get('artifacts/:artifactId')
  artifact(@Param('artifactId') artifactId: string): Promise<CaptureRecord> {
    return this.capture.getArtifact(id(artifactId));
  }
  @Get('artifacts/:artifactId/members/:memberOrdinal/original')
  async original(@Param('artifactId') artifactId: string, @Param('memberOrdinal') memberOrdinal: string,
    @Res() reply: FastifyReply): Promise<void> {
    const resolved = await this.capture.resolveMember(id(artifactId), ordinal(memberOrdinal));
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', 'attachment; filename="original.bin"');
    reply.header('Content-Length', String(resolved.member.byteCount));
    reply.send(createReadStream(resolved.path));
  }
}
