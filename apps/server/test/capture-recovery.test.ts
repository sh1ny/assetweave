import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { CaptureMetadata, CaptureReceipt } from '@assetweave/contracts/capture';
import { CaptureService } from '../src/capture/capture.service.js';
import { ContentStore, IncompleteContent, makeDescriptor, UnavailableContent } from '../src/capture/content-store.js';
import { reconcileCapture } from '../src/capture/reconcile.js';
import { startServer } from '../src/main.js';
import { createStore } from './helpers/store-fixture.js';

const windowsOnly = process.platform !== 'win32';
const bytes = Buffer.from('complete opaque capture bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
function metadata(projectId: string, assetId: string, extras: Partial<CaptureMetadata> = {}): CaptureMetadata {
  return { operationId: randomUUID(), projectId, assetId, kind: 'opaque', name: 'Recovered sketch',
    members: [{ sourceName: 'sketch.bin', byteCount: bytes.length, sha256 }], ...extras };
}
function form(input: CaptureMetadata, file = bytes): FormData {
  const data = new FormData();
  data.append('metadata', JSON.stringify(input));
  data.append('member0', new Blob([
    new Uint8Array(file.buffer as ArrayBuffer, file.byteOffset, file.byteLength),
  ], { type: 'application/octet-stream' }), 'sketch.bin');
  return data;
}

test('crash boundaries report incomplete staging and exact published orphan; explicit replay commits only matching bytes/context', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Recovered' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Sketch' }, 'human');
  const content = new ContentStore(store.profile);
  const interrupted = metadata(project.id, asset.id);
  const partial = await content.prepare(randomUUID(), interrupted.operationId);
  await assert.rejects(content.writeMember(partial, 0, interrupted.members[0]!, Readable.from([bytes.subarray(0, 5)]),
    new AbortController().signal), IncompleteContent);
  // Simulate a process exit before publication. Neither stage nor claim is auto-registered on restart.
  const captured = metadata(project.id, asset.id, {
    inputs: [], claims: [{ field: 'seed', state: 'unknown', source: { kind: 'human' } }],
  });
  const orphan = await content.prepare(randomUUID(), captured.operationId);
  const member = await content.writeMember(orphan, 0, captured.members[0]!, Readable.from([bytes]), new AbortController().signal);
  const descriptor = makeDescriptor(captured, orphan.artifactId, [member]);
  await content.finish(orphan, descriptor);
  await content.publish(orphan);
  store.database.close();
  store.profile.close();
  const webDist = join(store.root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html>test</html>');
  const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
  try {
    const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
    const headers = { Authorization: `Bearer ${bearer}` };
    const report = await fetch(`${server.origin}/api/captures/recovery`, { headers });
    const found = await report.json() as { incompleteStaging: { operationId: string | null }[];
      publishedOrphans: { operationId: string | null }[] };
    assert.ok(found.incompleteStaging.some(row => row.operationId === interrupted.operationId));
    assert.ok(found.publishedOrphans.some(row => row.operationId === captured.operationId));
    const status = await fetch(`${server.origin}/api/captures/operations/${captured.operationId}`, { headers });
    assert.equal((await status.json() as CaptureReceipt).status, 'orphan');
    const changed = await fetch(`${server.origin}/api/captures`, { method: 'POST', headers,
      body: form({ ...captured, claims: [{ field: 'seed', state: 'absent', source: { kind: 'human' } }] }) });
    assert.equal(changed.status, 409);
    const resumed = await fetch(`${server.origin}/api/captures`, { method: 'POST', headers, body: form(captured) });
    assert.equal(resumed.status, 201);
    const receipt = await resumed.json() as CaptureReceipt;
    assert.equal(receipt.status, 'committed');
    assert.equal(receipt.artifactId, orphan.artifactId);
    const original = await fetch(`${server.origin}/api/artifacts/${orphan.artifactId}/members/0/original`, { headers });
    assert.equal(createHash('sha256').update(Buffer.from(await original.arrayBuffer())).digest('hex'), sha256);
  } finally { await server.close(); }
  store.reopen();
  const contentAfterRestart = new ContentStore(store.profile);
  const captureAfterRestart = new CaptureService(store.database, contentAfterRestart, store.catalog,
    store.requests, store.provenance, store.lineage);
  // An in-memory claim cannot hide a durable, fully verified receipt during request unwind.
  const active = Reflect.get(captureAfterRestart, 'active') as unknown;
  assert.ok(active instanceof Set);
  active.add(captured.operationId);
  const committedDuringUnwind = await captureAfterRestart.receipt(captured.operationId);
  assert.equal(committedDuringUnwind.status, 'committed');
  assert.equal(committedDuringUnwind.artifactId, orphan.artifactId);
  const final = await reconcileCapture(store.database.connection, contentAfterRestart);
  assert.ok(final.incompleteStaging.some(row => row.operationId === interrupted.operationId));
  assert.ok(!final.publishedOrphans.some(row => row.operationId === captured.operationId));
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE operation_id = ?')
    .get(captured.operationId)!.count, 1);
  writeFileSync(join(store.profilePath, 'artwork', orphan.artifactId, '0000.bin'), Buffer.alloc(bytes.length, 0x78));
  const unavailableDuringUnwind = await captureAfterRestart.receipt(captured.operationId);
  assert.equal(unavailableDuringUnwind.status, 'unavailable', 'A durable receipt still verifies content on each access.');
});

