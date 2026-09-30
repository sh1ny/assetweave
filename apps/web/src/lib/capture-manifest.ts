import { captureLimits, captureMetadata, declaredMember, type CaptureMetadata } from '@assetweave/contracts/capture';
import { catalogId } from '@assetweave/contracts/catalog';

export type CaptureFields = Omit<CaptureMetadata, 'members'>;

/** A legacy operation ID is still recoverable, but never supplies context for replay. */
export function recoverCaptureOperation(stored: string | null, projectId: string, assetId: string):
  { operationId: string; metadata: CaptureMetadata | null } | null {
  if (!stored) return null;
  if (catalogId.safeParse(stored).success) return { operationId: stored, metadata: null };
  try {
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as { operationId?: unknown; metadata?: unknown };
    if (!catalogId.safeParse(record.operationId).success) return null;
    const operationId = record.operationId as string;
    const metadata = captureMetadata.safeParse(record.metadata);
    return {
      operationId,
      metadata: metadata.success && metadata.data.operationId === operationId &&
        metadata.data.projectId === projectId && metadata.data.assetId === assetId ? metadata.data : null,
    };
  } catch { return null; }
}

/** The caller's array order is the order of member0, member1, ... on the wire. */
export function validateCaptureSelection(files: readonly File[], kind: string): string | null {
  if (!files.length || files.some(file => !file)) return 'Select all files before capturing.';
  if (files.length > captureLimits.members) return `Select no more than ${captureLimits.members} files.`;
  if (kind === 'png-sequence' && files.length < 2) return 'A PNG sequence needs at least two frames.';
  if (kind !== 'png-sequence' && files.length !== 1) return 'Multiple files require the PNG sequence kind.';
  const names = new Set<string>();
  let bytes = 0;
  for (const [index, file] of files.entries()) {
    if (file.size === 0) return `File ${index + 1} (${file.name}) is empty or missing.`;
    if (file.size > captureLimits.memberBytes) return `File ${index + 1} exceeds the 32 MiB per-file limit.`;
    bytes += file.size;
    if (bytes > captureLimits.aggregateBytes) return 'Files exceed the 128 MiB total limit.';
    if (!declaredMember.shape.sourceName.safeParse(file.name).success) return `File ${index + 1} needs a valid filename label.`;
    if (names.has(file.name)) return `Duplicate filename ${file.name}; each member needs a distinct filename.`;
    names.add(file.name);
    if (kind === 'png-sequence' && !file.name.toLowerCase().endsWith('.png')) {
      return `File ${index + 1} is not a PNG frame.`;
    }
  }
  return null;
}

/** Replay may send only the original ordered bytes and labels with the original operation context. */
export async function verifyCaptureReplay(files: readonly File[], original: CaptureMetadata): Promise<void> {
  const { members, ...fields } = original;
  const reselected = await buildCaptureManifest(files, fields);
  if (reselected.members.length !== members.length || !reselected.members.every((member, index) => {
    const saved = members[index];
    return saved && member.sourceName === saved.sourceName && member.byteCount === saved.byteCount &&
      member.sha256 === saved.sha256 && (member.mediaType ?? null) === (saved.mediaType ?? null);
  })) {
    throw new Error('Reselect the original files with matching names, bytes, media types, and order for this operation.');
  }
}

/** Hash exact selected bytes before transfer; unreadable files are never declared. */
export async function buildCaptureManifest(files: readonly File[], fields: CaptureFields): Promise<CaptureMetadata> {
  const error = validateCaptureSelection(files, fields.kind);
  if (error) throw new Error(error);
  const members: CaptureMetadata['members'] = [];
  for (const [index, file] of files.entries()) {
    let bytes: ArrayBuffer;
    try { bytes = await file.arrayBuffer(); }
    catch { throw new Error(`File ${index + 1} (${file.name}) is no longer readable. Reselect the files.`); }
    if (bytes.byteLength !== file.size) {
      throw new Error(`File ${index + 1} (${file.name}) changed while hashing. Reselect the files.`);
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    const mediaType = file.type.toLowerCase();
    members.push(declaredMember.parse({
      sourceName: file.name, byteCount: bytes.byteLength, sha256,
      ...(declaredMember.shape.mediaType.safeParse(mediaType).success ? { mediaType } : {}),
    }));
  }
  const parsed = captureMetadata.parse({ ...fields, members });
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > captureLimits.metadataBytes) {
    throw new Error('Capture metadata exceeds the 256 KiB limit. Shorten notes or claims.');
  }
  return parsed;
}
