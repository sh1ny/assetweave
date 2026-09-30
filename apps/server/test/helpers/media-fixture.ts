import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureMetadata, CaptureReceipt } from '@assetweave/contracts/capture';
import { startServer, type RunningService } from '../../src/main.js';
import type { TestStore } from './store-fixture.js';

export function fixture(name: string): Buffer {
  return readFileSync(new URL(`../../../../../tests/fixtures/media/${name}`, import.meta.url));
}
export async function mediaServer(store: TestStore): Promise<{ server: RunningService; bearer: string }> {
  store.database.close(); store.profile.close();
  const webDist = join(store.root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html>test shell</html>');
  const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
  const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
  return { server, bearer };
}
export function auth(bearer: string): Record<string, string> { return { Authorization: `Bearer ${bearer}` }; }
export async function captureFixtures(server: RunningService, bearer: string, projectId: string, assetId: string,
  names: string[], options: { kind?: string; mediaTypes?: string[]; sourceNames?: string[] } = {}): Promise<string> {
  const bytes = names.map(fixture);
  const input: CaptureMetadata = { operationId: randomUUID(), projectId, assetId,
    kind: options.kind ?? (names.length === 1 ? 'png' : 'png-sequence'), name: 'Preserved media',
    members: bytes.map((content, index) => ({ sourceName: options.sourceNames?.[index] ?? names[index]!, byteCount: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      mediaType: options.mediaTypes?.[index] ?? (names[index]!.endsWith('.gif') ? 'image/gif' : 'image/png') })) };
  const body = new FormData();
  body.append('metadata', JSON.stringify(input));
  bytes.forEach((content, index) => body.append(`member${index}`, new Blob([
    new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength),
  ], { type: input.members[index]!.mediaType }), input.members[index]!.sourceName));
  const response = await fetch(`${server.origin}/api/captures`, { method: 'POST', headers: auth(bearer), body });
  if (response.status !== 201) throw new Error(`Capture failed: ${response.status} ${await response.text()}`);
  const receipt = await response.json() as CaptureReceipt;
  if (receipt.status !== 'committed') throw new Error(`Unexpected capture status: ${receipt.status}`);
  return receipt.artifactId;
}