test('reconciliation verifies the whole profile at both operation boundaries without exempting concurrent reads', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Scan boundaries' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Preserved files' }, 'human');
  const content = new ContentStore(store.profile);
  const artifacts: string[] = [];
  const operations: string[] = [];
  for (let index = 0; index < 2; index++) {
    const declared = metadata(project.id, asset.id, { name: `Preserved file ${index}` });
    const stage = await content.prepare(randomUUID(), declared.operationId);
    const member = await content.writeMember(stage, 0, declared.members[0]!, Readable.from([bytes]), new AbortController().signal);
    await content.finish(stage, makeDescriptor(declared, stage.artifactId, [member]));
    await content.publish(stage);
    artifacts.push(stage.artifactId);
    operations.push(stage.operationId);
  }
  const found = await reconcileCapture(store.database.connection, content);
  assert.deepEqual(found.incompleteStaging, []);
  assert.deepEqual(found.unavailableContent, []);
  assert.deepEqual(found.publishedOrphans.map(row => row.operationId).sort(), operations.sort());
  const verify = store.profile.verifyAsync.bind(store.profile);

  const unexpected = join(store.profilePath, 'unexpected-junction');
  symlinkSync(store.root, unexpected, 'junction');
  try {
    await assert.rejects(reconcileCapture(store.database.connection, content), /reparse point inside private profile/);
  } finally {
    rmdirSync(unexpected);
  }

  const artwork = join(store.profilePath, 'artwork');
  let granted = false;
  let checks = 0;
  store.profile.verifyAsync = async () => {
    await verify();
    checks++;
    if (checks === 1) {
      const grant = spawnSync('icacls.exe', [artwork, '/grant', '*S-1-5-32-545:(OI)(CI)M'], { encoding: 'utf8' });
      assert.equal(grant.status, 0, grant.stderr);
      granted = true;
    }
  };
  try {
    await assert.rejects(reconcileCapture(store.database.connection, content), /Private profile grants another principal access/);
  } finally {
    store.profile.verifyAsync = verify;
    if (granted) {
      const remove = spawnSync('icacls.exe', [artwork, '/remove:g', '*S-1-5-32-545'], { encoding: 'utf8' });
      assert.equal(remove.status, 0, remove.stderr);
    }
  }

  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  checks = 0;
  store.profile.verifyAsync = async () => {
    const call = ++checks;
    await verify();
    if (call === 1) {
      entered.resolve();
      await resume.promise;
    }
  };
  const inspection = reconcileCapture(store.database.connection, content);
  try {
    await Promise.race([
      entered.promise,
      inspection.then(() => { throw new Error('Reconciliation finished before its security boundary was entered.'); }),
    ]);
    symlinkSync(store.root, unexpected, 'junction');
    try {
      await assert.rejects(content.readDescriptor(artifacts[0]!), /reparse point inside private profile/,
        'A direct read must verify independently even while a reconciliation is in progress.');
    } finally {
      rmdirSync(unexpected);
    }
    resume.resolve();
    const afterConcurrentRead = await inspection;
    assert.deepEqual(afterConcurrentRead.publishedOrphans.map(row => row.operationId).sort(), operations);
  } finally {
    resume.resolve();
    await inspection.catch(() => {});
    store.profile.verifyAsync = verify;
  }
});

test('replay revalidates references and cycles and leaves no success receipt after a failed final association', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'References' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Sketch' }, 'human');
  const content = new ContentStore(store.profile);
  const initial = metadata(project.id, asset.id);
  const stage = await content.prepare(randomUUID(), initial.operationId);
  const self = { ...initial, inputs: [{ artifactId: stage.artifactId }] };
  const member = await content.writeMember(stage, 0, self.members[0]!, Readable.from([bytes]), new AbortController().signal);
  await content.finish(stage, makeDescriptor(self, stage.artifactId, [member]));
  await content.publish(stage);
  store.database.close();
  store.profile.close();
  const webDist = join(store.root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html>test</html>');
  const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
  try {
    const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
    const headers = { Authorization: `Bearer ${bearer}` };
    const missing = await fetch(`${server.origin}/api/captures`, { method: 'POST', headers,
      body: form({ ...self, inputs: [{ artifactId: randomUUID() }] }) });
    assert.equal(missing.status, 409);
    const cycle = await fetch(`${server.origin}/api/captures`, { method: 'POST', headers, body: form(self) });
    assert.equal(cycle.status, 400);
    const row = await fetch(`${server.origin}/api/captures/operations/${self.operationId}`, { headers });
    assert.equal((await row.json() as CaptureReceipt).status, 'orphan');
  } finally { await server.close(); }
  store.reopen();
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE operation_id = ?')
    .get(self.operationId)!.count, 0);
});

