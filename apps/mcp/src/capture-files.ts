import { createHash, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { Stats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import * as z from 'zod';
import { captureLimits, captureMetadata, captureReceiptSchema, declaredMember, captureRecordSchema,
  type CaptureRecord, type CaptureReceipt } from '@assetweave/contracts/capture';
import { BridgeClient, BridgeFault, recordLink } from './client.js';

const explicitFile = z.strictObject({
  path: z.string().min(1).describe('Explicit local file path to read. Never inferred from a prompt, note, or filename.'),
  sourceName: declaredMember.shape.sourceName.optional().describe('Filename label stored as evidence, not a server path.'),
  mediaType: declaredMember.shape.mediaType.optional(),
});
const { members: _members, ...captureFields } = captureMetadata.shape;
export const captureFilesInput = z.strictObject({
  ...captureFields,
  files: z.array(explicitFile).min(1).max(captureLimits.members).describe('Ordered local files; sequence order is exactly this array order.'),
});

interface SourceFile {
  path: string;
  handle: FileHandle;
  initial: Stats;
  declared: z.output<typeof declaredMember>;
}

function incomplete(ordinal: number, reason: string): BridgeFault {
  return new BridgeFault({ code: 'INCOMPLETE_CAPTURE', message: `Explicit local member ${ordinal} ${reason}; no complete artifact was reported. Inspect its original operation receipt before any deliberate retry.` });
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function assertUnchanged(file: SourceFile, ordinal: number): Promise<void> {
  try {
    const [opened, named] = await Promise.all([file.handle.stat(), stat(file.path)]);
    if (!sameFile(file.initial, opened) || !sameFile(file.initial, named) || !named.isFile()) {
      throw incomplete(ordinal, 'changed or was replaced between hashing and transfer');
    }
  } catch (error) {
    if (error instanceof BridgeFault) throw error;
    throw incomplete(ordinal, 'is missing, unreadable, or was replaced');
  }
}

/** Every file is opened and completely hashed before the first upload byte leaves this process. */
async function preflight(input: z.output<typeof captureFilesInput>): Promise<SourceFile[]> {
  const opened: SourceFile[] = [];
  let aggregate = 0;
  try {
    for (const [ordinal, file] of input.files.entries()) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(file.path, 'r');
        const initial = await handle.stat();
        if (!initial.isFile() || initial.size < 1 || initial.size > captureLimits.memberBytes) {
          throw incomplete(ordinal, 'is not a nonempty regular file within the 32 MiB member limit');
        }
        aggregate += initial.size;
        if (aggregate > captureLimits.aggregateBytes) throw incomplete(ordinal, 'exceeds the 128 MiB aggregate limit');
        const hash = createHash('sha256');
        let byteCount = 0;
        for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
          byteCount += chunk.length;
          if (byteCount > initial.size) throw incomplete(ordinal, 'grew while being hashed');
          hash.update(chunk);
        }
        if (byteCount !== initial.size) throw incomplete(ordinal, 'was truncated while being hashed');
        const parsed = declaredMember.safeParse({ sourceName: file.sourceName ?? basename(file.path),
          byteCount, sha256: hash.digest('hex'), ...(file.mediaType ? { mediaType: file.mediaType } : {}) });
        if (!parsed.success) throw new BridgeFault({ code: 'INVALID_REQUEST',
          message: `Explicit local member ${ordinal} has an invalid filename label or media type; use a label, not a path.` });
        const source = { path: file.path, handle, initial, declared: parsed.data };
        opened.push(source);
        handle = undefined;
        await assertUnchanged(source, ordinal);
      } catch (error) {
        await handle?.close();
        if (error instanceof BridgeFault) throw error;
        throw incomplete(ordinal, 'is missing, unreadable, or has an invalid filename label');
      }
    }
    for (const [ordinal, file] of opened.entries()) await assertUnchanged(file, ordinal);
    return opened;
  } catch (error) {
    await Promise.all(opened.map(file => file.handle.close()));
    throw error;
  }
}

async function* multipart(serializedMetadata: string, files: SourceFile[], boundary: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${serializedMetadata}\r\n`);
  for (const [ordinal, file] of files.entries()) {
    await assertUnchanged(file, ordinal);
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="member${ordinal}"; filename="member${ordinal}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const digest = createHash('sha256');
    let sent = 0;
    try {
      for await (const chunk of file.handle.createReadStream({ start: 0, autoClose: false })) {
        sent += chunk.length;
        if (sent > file.declared.byteCount) throw incomplete(ordinal, 'grew while being uploaded');
        digest.update(chunk);
        yield chunk;
      }
    } catch (error) {
      if (error instanceof BridgeFault) throw error;
      throw incomplete(ordinal, 'became unreadable during upload');
    }
    if (sent !== file.declared.byteCount || digest.digest('hex') !== file.declared.sha256) {
      throw incomplete(ordinal, 'changed between hashing and transfer');
    }
    await assertUnchanged(file, ordinal);
    yield Buffer.from('\r\n');
  }
  yield Buffer.from(`--${boundary}--\r\n`);
}

export async function captureFiles(client: BridgeClient, input: z.output<typeof captureFilesInput>): Promise<{
  receipt: CaptureReceipt; artifact: CaptureRecord | null; browserLink: string | null;
}> {
  const files = await preflight(input);
  try {
    const { files: _explicitPaths, ...fields } = input; // Never send local paths to Nest.
    const metadata = captureMetadata.parse({ ...fields, members: files.map(file => file.declared) });
    const serializedMetadata = JSON.stringify(metadata);
    if (Buffer.byteLength(serializedMetadata, 'utf8') > captureLimits.metadataBytes) {
      throw new BridgeFault({ code: 'INVALID_REQUEST', message: 'Capture metadata exceeds the 256 KiB limit.' });
    }
    const boundary = `assetweave-${randomBytes(20).toString('hex')}`;
    const raw = await client.upload(multipart(serializedMetadata, files, boundary), boundary);
    const receipt = captureReceiptSchema.safeParse(raw);
    if (!receipt.success || receipt.data.operationId !== metadata.operationId ||
        !['committed', 'in-progress'].includes(receipt.data.status)) {
      throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: 'The local service returned an invalid capture state. Inspect the explicit operation receipt before retrying.' });
    }
    if (receipt.data.status !== 'committed') return { receipt: receipt.data, artifact: null, browserLink: null };
    const parsedArtifact = captureRecordSchema.safeParse(await client.json(`/api/artifacts/${receipt.data.artifactId}`));
    if (!parsedArtifact.success) throw new BridgeFault({ code: 'SERVICE_UNAVAILABLE', message: 'The local service returned an invalid committed artifact record.' });
    const artifact = parsedArtifact.data;
    if (artifact.id !== receipt.data.artifactId || artifact.operationId !== metadata.operationId || artifact.content !== 'available') {
      throw new BridgeFault({ code: 'CONTENT_UNAVAILABLE', message: 'Capture was committed, but its preserved content is unavailable. Inspect the operation receipt and recovery report.' });
    }
    const origin = await client.connect();
    return { receipt: receipt.data, artifact, browserLink: recordLink(origin, {
      projectId: artifact.projectId, assetId: artifact.assetId, slotId: metadata.slotId,
      artifactId: artifact.id, candidateId: artifact.candidateId,
    }) };
  } finally {
    await Promise.all(files.map(file => file.handle.close()));
  }
}
