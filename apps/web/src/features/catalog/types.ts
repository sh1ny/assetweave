import type { CandidateRecord } from '@assetweave/contracts/catalog';

/** Context retrieval supplies placement ownership separately from captured ownership. */
export interface PlacementRecord {
  candidate: CandidateRecord;
  capturedProjectName: string;
  capturedAssetName: string;
  clipName: string | null;
  formerlySelected?: boolean;
}
