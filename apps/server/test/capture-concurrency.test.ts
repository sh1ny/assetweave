import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { CaptureReceipt } from '@assetweave/contracts/capture';
import { ContentStore } from '../src/capture/content-store.js';
import { startServer } from '../src/main.js';
import { createStore } from './helpers/store-fixture.js';

const windowsOnly = process.platform !== 'win32';

test('active uploads refuse duplicates and committed receipts remain visible without post-publication cleanup; authorization precedes parsing',
  { skip: windowsOnly }, async t => {
    const store = createStore(t);
    const project = store.catalog.createProject({ name: 'Concurrency' }, 'human');
    const asset = store.catalog.createAsset(project.id, { name: 'Sprite' }, 'human');
    store.database.close();
    store.profile.close();
    const webDist = join(store.root, 'web');
    mkdirSync(join(webDist, 'assets'), { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html>test</html>');
    const server = await startServer({ profilePath: store.profilePath, webDist, port: 0 });
    const originalRelease = ContentStore.prototype.release;
    let releaseStarted!: () => void;
    const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
    let allowRelease!: () => void;
    const released = new Promise<void>(resolve => { allowRelease = resolve; });
    ContentStore.prototype.release = async function (stage) {
      releaseStarted();
      await released;
      return originalRelease.call(this, stage);
    };
    try {
      const { bearer } = JSON.parse(readFileSync(join(store.profilePath, 'bridge.json'), 'utf8')) as { bearer: string };
      const original = Buffer.from('a preserved original');
      const input = { operationId: randomUUID(), projectId: project.id, assetId: asset.id,
        kind: 'opaque', name: 'Concurrent import', members: [
          { sourceName: 'image.bin', byteCount: original.length, sha256: createHash('sha256').update(original).digest('hex') },
        ] };
      const boundary = 'capture-concurrent';
      const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(input)}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="member0"; filename="image.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n';
      const url = new URL(server.origin);
      const unauthorized = await new Promise<number>((resolve, reject) => {
        const attempt = httpRequest({ hostname: url.hostname, port: url.port, method: 'POST', path: '/api/captures',
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': 5000 } },
        response => { response.resume(); resolve(response.statusCode!); attempt.destroy(); });
        attempt.on('error', reject);
        attempt.flushHeaders();
      });
      assert.equal(unauthorized, 401);
      const first = new Promise<CaptureReceipt>((resolve, reject) => {
        const attempt = httpRequest({ hostname: url.hostname, port: url.port, method: 'POST', path: '/api/captures',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` } }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk as Buffer));
          response.on('end', () => {
            if (response.statusCode !== 201) reject(new Error(`First capture returned HTTP ${response.statusCode}`));
            else resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as CaptureReceipt);
          });
        });
        attempt.on('error', reject);
        attempt.write(prefix);
        void (async () => {
          let active = false;
          for (let index = 0; index < 200; index++) {
            const response = await fetch(`${server.origin}/api/captures/operations/${input.operationId}`,
              { headers: { Authorization: `Bearer ${bearer}` } });
            if ((await response.json() as CaptureReceipt).status === 'in-progress') { active = true; break; }
            await delay(25);
          }
          if (!active) throw new Error('The first transfer never claimed its operation.');
          const duplicate = new FormData();
          duplicate.append('metadata', JSON.stringify(input));
          duplicate.append('member0', new Blob([
            new Uint8Array(original.buffer as ArrayBuffer, original.byteOffset, original.byteLength),
          ]), 'image.bin');
          const inFlight = await fetch(`${server.origin}/api/captures`, {
            method: 'POST', headers: { Authorization: `Bearer ${bearer}` }, body: duplicate,
          });
          assert.equal(inFlight.status, 202);
          const state = await inFlight.json() as CaptureReceipt;
          assert.equal(state.status, 'in-progress');
          assert.equal(state.receiptUrl, `/api/captures/operations/${input.operationId}`);
          attempt.end(Buffer.concat([original, Buffer.from(`\r\n--${boundary}--\r\n`)]));
        })().catch(error => { attempt.destroy(); reject(error); });
      });
      // A completed receipt must be visible without waiting for a redundant post-publication
      // reservation cleanup (which may be stalled by Windows profile verification).
      const firstResult = first.then(receipt => ({ receipt }));
      const winner = await Promise.race([firstResult, releasing.then(() => ({ releaseStarted: true }))]);
      if ('releaseStarted' in winner) {
        const whileUnwinding = await fetch(`${server.origin}/api/captures/operations/${input.operationId}`,
          { headers: { Authorization: `Bearer ${bearer}` } });
        assert.equal((await whileUnwinding.json() as CaptureReceipt).status, 'committed');
      }
      allowRelease();
      const committed = await first;
      assert.equal(committed.status, 'committed');
      const response = await fetch(`${server.origin}${committed.receiptUrl}`,
        { headers: { Authorization: `Bearer ${bearer}` } });
      assert.equal((await response.json() as CaptureReceipt).status, 'committed');
    } finally {
      allowRelease();
      ContentStore.prototype.release = originalRelease;
      await server.close();
    }
  });
