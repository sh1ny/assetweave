import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';
import { catalogId } from '@assetweave/contracts/catalog';
import {
  reviewCandidateInput, selectCandidateInput, setStageInput,
  type AssetStageDecision, type CandidateReviewDecision, type ReviewResult,
  type SelectionResult, type SlotDecisionState, type SlotSelectionDecision, type StageResult,
} from '@assetweave/contracts/decisions';
import { pageInput, type QueryPage } from '@assetweave/contracts/queries';
import { RevisionConflict } from '../database/database.service.js';
import { DecisionsService, type DecisionRecorder } from './decisions.service.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid creative decision input.',
      issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  }
  return result.data;
}

function recorder(request: FastifyRequest, instruction: string | undefined, browserAction: string): DecisionRecorder {
  const authorization = request.localAuthorization;
  if (authorization?.kind === 'bridge') {
    if (!instruction) throw new BadRequestException({ code: 'MISSING_AUTHORITY',
      message: 'An agent must retain the explicit human instruction authorizing this decision.' });
    return { actor: 'bridge', authority: { channel: 'reported', instruction } };
  }
  if (authorization?.kind === 'browser') {
    if (instruction !== undefined) throw new BadRequestException({ code: 'INVALID_REQUEST',
      message: 'Browser decisions record the deliberate form action, not a reported instruction.' });
    return { actor: 'browser', authority: { channel: 'browser', instruction: browserAction } };
  }
  throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Decisions require an authorized browser or bridge.' });
}
function mutation<T>(change: () => T): T {
  try { return change(); }
  catch (error) {
    if (error instanceof RevisionConflict) throw new ConflictException({ code: 'CONFLICT',
      message: error.message, expectedRevision: error.expectedRevision, current: error.current });
    throw error;
  }
}

@Controller('api')
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get('slots/:slotId/decision')
  slotDecision(@Param('slotId') id: string): SlotDecisionState {
    return this.decisions.getSlotDecision(parse(catalogId, id));
  }
  @Get('candidates/:candidateId/reviews')
  candidateHistory(@Param('candidateId') id: string, @Query() query: unknown): QueryPage<CandidateReviewDecision> {
    return this.decisions.candidateHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Get('slots/:slotId/selection-history')
  slotHistory(@Param('slotId') id: string, @Query() query: unknown): QueryPage<SlotSelectionDecision> {
    return this.decisions.slotHistory(parse(catalogId, id), parse(pageInput, query));
  }
  @Get('assets/:assetId/stage-history')
  stageHistory(@Param('assetId') id: string, @Query() query: unknown): QueryPage<AssetStageDecision> {
    return this.decisions.assetStageHistory(parse(catalogId, id), parse(pageInput, query));
  }

  @Patch('candidates/:candidateId/review')
  review(@Param('candidateId') rawId: string, @Body() body: unknown, @Req() request: FastifyRequest): ReviewResult {
    const id = parse(catalogId, rawId);
    const input = parse(reviewCandidateInput, body);
    const action = `Browser action: review candidate ${id} as ${input.nextState}` +
      (input.disposition ? `; reject selected: ${input.disposition}` : '') +
      (input.replacementCandidateId ? ` with candidate ${input.replacementCandidateId}` : '');
    return mutation(() => this.decisions.reviewCandidate(id, input, recorder(request, input.instruction, action)));
  }
  @Patch('slots/:slotId/selection')
  select(@Param('slotId') rawId: string, @Body() body: unknown, @Req() request: FastifyRequest): SelectionResult {
    const id = parse(catalogId, rawId);
    const input = parse(selectCandidateInput, body);
    const action = input.nextCandidateId === null ? `Browser action: clear selection in slot ${id}` :
      `Browser action: select candidate ${input.nextCandidateId} in slot ${id}`;
    return mutation(() => this.decisions.selectCandidate(id, input, recorder(request, input.instruction, action)));
  }
  @Patch('assets/:assetId/stage')
  stage(@Param('assetId') rawId: string, @Body() body: unknown, @Req() request: FastifyRequest): StageResult {
    const id = parse(catalogId, rawId);
    const input = parse(setStageInput, body);
    const action = input.stage === null ? `Browser action: clear human stage for asset ${id}` :
      `Browser action: set human stage for asset ${id} to ${input.stage}`;
    return mutation(() => this.decisions.setStage(id, input, recorder(request, input.instruction, action)));
  }
}
