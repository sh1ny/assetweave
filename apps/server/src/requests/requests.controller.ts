import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';
import { catalogId } from '@assetweave/contracts/catalog';
import { pageInput, type QueryPage } from '@assetweave/contracts/queries';
import {
  correctClaimInput, correctGapInput, correctInputInput, createRequestInput, productionField,
  recordClaimsInput, recordGapsInput, recordInputsInput, reportOutcomeInput, retractRevisionInput,
  type ClaimRecord, type ClaimRevision, type InputEdgeRecord, type InputEdgeRevision,
  type LineageGapRecord, type LineageGapRevision,
  type NotRecordedClaim, type OutcomeReport, type RequestRecord,
} from '@assetweave/contracts/production';
import { RevisionConflict } from '../database/database.service.js';
import { LineageService } from '../lineage/lineage.service.js';
import { ProvenanceService } from '../provenance/provenance.service.js';
import { RequestsService, type RequestSummary } from './requests.service.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid production input.',
    issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  return parsed.data;
}
function actor(request: FastifyRequest): string {
  const authorization = request.localAuthorization;
  if (!authorization || authorization.kind === 'launcher') {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Production writes require a browser or bridge.' });
  }
  return authorization.kind;
}
function mutation<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof RevisionConflict) throw new ConflictException({ code: 'CONFLICT',
      message: error.message, expectedRevision: error.expectedRevision, current: error.current });
    throw error;
  }
}

@Controller('api')
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly provenance: ProvenanceService,
    private readonly lineage: LineageService,
  ) {}

  @Get('assets/:assetId/requests')
  listRequests(@Param('assetId') assetId: string, @Query() query: unknown): QueryPage<RequestSummary> {
    return this.requests.listRequests(parse(catalogId, assetId), parse(pageInput, query));
  }
  @Post('projects/:projectId/assets/:assetId/requests')
  createRequest(@Param('projectId') projectId: string, @Param('assetId') assetId: string,
    @Body() body: unknown, @Req() request: FastifyRequest): RequestRecord {
    const input = parse(createRequestInput, body);
    return mutation(() => this.requests.createRequest(parse(catalogId, projectId), parse(catalogId, assetId), input, actor(request)));
  }
  @Get('requests/:requestId')
  getRequest(@Param('requestId') id: string): RequestRecord { return this.requests.getRequest(parse(catalogId, id)); }
  @Get('requests/:requestId/outcomes')
  outcomes(@Param('requestId') id: string, @Query() query: unknown): QueryPage<OutcomeReport> {
    return this.requests.outcomeHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Post('requests/:requestId/outcomes')
  reportOutcome(@Param('requestId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): RequestRecord {
    const input = parse(reportOutcomeInput, body);
    return mutation(() => this.requests.reportOutcome(parse(catalogId, id), input, actor(request)));
  }

  @Get('artifacts/:artifactId/claims')
  listClaims(@Param('artifactId') id: string, @Query() query: unknown): QueryPage<ClaimRecord> {
    return this.provenance.listClaims(parse(catalogId, id), parse(pageInput, query));
  }
  @Get('artifacts/:artifactId/claims/:field')
  getClaim(@Param('artifactId') id: string, @Param('field') field: string): ClaimRecord | NotRecordedClaim {
    return this.provenance.getClaim(parse(catalogId, id), parse(productionField, field));
  }
  @Post('artifacts/:artifactId/claims')
  addClaims(@Param('artifactId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): ClaimRecord[] {
    const input = parse(recordClaimsInput, body);
    return mutation(() => this.provenance.addClaims(parse(catalogId, id), input.claims, actor(request)));
  }
  @Get('assertions/:assertionId')
  getAssertion(@Param('assertionId') id: string): ClaimRecord { return this.provenance.getAssertion(parse(catalogId, id)); }
  @Get('assertions/:assertionId/history')
  assertionHistory(@Param('assertionId') id: string, @Query() query: unknown): QueryPage<ClaimRevision> {
    return this.provenance.assertionHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Patch('assertions/:assertionId')
  correctAssertion(@Param('assertionId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): ClaimRecord {
    const input = parse(correctClaimInput, body);
    return mutation(() => this.provenance.correctAssertion(parse(catalogId, id), input, actor(request)));
  }

  @Get('artifacts/:artifactId/inputs')
  listInputs(@Param('artifactId') id: string, @Query() query: unknown): QueryPage<InputEdgeRecord> {
    return this.lineage.listInputs(parse(catalogId, id), parse(pageInput, query));
  }
  @Get('artifacts/:artifactId/gaps')
  listGaps(@Param('artifactId') id: string, @Query() query: unknown): QueryPage<LineageGapRecord> {
    return this.lineage.listGaps(parse(catalogId, id), parse(pageInput, query));
  }
  @Get('artifacts/:artifactId/inputs/history')
  listInputHistory(@Param('artifactId') id: string, @Query() query: unknown): QueryPage<InputEdgeRecord> {
    return this.lineage.listInputHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Get('artifacts/:artifactId/gaps/history')
  listGapHistory(@Param('artifactId') id: string, @Query() query: unknown): QueryPage<LineageGapRecord> {
    return this.lineage.listGapHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Post('artifacts/:artifactId/inputs')
  addInputs(@Param('artifactId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): InputEdgeRecord[] {
    const input = parse(recordInputsInput, body);
    return mutation(() => this.lineage.addInputs(parse(catalogId, id), input.inputs, actor(request)));
  }
  @Get('inputs/:edgeId')
  getInput(@Param('edgeId') id: string): InputEdgeRecord { return this.lineage.getInput(parse(catalogId, id)); }
  @Get('inputs/:edgeId/history')
  inputHistory(@Param('edgeId') id: string, @Query() query: unknown): QueryPage<InputEdgeRevision> {
    return this.lineage.inputHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Patch('inputs/:edgeId')
  correctInput(@Param('edgeId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): InputEdgeRecord {
    const input = parse(correctInputInput, body);
    return mutation(() => this.lineage.correctInput(parse(catalogId, id), input, actor(request)));
  }
  @Post('inputs/:edgeId/retract')
  retractInput(@Param('edgeId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): InputEdgeRecord {
    const input = parse(retractRevisionInput, body);
    return mutation(() => this.lineage.retractInput(parse(catalogId, id), input.expectedRevision, actor(request)));
  }
  @Post('artifacts/:artifactId/gaps')
  addGaps(@Param('artifactId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): LineageGapRecord[] {
    const input = parse(recordGapsInput, body);
    return mutation(() => this.lineage.addGaps(parse(catalogId, id), input.gaps, actor(request)));
  }
  @Get('gaps/:gapId')
  getGap(@Param('gapId') id: string): LineageGapRecord { return this.lineage.getGap(parse(catalogId, id)); }
  @Get('gaps/:gapId/history')
  gapHistory(@Param('gapId') id: string, @Query() query: unknown): QueryPage<LineageGapRevision> {
    return this.lineage.gapHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Patch('gaps/:gapId')
  correctGap(@Param('gapId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): LineageGapRecord {
    const input = parse(correctGapInput, body);
    return mutation(() => this.lineage.correctGap(parse(catalogId, id), input, actor(request)));
  }
  @Post('gaps/:gapId/retract')
  retractGap(@Param('gapId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): LineageGapRecord {
    const input = parse(retractRevisionInput, body);
    return mutation(() => this.lineage.retractGap(parse(catalogId, id), input.expectedRevision, actor(request)));
  }
}
