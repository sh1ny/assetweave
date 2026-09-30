import * as z from 'zod';
import { catalogId } from './catalog.js';
import { reviewState } from './decisions.js';

/** Revision IDs for project/asset/slot are UUID:revision; all other revisions use UUIDs. */
export const revisionKey = z.string().min(1).max(128).refine(value => {
  const [recordId, revision, extra] = value.split(':');
  return extra === undefined && catalogId.safeParse(recordId).success &&
    (revision === undefined || /^[1-9]\d*$/u.test(revision));
}, 'Use a UUID or a UUID:revision key from a historical hit.');

export const pageInput = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(65_536).optional(),
});
export type PageInput = z.infer<typeof pageInput>;
export interface QueryPage<T> {
  items: T[];
  nextCursor: string | null;
  watermark: number;
}

const ids = z.array(catalogId).min(1).max(50).optional();
const textValues = z.array(z.string().min(1).max(200)).min(1).max(50).optional();
const dates = z.strictObject({ from: z.iso.datetime().optional(), through: z.iso.datetime().optional() });
export const artifactFilters = z.strictObject({
  projectIds: ids,
  assetIds: ids,
  slotIds: ids,
  unslotted: z.boolean().optional(),
  stages: textValues,
  stageNone: z.boolean().optional(),
  kinds: textValues,
  reviews: z.array(reviewState).min(1).optional(),
  selection: z.array(z.enum(['selected', 'not-selected', 'formerly-selected'])).min(1).optional(),
  producers: textValues,
  captured: dates.optional(),
  produced: dates.optional(),
  unknownProductionDate: z.boolean().optional(),
  ancestorOf: ids,
  descendantOf: ids,
});
export const searchInput = z.strictObject({
  ...pageInput.shape,
  filters: artifactFilters.default({}),
  text: z.string().trim().min(1).max(1000).optional(),
  scope: z.enum(['current', 'history']).default('current'),
});
export type SearchInput = z.infer<typeof searchInput>;
/** Search the complete recorded text corpus, including requests with no capture. */
export const textSearchInput = z.strictObject({
  ...pageInput.shape,
  text: z.string().trim().min(1).max(1000),
  scope: z.enum(['current', 'history']).default('current'),
});
export type TextSearchInput = z.infer<typeof textSearchInput>;
export interface TextHit {
  type: string;
  recordId: string;
  revisionId: string;
  revision: number;
  scope: 'project' | 'asset' | 'slot' | 'request' | 'artifact';
  scopeId: string;
  excerpt: string;
  excerptTruncated: boolean;
  recordUrl: string;
  revisionUrl: string;
}
export interface RevisionDetail {
  type: string;
  recordId: string;
  revisionId: string;
  revision: number;
  current: boolean;
  actor: string;
  at: string;
  record: unknown;
}
export interface SearchHit {
  artifactId: string;
  projectId: string;
  assetId: string;
  kind: string;
  name: string;
  capturedAt: string;
  recordUrl: string;
  matchedRevision: { type: string; recordId: string; revisionId: string; revision: number; url: string } | null;
}

export const lineageQuery = z.strictObject({ ...pageInput.shape, direction: z.enum(['inputs', 'dependents']) });
export type LineageQuery = z.infer<typeof lineageQuery>;
export interface LineageStep {
  artifactId: string;
  artifactUrl: string;
  depth: number;
  via: { id: string; revisionId: string; inputArtifactId: string; outputArtifactId: string; role: string | null; url: string } | null;
  links: NonNullable<LineageStep['via']>[];
  gaps: { id: string; revisionId: string; description: string; descriptionTruncated: boolean; kind: string; url: string }[];
}
export interface LineagePage extends QueryPage<LineageStep> {
  originArtifactId: string;
  direction: 'inputs' | 'dependents';
  visited: string[];
  visitedCount: number;
  visitedTruncated: boolean;
  frontier: string[];
  frontierCount: number;
  frontierTruncated: boolean;
  encounteredGaps: LineageStep['gaps'];
  encounteredGapCount: number;
  encounteredGapsTruncated: boolean;
}

export const contextQuery = z.strictObject({
  ...pageInput.shape,
  projectId: catalogId.optional(),
  projectName: z.string().trim().min(1).max(200).optional(),
  assetId: catalogId.optional(),
  assetName: z.string().trim().min(1).max(200).optional(),
  slotId: catalogId.optional(),
  slotName: z.string().trim().min(1).max(200).optional(),
  sourceArtifactId: catalogId.optional(),
  section: z.enum(['slots', 'candidates', 'artifacts', 'claims', 'inputs', 'gaps', 'requests']).optional(),
}).refine(v => v.assetId !== undefined || v.assetName !== undefined, 'Specify the asset identity.');
export type ContextQuery = z.infer<typeof contextQuery>;
export interface TextExcerpt { value: string; truncated: boolean; fullRecordUrl: string }
export interface ContextItem { id: string; url: string; record: unknown }
export interface ContextSection { items: ContextItem[]; nextCursor: string | null; truncated: boolean }
export interface ContextResult {
  watermark: number;
  project: { id: string; name: string; notes: TextExcerpt; url: string };
  asset: { id: string; name: string; stage: string | null; notes: TextExcerpt; url: string };
  targetSlot: { id: string; name: string; selectedCandidateId: string | null; notes: TextExcerpt; url: string } | null;
  explicitSource: { id: string; url: string } | null;
  sections: Record<'slots' | 'candidates' | 'artifacts' | 'claims' | 'inputs' | 'gaps' | 'requests', ContextSection>;
  alternatives: { category: 'project' | 'asset' | 'slot'; id: string; name: string; url: string }[];
}
