import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import * as z from 'zod';
import { captureDescriptor, captureLimits, type CaptureDescriptor, type CaptureMetadata, type StoredMember } from '@assetweave/contracts/capture';
import { ProfileService } from '../runtime/profile.service.js';

export class UnavailableContent extends Error {
  constructor() { super('Captured content is missing, substituted, or differs from its preserved manifest.'); }
}
export class IncompleteContent extends Error {
  constructor(message: string) { super(message); }
}
export interface CaptureStage { artifactId: string; operationId: string; directory: string; reservation: string }
const artifactName = z.uuid();
const maxDescriptorBytes = captureLimits.metadataBytes + 128 * 1024;

function directory(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new UnavailableContent();
}
function occupied(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function regularFile(path: string, maxBytes?: number): Stats {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 ||
      (maxBytes !== undefined && entry.size > maxBytes)) throw new UnavailableContent();
  return entry;
}
function writeNew(path: string, contents: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function contentIdentity(descriptor: Omit<CaptureDescriptor, 'artifactId' | 'fingerprint'>): string {
  const { version, operationId, projectId, assetId, kind, name, notes, requestId,
    slotId, claims, inputs, gaps, members } = descriptor;
  return JSON.stringify({ version, operationId, projectId, assetId, kind, name,
    notes, requestId, slotId, claims, inputs, gaps,
    members: members.map(member => [member.ordinal, member.storedName, member.sourceName,
      member.byteCount, member.sha256, member.mediaType ?? null]) });
}
export function captureFingerprint(descriptor: Omit<CaptureDescriptor, 'artifactId' | 'fingerprint'>): string {
  return createHash('sha256').update(contentIdentity(descriptor)).digest('hex');
}
export function sameMembers(left: readonly StoredMember[], right: readonly StoredMember[]): boolean {
  return left.length === right.length && left.every((member, index) => {
    const other = right[index]!;
    return member.ordinal === other.ordinal && member.storedName === other.storedName &&
      member.sourceName === other.sourceName && member.byteCount === other.byteCount &&
      member.sha256 === other.sha256 && (member.mediaType ?? null) === (other.mediaType ?? null);
  });
}
export function makeDescriptor(metadata: CaptureMetadata, artifactId: string, members: StoredMember[]): CaptureDescriptor {
  const identity = {
    version: 1 as const,
    operationId: metadata.operationId,
    projectId: metadata.projectId,
    assetId: metadata.assetId,
    kind: metadata.kind,
    name: metadata.name,
    notes: metadata.notes ?? '',
    requestId: metadata.requestId ?? null,
    slotId: metadata.slotId ?? null,
    claims: metadata.claims ?? [],
    inputs: metadata.inputs ?? [],
    gaps: metadata.gaps ?? [],
    members,
  };
  return { ...identity, artifactId, fingerprint: captureFingerprint(identity) };
}

@Injectable()
export class ContentStore {
  constructor(private readonly profile: ProfileService) {}

  private async roots(): Promise<{ staging: string; artwork: string }> {
    await this.profile.verifyAsync();
    const staging = join(this.profile.path, 'staging');
    const artwork = join(this.profile.path, 'artwork');
    directory(staging);
    directory(artwork);
    return { staging, artwork };
  }
  private async publishedPath(artifactId: string): Promise<string> {
    artifactName.parse(artifactId);
    const path = join((await this.roots()).artwork, artifactId);
    directory(path);
    return path;
  }

  /** A private owner reserves each new destination; a collision never replaces another directory. */
  async prepare(artifactId: string, operationId: string): Promise<CaptureStage> {
    artifactName.parse(artifactId);
    artifactName.parse(operationId);
    const { staging, artwork } = await this.roots();
    const final = join(artwork, artifactId);
    if (occupied(final)) throw new UnavailableContent();
    const reservation = join(artwork, `.reserve-${artifactId}`);
    mkdirSync(reservation);
    try {
      const path = join(staging, artifactId);
      mkdirSync(path);
      // Incomplete staging is intentionally retained for explicit inspection.
      writeNew(join(path, 'operation.json'), JSON.stringify({ operationId }));
      return { artifactId, operationId, directory: path, reservation };
    } catch (error) {
      rmdirSync(reservation);
      throw error;
    }
  }
  async writeMember(stage: CaptureStage | null, ordinal: number, declared: CaptureMetadata['members'][number],
    input: Readable, signal: AbortSignal): Promise<StoredMember> {
    const { staging } = await this.roots();
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= captureLimits.members) throw new UnavailableContent();
    if (stage) {
      if (stage.directory !== join(staging, stage.artifactId)) throw new UnavailableContent();
      directory(stage.directory);
    }
    const storedName = `${String(ordinal).padStart(4, '0')}.bin`;
    const handle = stage ? await open(join(stage.directory, storedName), 'wx', 0o600) : null;
    const hash = createHash('sha256');
    let byteCount = 0;
    try {
      for await (const chunk of input) {
        if (signal.aborted) throw new IncompleteContent('The capture transfer was interrupted.');
        const bytes = chunk as Buffer;
        byteCount += bytes.length;
        if (byteCount > captureLimits.memberBytes || byteCount > declared.byteCount) {
          throw new IncompleteContent('Member exceeds its declared byte count or transfer limit.');
        }
        hash.update(bytes);
        if (handle) {
          let offset = 0;
          while (offset < bytes.length) {
            const written = await handle.write(bytes, offset, bytes.length - offset);
            if (written.bytesWritten === 0) throw new IncompleteContent('The member could not be written completely.');
            offset += written.bytesWritten;
          }
        }
      }
      if (signal.aborted || (input as Readable & { truncated?: boolean }).truncated ||
          byteCount !== declared.byteCount || hash.digest('hex') !== declared.sha256) {
        throw new IncompleteContent('Member bytes are truncated, missing, or differ from their declared hash.');
      }
      if (handle) await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
    return { ordinal, storedName, ...declared };
  }
  async finish(stage: CaptureStage, descriptor: CaptureDescriptor): Promise<void> {
    await this.roots();
    directory(stage.directory);
    if (stage.artifactId !== descriptor.artifactId || stage.operationId !== descriptor.operationId ||
        descriptor.fingerprint !== captureFingerprint(descriptor)) throw new UnavailableContent();
    writeNew(join(stage.directory, 'manifest.json'), JSON.stringify(descriptor));
  }
  async publish(stage: CaptureStage): Promise<void> {
    const { staging, artwork } = await this.roots();
    const target = join(artwork, stage.artifactId);
    if (stage.directory !== join(staging, stage.artifactId) || stage.reservation !== join(artwork, `.reserve-${stage.artifactId}`)) {
      throw new UnavailableContent();
    }
    directory(stage.reservation);
    directory(stage.directory);
    if (occupied(target)) throw new UnavailableContent();
    const manifestPath = join(stage.directory, 'manifest.json');
    regularFile(manifestPath, maxDescriptorBytes);
    let manifest: unknown;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch { throw new UnavailableContent(); }
    const parsed = captureDescriptor.safeParse(manifest);
    if (!parsed.success || parsed.data.artifactId !== stage.artifactId ||
        parsed.data.operationId !== stage.operationId ||
        parsed.data.fingerprint !== captureFingerprint(parsed.data)) throw new UnavailableContent();
    for (const [ordinal, member] of parsed.data.members.entries()) {
      if (member.ordinal !== ordinal || member.storedName !== `${String(ordinal).padStart(4, '0')}.bin` ||
          regularFile(join(stage.directory, member.storedName), member.byteCount).size !== member.byteCount) {
        throw new UnavailableContent();
      }
    }
    renameSync(stage.directory, target);
    rmdirSync(stage.reservation);
  }
  /** A failed or interrupted transfer leaves its staging evidence; release only the transient reservation. */
  async release(stage: CaptureStage): Promise<void> {
    try {
      const { artwork } = await this.roots();
      if (stage.reservation === join(artwork, `.reserve-${stage.artifactId}`) && existsSync(stage.reservation)) {
        directory(stage.reservation);
        rmdirSync(stage.reservation);
      }
    } catch { /* Preserve the original failure and leave unsafe paths untouched. */ }
  }
  async readDescriptor(artifactId: string): Promise<CaptureDescriptor> {
    const path = await this.publishedPath(artifactId);
    const manifest = join(path, 'manifest.json');
    regularFile(manifest, maxDescriptorBytes);
    let data: unknown;
    try { data = JSON.parse(readFileSync(manifest, 'utf8')); }
    catch { throw new UnavailableContent(); }
    const parsed = captureDescriptor.safeParse(data);
    if (!parsed.success || parsed.data.artifactId !== artifactId) throw new UnavailableContent();
    const descriptor = parsed.data;
    if (descriptor.fingerprint !== captureFingerprint(descriptor) ||
        descriptor.members.some((member, ordinal) => member.ordinal !== ordinal ||
          member.storedName !== `${String(ordinal).padStart(4, '0')}.bin`)) throw new UnavailableContent();
    return descriptor;
  }
  /** Read from a new file descriptor after lstat; reject linked files and changed bytes. */
  async verifyMember(artifactId: string, member: StoredMember, scratch = Buffer.allocUnsafe(64 * 1024)): Promise<string> {
    const root = await this.publishedPath(artifactId);
    if (member.ordinal < 0 || member.storedName !== `${String(member.ordinal).padStart(4, '0')}.bin`) throw new UnavailableContent();
    const path = join(root, member.storedName);
    regularFile(path, captureLimits.memberBytes);
    const handle = await open(path, 'r');
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.size !== member.byteCount) throw new UnavailableContent();
      const hash = createHash('sha256');
      let total = 0;
      while (true) {
        const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > member.byteCount) throw new UnavailableContent();
        hash.update(scratch.subarray(0, bytesRead));
      }
      if (total !== member.byteCount || hash.digest('hex') !== member.sha256) throw new UnavailableContent();
      return path;
    } finally {
      await handle.close();
    }
  }
  async verifyDescriptor(descriptor: CaptureDescriptor): Promise<void> {
    const scratch = Buffer.allocUnsafe(64 * 1024);
    for (const member of descriptor.members) await this.verifyMember(descriptor.artifactId, member, scratch);
  }
  async memberPath(artifactId: string, member: StoredMember): Promise<string> {
    const root = await this.publishedPath(artifactId);
    if (member.storedName !== `${String(member.ordinal).padStart(4, '0')}.bin`) throw new UnavailableContent();
    const path = join(root, member.storedName);
    if (regularFile(path, member.byteCount).size !== member.byteCount) throw new UnavailableContent();
    return path;
  }
  /** Inspect one recovery report with fresh whole-profile checks around the complete read-only walk.
   * Nothing here is retained for later requests or used to bypass their per-access verification. */
  async inspectForReconciliation(): Promise<{
    incompleteStaging: { directory: string; operationId: string | null }[];
    published: { name: string; descriptor?: CaptureDescriptor }[];
  }> {
    await this.profile.verifyAsync();
    try {
      const staging = join(this.profile.path, 'staging');
      const artwork = join(this.profile.path, 'artwork');
      directory(staging);
      directory(artwork);
      let scratch: Buffer | undefined;
      const incompleteStaging: { directory: string; operationId: string | null }[] = [];
      const published: { name: string; descriptor?: CaptureDescriptor }[] = [];

      function readIncompleteOperation(name: string): string | null {
        if (!artifactName.safeParse(name).success) return null;
        try {
          directory(staging);
          const root = join(staging, name);
          directory(root);
          const file = join(root, 'operation.json');
          regularFile(file, 2048);
          const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
          return z.strictObject({ operationId: artifactName }).parse(data).operationId;
        } catch { return null; }
      }

      function readDescriptor(artifactId: string, root: string): CaptureDescriptor {
        const manifest = join(root, 'manifest.json');
        regularFile(manifest, maxDescriptorBytes);
        let data: unknown;
        try { data = JSON.parse(readFileSync(manifest, 'utf8')); }
        catch { throw new UnavailableContent(); }
        const parsed = captureDescriptor.safeParse(data);
        if (!parsed.success || parsed.data.artifactId !== artifactId) throw new UnavailableContent();
        const descriptor = parsed.data;
        if (descriptor.fingerprint !== captureFingerprint(descriptor) ||
            descriptor.members.some((member, ordinal) => member.ordinal !== ordinal ||
              member.storedName !== `${String(ordinal).padStart(4, '0')}.bin`)) throw new UnavailableContent();
        return descriptor;
      }

      async function verifyMember(root: string, member: StoredMember): Promise<void> {
        if (member.ordinal < 0 || member.storedName !== `${String(member.ordinal).padStart(4, '0')}.bin`) throw new UnavailableContent();
        const path = join(root, member.storedName);
        regularFile(path, captureLimits.memberBytes);
        const handle = await open(path, 'r');
        try {
          const stats = await handle.stat();
          if (!stats.isFile() || stats.nlink !== 1 || stats.size !== member.byteCount) throw new UnavailableContent();
          const hash = createHash('sha256');
          const buffer = scratch ??= Buffer.allocUnsafe(64 * 1024);
          let total = 0;
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > member.byteCount) throw new UnavailableContent();
            hash.update(buffer.subarray(0, bytesRead));
          }
          if (total !== member.byteCount || hash.digest('hex') !== member.sha256) throw new UnavailableContent();
        } finally {
          await handle.close();
        }
      }

      directory(staging);
      for (const { name } of readdirSync(staging, { withFileTypes: true })) {
        incompleteStaging.push({ directory: name, operationId: readIncompleteOperation(name) });
      }
      directory(artwork);
      for (const { name } of readdirSync(artwork, { withFileTypes: true })) {
        let descriptor: CaptureDescriptor | undefined;
        if (artifactName.safeParse(name).success) {
          try {
            const root = join(artwork, name);
            directory(artwork);
            directory(root);
            const candidate = readDescriptor(name, root);
            for (const member of candidate.members) {
              directory(artwork);
              directory(root);
              await verifyMember(root, member);
            }
            descriptor = candidate;
          } catch { /* Invalid content is reported as unavailable or an orphan without claiming a valid descriptor. */ }
        }
        published.push({ name, descriptor });
      }
      return { incompleteStaging, published };
    } finally {
      await this.profile.verifyAsync();
    }
  }

  /** Listed names are not followed: reconciliation never traverses arbitrary symlinks. */
  async listDirectories(kind: 'artwork' | 'staging'): Promise<string[]> {
    const root = (await this.roots())[kind];
    return readdirSync(root, { withFileTypes: true }).map(entry => entry.name);
  }
}
