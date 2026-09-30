import type { DatabaseSync } from 'node:sqlite';
import * as z from 'zod';
import type { CaptureRecovery } from '@assetweave/contracts/capture';
import { ContentStore, sameMembers } from './content-store.js';

interface RegisteredContent {
  id: string; operationId: string; fingerprint: string; projectId: string; assetId: string;
  requestId: string | null; kind: string; name: string; notes: string;
}
const id = z.uuid();

/** Discovery is read-only. Nothing incomplete is registered, removed, or silently repaired. */
export async function reconcileCapture(connection: DatabaseSync, content: ContentStore): Promise<CaptureRecovery> {
  const registered = connection.prepare(`SELECT a.id, a.operation_id AS operationId, r.fingerprint,
    a.project_id AS projectId, a.asset_id AS assetId, a.request_id AS requestId,
    a.kind, a.name, a.notes FROM artifacts a JOIN capture_receipts r
    ON r.artifact_id = a.id AND r.operation_id = a.operation_id`).all() as unknown as RegisteredContent[];
  const byId = new Map(registered.map(row => [row.id, row]));
  const inspection = await content.inspectForReconciliation();
  const incompleteStaging: CaptureRecovery['incompleteStaging'] = inspection.incompleteStaging;
  const publishedOrphans: CaptureRecovery['publishedOrphans'] = [];
  const unavailableContent: CaptureRecovery['unavailableContent'] = [];
  const present = new Set<string>();
  for (const { name, descriptor } of inspection.published) {
    if (name.startsWith('.reserve-')) {
      incompleteStaging.push({ directory: name, operationId: null });
      continue;
    }
    if (!id.safeParse(name).success) {
      publishedOrphans.push({ artifactId: name, operationId: null });
      continue;
    }
    const row = byId.get(name);
    if (row) present.add(name);
    if (row) {
      const members = connection.prepare(`SELECT ordinal, stored_name AS storedName, source_name AS sourceName,
        byte_count AS byteCount, sha256, media_type AS mediaType FROM content_members
        WHERE artifact_id = ? ORDER BY ordinal`).all(name) as unknown as
          { ordinal: number; storedName: string; sourceName: string; byteCount: number; sha256: string; mediaType: string | null }[];
      const consistent = descriptor && descriptor.fingerprint === row.fingerprint &&
        descriptor.operationId === row.operationId && descriptor.projectId === row.projectId &&
        descriptor.assetId === row.assetId && descriptor.requestId === row.requestId &&
        descriptor.kind === row.kind && descriptor.name === row.name && descriptor.notes === row.notes &&
        sameMembers(descriptor.members, members.map(member =>
          ({ ordinal: member.ordinal, storedName: member.storedName, sourceName: member.sourceName,
            byteCount: member.byteCount, sha256: member.sha256,
            ...(member.mediaType === null ? {} : { mediaType: member.mediaType }) })));
      if (!consistent) unavailableContent.push({ artifactId: row.id, operationId: row.operationId });
    } else {
      publishedOrphans.push({ artifactId: name, operationId: descriptor?.operationId ?? null });
    }
  }
  for (const row of registered) {
    if (!present.has(row.id)) unavailableContent.push({ artifactId: row.id, operationId: row.operationId });
  }
  return { incompleteStaging, publishedOrphans, unavailableContent };
}
