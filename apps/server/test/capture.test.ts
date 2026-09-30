import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer, type RunningService } from '../src/main.js';
import { captureLimits, type CaptureMetadata, type CaptureReceipt, type CaptureRecord } from '@assetweave/contracts/capture';
import type { QueryPage } from '@assetweave/contracts/queries';
import type { ArtifactSummary } from '../src/capture/capture.service.js';
import { createStore, createStoredArtifact, type TestStore } from './helpers/store-fixture.js';

const windowsOnly = process.platform !== 'win32';
const onePixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9RyCYAAAAASUVORK5CYII=', 'base64');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

async function openHttp(store: TestStore): Promise<{ server: RunningService; bearer: string }> {
  store.database.close();
  store.profile.close();
  const webDist = join(store.root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html>test shell</html>');
  const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
  const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
  return { server, bearer };
}
function metadata(projectId: string, assetId: string, files: readonly Buffer[], extras: Partial<CaptureMetadata> = {}): CaptureMetadata {
  return {
    operationId: randomUUID(), projectId, assetId, kind: files.length > 1 ? 'png-sequence' : 'png',
    name: 'Captured work', members: files.map((bytes, index) =>
      ({ sourceName: `frame-${index}.png`, byteCount: bytes.length, sha256: digest(bytes), mediaType: 'image/png' })),
    ...extras,
  };
}
function multipart(input: CaptureMetadata, files: readonly Buffer[], names = files.map((_, index) => `member${index}`)): FormData {
  const data = new FormData();
  data.append('metadata', JSON.stringify(input));
  for (const [index, bytes] of files.entries()) {
    data.append(names[index]!, new Blob([
      new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
    ], { type: 'image/png' }), `frame-${index}.png`);
  }
  return data;
}
function auth(bearer: string): HeadersInit { return { Authorization: `Bearer ${bearer}` }; }
async function send(server: RunningService, bearer: string, input: CaptureMetadata, files: readonly Buffer[], names?: string[]): Promise<Response> {
  return fetch(`${server.origin}/api/captures`, { method: 'POST', headers: auth(bearer), body: multipart(input, files, names) });
}
async function receipt(server: RunningService, bearer: string, operationId: string): Promise<CaptureReceipt> {
  const response = await fetch(`${server.origin}/api/captures/operations/${operationId}`, { headers: auth(bearer) });
  assert.equal(response.status, 200);
  return response.json() as Promise<CaptureReceipt>;
}

test('AE1/AE2/AE10: private bytes survive original deletion and restart; equal bytes in new operations remain distinct', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Local art' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Knight' }, 'human');
  const original = join(store.root, 'original.png');
  writeFileSync(original, onePixel);
  const input = metadata(project.id, asset.id, [readFileSync(original)], { kind: 'opaque' });
  const { server, bearer } = await openHttp(store);
  let artifactId: string;
  try {
    const first = await send(server, bearer, input, [readFileSync(original)]);
    assert.equal(first.status, 201);
    const saved = await first.json() as CaptureReceipt;
    assert.equal(saved.status, 'committed');
    artifactId = saved.artifactId;
    unlinkSync(original);
    const originalBytes = await fetch(`${server.origin}/api/artifacts/${artifactId}/members/0/original`, { headers: auth(bearer) });
    assert.equal(originalBytes.status, 200);
    assert.equal(originalBytes.headers.get('content-type'), 'application/octet-stream');
    assert.equal(originalBytes.headers.get('content-disposition'), 'attachment; filename="original.bin"');
    assert.equal(digest(Buffer.from(await originalBytes.arrayBuffer())), input.members[0]!.sha256);
    const details = await fetch(`${server.origin}/api/artifacts/${artifactId}`, { headers: auth(bearer) });
    const record = await details.json() as CaptureRecord;
    assert.equal(record.content, 'available');
    assert.equal(record.candidateId, null);
    assert.equal(record.requestId, null);
    assert.deepEqual(record.members.map(member => [member.ordinal, member.byteCount, member.sha256]),
      [[0, onePixel.length, digest(onePixel)]]);
    const duplicate = await send(server, bearer, input, [onePixel]);
    const replay = await duplicate.json() as CaptureReceipt;
    assert.equal(replay.status, 'committed');
    if (replay.status !== 'committed') throw new Error('A matching resubmission must return a committed receipt.');
    assert.equal(replay.artifactId, artifactId);
    const changed = await send(server, bearer, { ...input, name: 'Changed context' }, [onePixel]);
    assert.equal(changed.status, 409);
    const editedBytes = Buffer.from(onePixel);
    editedBytes[editedBytes.length - 1] = editedBytes[editedBytes.length - 1]! ^ 1;
    const changedBytes = await send(server, bearer, {
      ...input, members: [{ ...input.members[0]!, sha256: digest(editedBytes) }],
    }, [editedBytes]);
    assert.equal(changedBytes.status, 409);
    const other = await send(server, bearer, metadata(project.id, asset.id, [onePixel], { kind: 'opaque' }), [onePixel]);
    assert.equal(other.status, 201);
    const another = await other.json() as CaptureReceipt;
    assert.equal(another.status, 'committed');
    if (another.status !== 'committed') throw new Error('A distinct operation must commit a new artifact.');
    assert.notEqual(another.artifactId, artifactId);
  } finally { await server.close(); }
  const resumed = await openHttp(store);
  try {
    assert.equal((await receipt(resumed.server, resumed.bearer, input.operationId)).status, 'committed');
    const preserved = await fetch(`${resumed.server.origin}/api/artifacts/${artifactId!}/members/0/original`,
      { headers: auth(resumed.bearer) });
    assert.equal(digest(Buffer.from(await preserved.arrayBuffer())), digest(onePixel));
  } finally { await resumed.server.close(); }
  // A substituted registered file is reported, not auto-repaired or misrepresented as available.
  writeFileSync(join(store.profilePath, 'artwork', artifactId!, '0000.bin'), 'changed private content');
  const unavailable = await openHttp(store);
  try {
    const listed = await fetch(`${unavailable.server.origin}/api/assets/${asset.id}/artifacts`, { headers: auth(unavailable.bearer) });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as QueryPage<ArtifactSummary>).items.find(row => row.id === artifactId)?.content, 'not-checked');
    const record = await fetch(`${unavailable.server.origin}/api/artifacts/${artifactId}`, { headers: auth(unavailable.bearer) });
    assert.equal((await record.json() as CaptureRecord).content, 'unavailable');
    assert.equal((await receipt(unavailable.server, unavailable.bearer, input.operationId)).status, 'unavailable');
    const download = await fetch(`${unavailable.server.origin}/api/artifacts/${artifactId}/members/0/original`,
      { headers: auth(unavailable.bearer) });
    assert.equal(download.status, 503);
    assert.equal((await download.json() as { code: string }).code, 'CONTENT_UNAVAILABLE');
    const report = await fetch(`${unavailable.server.origin}/api/captures/recovery`, { headers: auth(unavailable.bearer) });
    assert.ok((await report.json() as { unavailableContent: { artifactId: string }[] })
      .unavailableContent.some(row => row.artifactId === artifactId));
  } finally { await unavailable.server.close(); }
});

