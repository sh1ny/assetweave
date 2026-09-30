import { BadRequestException, ConflictException, Controller, Get, Param, Patch, Post, Body, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';
import {
  catalogId, createProjectInput, updateProjectInput, createAssetInput, updateAssetInput,
  createSlotInput, updateSlotInput, placeCandidateInput,
  type ProjectRecord, type AssetRecord, type SlotRecord, type CandidateRecord,
} from '@assetweave/contracts/catalog';
import { pageInput, type QueryPage } from '@assetweave/contracts/queries';
import { RevisionConflict } from '../database/database.service.js';
import { CatalogConflict, CatalogService } from './catalog.service.js';
import type { CatalogHistoryEntry } from './catalog.repository.js';

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid catalog input.',
      issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  }
  return result.data;
}

function actor(request: FastifyRequest): string {
  const authorization = request.localAuthorization;
  if (!authorization || authorization.kind === 'launcher') throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Catalog access requires a browser or bridge.' });
  return authorization.kind;
}

function mutation<T>(change: () => T): T {
  try {
    return change();
  } catch (error) {
    if (error instanceof RevisionConflict) {
      throw new ConflictException({ code: 'CONFLICT', message: error.message,
        expectedRevision: error.expectedRevision, current: error.current });
    }
    if (error instanceof CatalogConflict) {
      throw new ConflictException({ code: 'CONFLICT', message: error.message, current: error.current });
    }
    throw error;
  }
}

@Controller('api')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('projects')
  listProjects(@Query() query: unknown): QueryPage<ProjectRecord> { return this.catalog.listProjects(parseInput(pageInput, query)); }
  @Get('projects/:projectId')
  getProject(@Param('projectId') id: string): ProjectRecord { return this.catalog.getProject(parseInput(catalogId, id)); }
  @Get('projects/:projectId/history')
  projectHistory(@Param('projectId') id: string, @Query() query: unknown): QueryPage<CatalogHistoryEntry> {
    return this.catalog.projectHistory(parseInput(catalogId, id), parseInput(pageInput, query));
  }
  @Post('projects')
  createProject(@Body() body: unknown, @Req() request: FastifyRequest): ProjectRecord {
    const input = parseInput(createProjectInput, body);
    return mutation(() => this.catalog.createProject(input, actor(request)));
  }
  @Patch('projects/:projectId')
  updateProject(@Param('projectId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): ProjectRecord {
    const input = parseInput(updateProjectInput, body);
    return mutation(() => this.catalog.updateProject(parseInput(catalogId, id), input, actor(request)));
  }

  @Get('assets')
  listAssets(@Query() query: unknown): QueryPage<AssetRecord> {
    const input = parseInput(pageInput.extend({ projectId: catalogId.optional() }), query);
    return this.catalog.listAssets(input, input.projectId);
  }
  @Get('projects/:projectId/assets')
  projectAssets(@Param('projectId') id: string, @Query() query: unknown): QueryPage<AssetRecord> {
    return this.catalog.listAssets(parseInput(pageInput, query), parseInput(catalogId, id));
  }
  @Post('projects/:projectId/assets')
  createAsset(@Param('projectId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): AssetRecord {
    const input = parseInput(createAssetInput, body);
    return mutation(() => this.catalog.createAsset(parseInput(catalogId, id), input, actor(request)));
  }
  @Get('assets/:assetId')
  getAsset(@Param('assetId') id: string): AssetRecord { return this.catalog.getAsset(parseInput(catalogId, id)); }
  @Get('assets/:assetId/history')
  assetHistory(@Param('assetId') id: string, @Query() query: unknown): QueryPage<CatalogHistoryEntry> {
    return this.catalog.assetHistory(parseInput(catalogId, id), parseInput(pageInput, query));
  }
  @Patch('assets/:assetId')
  updateAsset(@Param('assetId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): AssetRecord {
    const input = parseInput(updateAssetInput, body);
    return mutation(() => this.catalog.updateAsset(parseInput(catalogId, id), input, actor(request)));
  }

  @Get('assets/:assetId/slots')
  listSlots(@Param('assetId') id: string, @Query() query: unknown): QueryPage<SlotRecord> {
    return this.catalog.listSlots(parseInput(catalogId, id), parseInput(pageInput, query));
  }
  @Post('assets/:assetId/slots')
  createSlot(@Param('assetId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): SlotRecord {
    const input = parseInput(createSlotInput, body);
    return mutation(() => this.catalog.createSlot(parseInput(catalogId, id), input, actor(request)));
  }
  @Get('slots/:slotId')
  getSlot(@Param('slotId') id: string): SlotRecord { return this.catalog.getSlot(parseInput(catalogId, id)); }
  @Get('slots/:slotId/history')
  slotHistory(@Param('slotId') id: string, @Query() query: unknown): QueryPage<CatalogHistoryEntry> {
    return this.catalog.slotHistory(parseInput(catalogId, id), parseInput(pageInput, query));
  }
  @Patch('slots/:slotId')
  updateSlot(@Param('slotId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): SlotRecord {
    const input = parseInput(updateSlotInput, body);
    return mutation(() => this.catalog.updateSlot(parseInput(catalogId, id), input, actor(request)));
  }

  @Get('slots/:slotId/candidates')
  listCandidates(@Param('slotId') id: string, @Query() query: unknown): QueryPage<CandidateRecord> {
    return this.catalog.listCandidates(parseInput(catalogId, id), parseInput(pageInput, query));
  }
  @Post('slots/:slotId/candidates')
  placeCandidate(@Param('slotId') id: string, @Body() body: unknown, @Req() request: FastifyRequest): CandidateRecord {
    const input = parseInput(placeCandidateInput, body);
    return mutation(() => this.catalog.placeCandidate(parseInput(catalogId, id), input, actor(request)));
  }
  @Get('candidates/:candidateId')
  getCandidate(@Param('candidateId') id: string): CandidateRecord { return this.catalog.getCandidate(parseInput(catalogId, id)); }
}
