import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import * as z from 'zod';
import { catalogId } from '@assetweave/contracts/catalog';
import { contextQuery, lineageQuery, searchInput, textSearchInput, type ContextResult, type LineagePage,
  type QueryPage, type RevisionDetail, type SearchHit, type TextHit } from '@assetweave/contracts/queries';
import { ContextService } from './context.service.js';
import { SearchService } from './search.service.js';

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Invalid retrieval query.',
    issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  return parsed.data;
}

@Controller('api/queries')
export class QueriesController {
  constructor(private readonly search: SearchService, private readonly context: ContextService) {}

  @Get('search')
  find(@Query() raw: Record<string, unknown>): QueryPage<SearchHit> {
    let filters: unknown = raw.filters;
    if (typeof filters === 'string') {
      try { filters = JSON.parse(filters) as unknown; }
      catch { throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'filters must be a JSON object.' }); }
    }
    return this.search.search(parse(searchInput, { ...raw, ...(filters === undefined ? {} : { filters }) }));
  }

  @Get('text')
  text(@Query() query: unknown): QueryPage<TextHit> {
    return this.search.searchText(parse(textSearchInput, query));
  }

  @Get('context')
  taskContext(@Query() query: unknown): ContextResult {
    return this.context.context(parse(contextQuery, query));
  }

  @Get('lineage/:artifactId')
  lineage(@Param('artifactId') id: string, @Query() query: unknown): LineagePage {
    return this.search.traverse(parse(catalogId, id), parse(lineageQuery, query));
  }

  @Get('revisions/:recordType/:revisionId')
  revision(@Param('recordType') type: string, @Param('revisionId') id: string): RevisionDetail {
    return this.search.getRevision(type, id);
  }
}