test('content verification refuses runtime reparse substitution and insecure ACL after startup', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Runtime boundary' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Private artwork' }, 'human');
  const { server, bearer } = await openHttp(store);
  try {
    const captured = await send(server, bearer, metadata(project.id, asset.id, [onePixel]), [onePixel]);
    assert.equal(captured.status, 201);
    const { artifactId } = await captured.json() as CaptureReceipt & { artifactId: string };
    const detailUrl = `${server.origin}/api/artifacts/${artifactId}`;
    const originalUrl = `${detailUrl}/members/0/original`;
    const detail = async () => {
      const response = await fetch(detailUrl, { headers: auth(bearer) });
      assert.equal(response.status, 200);
      return (await response.json() as CaptureRecord).content;
    };
    assert.equal(await detail(), 'available');
    const substituted = join(store.profilePath, 'artwork', 'substituted-junction');
    symlinkSync(store.root, substituted, 'junction');
    try {
      assert.equal(await detail(), 'unavailable');
      assert.equal((await fetch(originalUrl, { headers: auth(bearer) })).status, 503);
    } finally {
      unlinkSync(substituted);
    }
    assert.equal(await detail(), 'available');

    const artwork = join(store.profilePath, 'artwork');
    const grant = spawnSync('icacls.exe', [artwork, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { encoding: 'utf8' });
    assert.equal(grant.status, 0, grant.stderr);
    try {
      assert.equal(await detail(), 'unavailable');
      assert.equal((await fetch(originalUrl, { headers: auth(bearer) })).status, 503);
    } finally {
      const remove = spawnSync('icacls.exe', [artwork, '/remove:g', '*S-1-5-32-545'], { encoding: 'utf8' });
      assert.equal(remove.status, 0, remove.stderr);
    }
    assert.equal(await detail(), 'available');
  } finally { await server.close(); }
});