test('disk write errors, truncated streams, declaration limits and publication collision preserve evidence without overwrites', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'File safety' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Drawing' }, 'human');
  const content = new ContentStore(store.profile);
  const declared = metadata(project.id, asset.id);
  const partial = await content.prepare(randomUUID(), declared.operationId);
  const truncated = Readable.from([bytes]) as Readable & { truncated?: boolean };
  truncated.truncated = true;
  await assert.rejects(content.writeMember(partial, 0, declared.members[0]!, truncated, new AbortController().signal), IncompleteContent);
  await content.release(partial);
  const occupied = await content.prepare(randomUUID(), randomUUID());
  writeFileSync(join(occupied.directory, '0000.bin'), 'existing sentinel');
  await assert.rejects(content.writeMember(occupied, 0, declared.members[0]!, Readable.from([bytes]),
    new AbortController().signal), /EEXIST/);
  await content.release(occupied);
  const oversized = await content.prepare(randomUUID(), randomUUID());
  await assert.rejects(content.writeMember(oversized, 0, declared.members[0]!, Readable.from([bytes, bytes]),
    new AbortController().signal), IncompleteContent);
  await content.release(oversized);
  const publish = await content.prepare(randomUUID(), randomUUID());
  const member = await content.writeMember(publish, 0, declared.members[0]!, Readable.from([bytes]), new AbortController().signal);
  const matching = metadata(project.id, asset.id, { operationId: publish.operationId });
  await content.finish(publish, makeDescriptor(matching, publish.artifactId, [member]));
  const destination = join(store.profile.path, 'artwork', publish.artifactId);
  mkdirSync(destination);
  writeFileSync(join(destination, 'sentinel'), 'do not replace');
  await assert.rejects(content.publish(publish), UnavailableContent);
  assert.equal(readFileSync(join(destination, 'sentinel'), 'utf8'), 'do not replace');
  await content.release(publish);
  const linked = await content.prepare(randomUUID(), randomUUID());
  const linkedMember = await content.writeMember(linked, 0, declared.members[0]!, Readable.from([bytes]), new AbortController().signal);
  const linkedMetadata = metadata(project.id, asset.id, { operationId: linked.operationId });
  await content.finish(linked, makeDescriptor(linkedMetadata, linked.artifactId, [linkedMember]));
  linkSync(join(linked.directory, '0000.bin'), join(store.root, 'external-hardlink.bin'));
  await assert.rejects(content.publish(linked), UnavailableContent);
  await content.release(linked);
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM capture_receipts').get()!.count, 0);
});

test('aborted HTTP multipart stream cannot commit or claim complete content', { skip: windowsOnly }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Interrupted' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Sketch' }, 'human');
  store.database.close();
  store.profile.close();
  const webDist = join(store.root, 'web');
  mkdirSync(join(webDist, 'assets'), { recursive: true });
  writeFileSync(join(webDist, 'index.html'), '<html>test</html>');
  const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
  const input = metadata(project.id, asset.id);
  try {
    const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
    const prefix = Buffer.from(`--capture-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(input)}\r\n` +
      '--capture-boundary\r\nContent-Disposition: form-data; name="member0"; filename="sketch.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n');
    const url = new URL(server.origin);
    const raw = httpRequest({ hostname: url.hostname, port: url.port, method: 'POST', path: '/api/captures',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'multipart/form-data; boundary=capture-boundary',
        'Content-Length': prefix.length + bytes.length + 100 } });
    raw.on('error', () => { /* Expected when the sender disconnects. */ });
    raw.write(prefix);
    raw.write(bytes.subarray(0, 4));
    let admitted = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${server.origin}/api/captures/operations/${input.operationId}`,
        { headers: { Authorization: `Bearer ${bearer}` } });
      if ((await response.json() as CaptureReceipt).status === 'in-progress') {
        admitted = true;
        break;
      }
      await delay(10);
    }
    assert.ok(admitted, 'The interrupted transfer must first claim its operation.');
    raw.destroy();
    let terminal: CaptureReceipt | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.origin}/api/captures/operations/${input.operationId}`,
        { headers: { Authorization: `Bearer ${bearer}` } });
      const result = await response.json() as CaptureReceipt;
      if (result.status !== 'in-progress') {
        terminal = result;
        break;
      }
      await delay(25);
    }
    assert.equal(terminal?.status, 'absent', 'The aborted transfer must release its operation claim.');
    const recovery = await fetch(`${server.origin}/api/captures/recovery`,
      { headers: { Authorization: `Bearer ${bearer}` } });
    const incomplete = (await recovery.json() as {
      incompleteStaging: { directory: string; operationId: string | null }[];
    }).incompleteStaging;
    assert.ok(incomplete.some(item => item.operationId === input.operationId));
    assert.ok(!incomplete.some(item => item.directory.startsWith('.reserve-')),
      'An interrupted transfer must release its transient reservation while retaining staging evidence.');
  } finally { await server.close(); }
  store.reopen();
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE operation_id = ?')
    .get(input.operationId)!.count, 0);
  assert.equal(store.database.connection.prepare('SELECT COUNT(*) AS count FROM capture_receipts WHERE operation_id = ?')
    .get(input.operationId)!.count, 0);
});
