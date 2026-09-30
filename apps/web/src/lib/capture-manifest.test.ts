import assert from 'node:assert/strict';
import { webcrypto, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { captureLimits } from '@assetweave/contracts/capture';
import { buildCaptureManifest, recoverCaptureOperation, validateCaptureSelection, verifyCaptureReplay } from './capture-manifest.js';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const file = (name: string, contents: string) => new File([contents], name, { type: 'image/png' });
const fields = (kind = 'png-sequence') => ({
  operationId: randomUUID(), projectId: randomUUID(), assetId: randomUUID(), kind, name: 'Actual artwork',
});

test('manifest hashes members in user-supplied, nonlexical order, never filename order', async () => {
  const files = [file('frame20.png', 'second'), file('frame2.png', 'first'), file('frame8.png', 'third')];
  const metadata = await buildCaptureManifest(files, fields());
  assert.deepEqual(metadata.members.map(member => member.sourceName), ['frame20.png', 'frame2.png', 'frame8.png']);
  assert.deepEqual(metadata.members.map(member => member.byteCount), [6, 5, 5]);
  const firstMember = metadata.members.at(0);
  assert.ok(firstMember, 'The first declared member must exist.');
  assert.equal(firstMember.sha256, '16367aacb67a4a017c8da8ab95682ccb390863780f7114dda0a0e0c55644c7c4');
});

test('rejects duplicate filenames and missing selected members', () => {
  assert.match(validateCaptureSelection([file('frame-1.png', 'a'), file('frame-1.png', 'b')], 'png-sequence')!, /Duplicate filename/);
  assert.match(validateCaptureSelection([file('a.png', 'a'), undefined as unknown as File], 'png-sequence')!, /Select all files/);
});

test('enforces zero, per-member, aggregate and member-count limits without reading file bytes', () => {
  assert.match(validateCaptureSelection([file('empty.png', '')], 'png')!, /empty or missing/);
  const sizedFile = (name: string, size: number) =>
    ({ name, size, type: 'image/png' }) as File; // Validation reads metadata only; no 160 MiB fixture.
  assert.match(validateCaptureSelection([sizedFile('big.png', captureLimits.memberBytes + 1)], 'opaque')!, /per-file limit/);
  const aggregate = Array.from({ length: 5 }, (_, index) =>
    sizedFile(`frame-${index}.png`, captureLimits.memberBytes));
  assert.match(validateCaptureSelection(aggregate, 'png-sequence')!, /total limit/);
  const many = Array.from({ length: captureLimits.members + 1 }, (_, index) => file(`file-${index}.png`, 'a'));
  assert.match(validateCaptureSelection(many, 'png-sequence')!, /no more than/);
});

test('rejects metadata above the multipart field limit before upload', async () => {
  const claims = Array.from({ length: 17 }, (_, index) => ({
    field: `source-field-${index}`, state: 'unknown' as const,
    source: { kind: 'written notes', detail: 'x'.repeat(16_384) },
  }));
  await assert.rejects(
    buildCaptureManifest([file('one.png', 'bytes')], { ...fields('png'), claims }),
    /metadata exceeds the 256 KiB limit/,
  );
});

test('single PNG, spritesheet, irregular atlas, GIF or opaque inputs are permitted but multiple files require sequence kind', async () => {
  for (const kind of ['png', 'png-spritesheet', 'irregular-atlas', 'gif', 'opaque']) {
    const selected = kind === 'gif' ? new File(['bytes'], 'one.gif', { type: 'image/gif' }) :
      kind === 'opaque' ? new File(['bytes'], 'original.aseprite') : file('one.png', 'bytes');
    assert.equal(validateCaptureSelection([selected], kind), null);
    assert.equal((await buildCaptureManifest([selected], fields(kind))).kind, kind);
  }
  assert.match(validateCaptureSelection([file('one.png', 'a'), file('two.png', 'b')], 'gif')!, /Multiple files/);
  assert.match(validateCaptureSelection([file('one.png', 'a')], 'png-sequence')!, /at least two/);
  assert.match(validateCaptureSelection([file('one.png', 'a'), file('two.gif', 'b')], 'png-sequence')!, /not a PNG/);
});

test('orphan replay preserves the original context and requires exact ordered reselected members', async () => {
  const originals = [file('later.png', 'second frame'), file('earlier.png', 'first frame')];
  const metadata = await buildCaptureManifest(originals, {
    ...fields(), name: 'Original artwork', notes: 'Original notes', slotId: randomUUID(),
    requestId: randomUUID(), claims: [{ field: 'prompt', state: 'known', value: 'from artist notes',
      source: { kind: 'artist notes' } }],
  });
  const recovered = recoverCaptureOperation(JSON.stringify({ operationId: metadata.operationId, metadata }),
    metadata.projectId, metadata.assetId);
  assert.deepEqual(recovered?.metadata, metadata);
  await verifyCaptureReplay([file('later.png', 'second frame'), file('earlier.png', 'first frame')], recovered!.metadata!);
  await assert.rejects(verifyCaptureReplay([file('earlier.png', 'first frame'), file('later.png', 'second frame')], metadata), /matching names, bytes, media types, and order/);
  await assert.rejects(verifyCaptureReplay([file('later.png', 'edited frame'), file('earlier.png', 'first frame')], metadata), /matching names, bytes, media types, and order/);
  await assert.rejects(verifyCaptureReplay([file('renamed.png', 'second frame'), file('earlier.png', 'first frame')], metadata), /matching names, bytes, media types, and order/);
  await assert.rejects(verifyCaptureReplay([new File(['second frame'], 'later.png', { type: 'application/octet-stream' }),
    file('earlier.png', 'first frame')], metadata), /matching names, bytes, media types, and order/);
});

test('restored operation ID survives missing, invalid, or wrong-destination metadata without authorizing replay', async () => {
  const metadata = await buildCaptureManifest([file('one.png', 'original')], fields('png'));
  assert.deepEqual(recoverCaptureOperation(metadata.operationId, metadata.projectId, metadata.assetId),
    { operationId: metadata.operationId, metadata: null });
  assert.deepEqual(recoverCaptureOperation(JSON.stringify({ operationId: metadata.operationId,
    metadata: { ...metadata, members: [] } }), metadata.projectId, metadata.assetId),
  { operationId: metadata.operationId, metadata: null });
  assert.deepEqual(recoverCaptureOperation(JSON.stringify({ operationId: metadata.operationId, metadata }),
    metadata.projectId, randomUUID()), { operationId: metadata.operationId, metadata: null });
});

test('does not declare an unreadable or changed file', async () => {
  const unreadable = file('one.png', 'original');
  unreadable.arrayBuffer = async () => { throw new Error('file missing'); };
  await assert.rejects(buildCaptureManifest([unreadable], fields('png')), /no longer readable/);
  const changed = file('one.png', 'original');
  changed.arrayBuffer = async () => new TextEncoder().encode('changed').buffer;
  await assert.rejects(buildCaptureManifest([changed], fields('png')), /changed while hashing/);
});