test('artifact metadata pages advance by captured time and ID and reject invalid queries', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Paged art' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Frames' }, 'human');
  const created = Array.from({ length: 3 }, () => createStoredArtifact(store, asset.id).artifactId);
  const { server, bearer } = await openHttp(store);
  try {
    const url = `${server.origin}/api/assets/${asset.id}/artifacts`;
    const firstResponse = await fetch(`${url}?limit=1`, { headers: auth(bearer) });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as QueryPage<ArtifactSummary>;
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const secondResponse = await fetch(`${url}?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`, { headers: auth(bearer) });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as QueryPage<ArtifactSummary>;
    assert.notEqual(second.items[0]!.id, first.items[0]!.id);
    const third = await (await fetch(`${url}?limit=1&cursor=${encodeURIComponent(second.nextCursor!)}`,
      { headers: auth(bearer) })).json() as QueryPage<ArtifactSummary>;
    assert.deepEqual(new Set([...first.items, ...second.items, ...third.items].map(row => row.id)), new Set(created));
    assert.equal(third.nextCursor, null);
    assert.equal((await fetch(`${url}?limit=51`, { headers: auth(bearer) })).status, 400);
    assert.equal((await fetch(`${url}?unknown=1`, { headers: auth(bearer) })).status, 400);
  } finally { await server.close(); }
});

test('project name ties paginate without duplicates and mutations invalidate continuations', { skip: windowsOnly }, t => {
  const store = createStore(t);
  const projects = Array.from({ length: 3 }, () => store.catalog.createProject({ name: 'Same name' }, 'human'));
  const first = store.catalog.listProjects({ limit: 1 });
  const second = store.catalog.listProjects({ limit: 1, cursor: first.nextCursor! });
  const third = store.catalog.listProjects({ limit: 1, cursor: second.nextCursor! });
  assert.deepEqual(new Set([...first.items, ...second.items, ...third.items].map(row => row.id)),
    new Set(projects.map(row => row.id)));
  assert.equal(third.nextCursor, null);
  store.catalog.createProject({ name: 'New project' }, 'human');
  assert.throws(() => store.catalog.listProjects({ limit: 1, cursor: first.nextCursor! }), /catalog changed/);
});

test('AE18: complete ordered sequence, sourced facts, three actual inputs, request and slot placement commit together', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Sprite art' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Walk' }, 'human');
  const slot = store.catalog.createSlot(asset.id, { name: 'Walk / north' }, 'human');
  const sources = [createStoredArtifact(store, asset.id), createStoredArtifact(store, asset.id),
    createStoredArtifact(store, asset.id)];
  const request = store.requests.createRequest(project.id, asset.id, {
    intent: 'Try a walk', proposedInputs: [{ artifactId: sources[0]!.artifactId }],
  }, 'agent');
  const frames = [onePixel, onePixel, onePixel];
  const input = metadata(project.id, asset.id, frames, {
    requestId: request.id, slotId: slot.id, name: 'North walk',
    claims: [
      { field: 'producer', state: 'known', value: 'local drawing', source: { kind: 'human' } },
      { field: 'productionTime', state: 'unknown', source: { kind: 'artist' } },
      { field: 'seed', state: 'absent', source: { kind: 'artist' } },
    ],
    inputs: sources.map((source, index) => ({ artifactId: source.artifactId, role: index === 0 ? 'starting artwork' : 'reference' })),
    gaps: [{ kind: 'upstream', description: 'Earlier pencil study not preserved', sourceKind: 'artist' }],
  });
  const { server, bearer } = await openHttp(store);
  let artifactId: string;
  try {
    const result = await send(server, bearer, input, frames);
    assert.equal(result.status, 201);
    const saved = await result.json() as CaptureReceipt;
    assert.equal(saved.status, 'committed');
    artifactId = saved.artifactId;
    for (const [index, frame] of frames.entries()) {
      const part = await fetch(`${server.origin}/api/artifacts/${artifactId}/members/${index}/original`, { headers: auth(bearer) });
      assert.equal(digest(Buffer.from(await part.arrayBuffer())), digest(frame));
    }
    const resultRecord = await fetch(`${server.origin}/api/artifacts/${artifactId}`, { headers: auth(bearer) });
    const sequence = await resultRecord.json() as CaptureRecord;
    assert.deepEqual(sequence.members.map(member => [member.ordinal, member.sourceName]),
      [[0, 'frame-0.png'], [1, 'frame-1.png'], [2, 'frame-2.png']]);
    assert.ok(sequence.candidateId);
    const listed = await fetch(`${server.origin}/api/assets/${asset.id}/artifacts`, { headers: auth(bearer) });
    assert.ok((await listed.json() as QueryPage<ArtifactSummary>).items.some(row =>
      row.id === artifactId && row.requestId === request.id && row.content === 'not-checked' &&
      row.candidateId === sequence.candidateId && row.candidateCount === 1));
  } finally { await server.close(); }
  store.reopen();
  assert.deepEqual(store.requests.getRequest(request.id).capturedArtifacts.map(row => row.id), [artifactId!]);
  assert.equal(store.requests.getRequest(request.id).outcome.status, 'unknown');
  assert.deepEqual(store.provenance.listClaims(artifactId!, { limit: 20 }).items.map(row => row.claim.state).sort(),
    ['absent', 'known', 'unknown']);
  assert.deepEqual(store.lineage.listInputs(artifactId!, { limit: 20 }).items.map(row => row.input.artifactId).sort(),
    sources.map(row => row.artifactId).sort());
  assert.deepEqual(store.lineage.listGaps(artifactId!, { limit: 20 }).items.map(row => row.gap.description),
    ['Earlier pencil study not preserved']);
  assert.deepEqual(store.catalog.listCandidates(slot.id, { limit: 2 }).items.map(row => row.artifactId), [artifactId!]);
  assert.equal(store.catalog.getSlot(slot.id).selectedCandidateId, null);
});

