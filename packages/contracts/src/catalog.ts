import * as z from 'zod';

export const catalogId = z.uuid();
const name = z.string().trim().min(1).max(200);
const notes = z.string().max(16_384);
const expectedRevision = z.number().int().positive();

/** Slot identity key: Unicode NFKC, trimmed/collapsed whitespace, lowercased. */
export function normalizeSlotName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export const createProjectInput = z.strictObject({ name, notes: notes.optional() });
export const updateProjectInput = z.strictObject({
  expectedRevision, name: name.optional(), notes: notes.optional(),
}).refine(input => input.name !== undefined || input.notes !== undefined, { message: 'Supply a name or notes to update.' });
export const createAssetInput = z.strictObject({ name, notes: notes.optional() });
export const updateAssetInput = updateProjectInput;
export const createSlotInput = z.strictObject({ name, notes: notes.optional() });
export const updateSlotInput = updateProjectInput;
export const placeCandidateInput = z.strictObject({ artifactId: catalogId, clipId: catalogId.optional() });

export type CreateProjectInput = z.infer<typeof createProjectInput>;
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;
export type CreateAssetInput = z.infer<typeof createAssetInput>;
export type UpdateAssetInput = z.infer<typeof updateAssetInput>;
export type CreateSlotInput = z.infer<typeof createSlotInput>;
export type UpdateSlotInput = z.infer<typeof updateSlotInput>;
export type PlaceCandidateInput = z.infer<typeof placeCandidateInput>;

export interface ProjectRecord {
  id: string;
  name: string;
  notes: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface AssetRecord {
  id: string;
  projectId: string;
  name: string;
  notes: string;
  stage: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface SlotRecord {
  id: string;
  assetId: string;
  name: string;
  normalizedName: string;
  notes: string;
  selectedCandidateId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CandidateRecord {
  id: string;
  slotId: string;
  artifactId: string;
  clipId: string | null;
  reviewState: 'unreviewed' | 'reviewed-undecided' | 'approved' | 'rejected';
  revision: number;
  placedAt: string;
}