test('AE18: absent, duplicate and unexpected parts, changed bytes, path metadata and failed final association never register', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Rejected work' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Character' }, 'human');
  const missingSlotId = randomUUID();
  const source = createStoredArtifact(store, asset.id);
  const { server, bearer } = await openHttp(store);
  try {
    const frames = [onePixel, onePixel];
    const missing = metadata(project.id, asset.id, frames);
    const missingResponse = await send(server, bearer, missing, [onePixel]);
    assert.equal(missingResponse.status, 400);
    assert.equal((await missingResponse.json() as { code: string }).code, 'INCOMPLETE_CAPTURE');
    assert.equal((await receipt(server, bearer, missing.operationId)).status, 'absent');
    const repeated = metadata(project.id, asset.id, frames);
    assert.equal((await send(server, bearer, repeated, frames, ['member0', 'member0'])).status, 400);
    const unexpected = metadata(project.id, asset.id, [onePixel]);
    assert.equal((await send(server, bearer, unexpected, frames)).status, 400);
    const malformed = metadata(project.id, asset.id, [onePixel]);
    assert.equal((await send(server, bearer, malformed, [Buffer.from('altered same size')])).status, 400);
    const oversized = Buffer.alloc(captureLimits.memberBytes + 1);
    const limited = metadata(project.id, asset.id, [oversized.subarray(0, captureLimits.memberBytes)]);
    assert.equal((await send(server, bearer, limited, [oversized])).status, 400);
    assert.equal((await receipt(server, bearer, limited.operationId)).status, 'absent');
    const aggregate = metadata(project.id, asset.id, [onePixel, onePixel], {
      members: Array.from({ length: 5 }, (_, index) =>
        ({ sourceName: `frame-${index}.png`, byteCount: captureLimits.memberBytes,
          sha256: digest(onePixel), mediaType: 'image/png' })),
    });
    assert.equal((await send(server, bearer, aggregate, [onePixel])).status, 400);
    const path = metadata(project.id, asset.id, [onePixel]);
    path.members[0]!.sourceName = '..\\catalog.sqlite';
    assert.equal((await send(server, bearer, path, [onePixel])).status, 400);
    const operation = metadata(project.id, asset.id, [onePixel], {
      slotId: missingSlotId, inputs: [{ artifactId: source.artifactId }],
      claims: [{ field: 'prompt', state: 'known', value: 'missing placement', source: { kind: 'artist' } }],
    });
    assert.equal((await send(server, bearer, operation, [onePixel])).status, 404);
    assert.equal((await receipt(server, bearer, operation.operationId)).status, 'orphan');
    const recovery = await fetch(`${server.origin}/api/captures/recovery`, { headers: auth(bearer) });
    assert.ok((await recovery.json() as { publishedOrphans: { operationId: string | null }[] })
      .publishedOrphans.some(item => item.operationId === operation.operationId));
  } finally { await server.close(); }
  store.reopen();
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE asset_id = ?')
    .get(asset.id)!.count, 1);
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM provenance_assertions WHERE field = ?')
    .get('prompt')!.count, 0);
});
