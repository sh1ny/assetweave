import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import type { MediaDescription, MediaThumbnail } from '@assetweave/contracts/media';
import { gifControls } from '../src/media/gif-controls.js';
import { createStore } from './helpers/store-fixture.js';
import { auth, captureFixtures, fixture, mediaServer } from './helpers/media-fixture.js';

const skip = process.platform !== 'win32';

// A parser alone cannot prove an image decodes: corrupt-later-frame.gif has valid headers and three controls.
test('encoded GIF control blocks distinguish actual delays, zero and absence from decoder defaults', async () => {
  const variable = gifControls(fixture('variable-disposal.gif'));
  assert.deepEqual(variable.frames.map(frame => frame.delayCentiseconds), [5, 12, 7]);
  assert.deepEqual(variable.frames.map(frame => frame.disposal), [1, 2, 3]);
  assert.deepEqual(gifControls(fixture('zero-delay.gif')).frames.map(frame => frame.delayCentiseconds), [5, 0, 7]);
  assert.deepEqual(gifControls(fixture('missing-delay.gif')).frames.map(frame => frame.delayCentiseconds), [5, null, 7]);
  assert.equal((await sharp(fixture('corrupt-later-frame.gif'), { animated: true }).metadata()).pages, 3);
  await assert.rejects(sharp(fixture('corrupt-later-frame.gif'), { animated: true, failOn: 'error' }).raw().toBuffer());
});

test('real Sharp validation controls inline MIME, actual GIF timing, and opaque originals', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Media tests' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Animated knight' }, 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    const pngId = await captureFixtures(server, bearer, project.id, asset.id, ['eight-cell-grid.png']);
    const descResponse = await fetch(`${server.origin}/api/artifacts/${pngId}/media`, { headers: auth(bearer) });
    assert.equal(descResponse.status, 200);
    const png = await descResponse.json() as MediaDescription;
    assert.equal(png.playback, 'unconfigured');
    assert.deepEqual(png.members.map(m => [m.preview, m.width, m.height, m.frameCount]), [['available', 8, 4, 1]]);
    const preview = await fetch(`${server.origin}${png.members[0]!.previewUrl}`, { headers: auth(bearer) });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), fixture('eight-cell-grid.png'));
    const denied = await fetch(`${server.origin}${png.members[0]!.previewUrl}`);
    assert.notEqual(denied.status, 200);

    const gifId = await captureFixtures(server, bearer, project.id, asset.id, ['variable-disposal.gif'], { kind: 'gif' });
    const gif = await (await fetch(`${server.origin}/api/artifacts/${gifId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(gif.playback, 'encoded');
    assert.deepEqual(gif.members[0]!.gifControls?.map(frame => frame.disposal), [1, 2, 3]);
    assert.deepEqual(gif.members[0]!.encodedTiming, { status: 'known', source: 'gif-control-blocks',
      durationsMs: [50, 120, 70], cumulativeMs: [50, 170, 240], cycleMs: 240, framesPerSecond: null });
    const gifBytes = await fetch(`${server.origin}${gif.members[0]!.previewUrl}`, { headers: auth(bearer) });
    assert.equal(gifBytes.headers.get('content-type'), 'image/gif');
    assert.deepEqual(Buffer.from(await gifBytes.arrayBuffer()), fixture('variable-disposal.gif'));

    const opaqueId = await captureFixtures(server, bearer, project.id, asset.id, ['opaque-script.html'],
      { kind: 'opaque', mediaTypes: ['text/html'] });
    const opaque = await (await fetch(`${server.origin}/api/artifacts/${opaqueId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(opaque.members[0]!.preview, 'unavailable');
    assert.equal(opaque.members[0]!.previewUrl, null);
    const attachment = await fetch(`${server.origin}${opaque.members[0]!.originalUrl}`, { headers: auth(bearer) });
    assert.equal(attachment.headers.get('content-type'), 'application/octet-stream');
    assert.match(attachment.headers.get('content-disposition')!, /^attachment;/u);
    assert.equal(attachment.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), fixture('opaque-script.html'));
    const impossiblePreview = await fetch(`${server.origin}/api/artifacts/${opaqueId}/media/members/0`, { headers: auth(bearer) });
    assert.equal(impossiblePreview.status, 503);
  } finally { await server.close(); }
});

test('corrupt pixels and exceeded decode budget never qualify, but exact originals and history remain inspectable', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Media bounds' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Failures' }, 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    for (const name of ['corrupt.png', 'corrupt-later-frame.gif', 'over-pixel-budget.png', 'excess-frames.gif']) {
      const artifactId = await captureFixtures(server, bearer, project.id, asset.id, [name],
        { kind: name.endsWith('.gif') ? 'gif' : 'png' });
      const media = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
      assert.equal(media.members[0]!.preview, 'unavailable', name);
      assert.equal(media.members[0]!.previewUrl, null, name);
      const inline = await fetch(`${server.origin}/api/artifacts/${artifactId}/media/members/0`, { headers: auth(bearer) });
      assert.equal(inline.status, 503, name);
      const original = await fetch(`${server.origin}${media.members[0]!.originalUrl}`, { headers: auth(bearer) });
      assert.equal(original.status, 200, name);
      assert.deepEqual(Buffer.from(await original.arrayBuffer()), fixture(name));
    }
    const goodId = await captureFixtures(server, bearer, project.id, asset.id, ['sequence-0.png']);
    writeFileSync(join(store.profilePath, 'artwork', goodId, '0000.bin'), 'altered after capture');
    const unavailable = await (await fetch(`${server.origin}/api/artifacts/${goodId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(unavailable.content, 'unavailable');
    assert.equal(unavailable.members[0]!.reason, 'missing-or-corrupt');
    assert.equal((await fetch(`${server.origin}/api/artifacts/${goodId}/media/members/0`, { headers: auth(bearer) })).status, 503);
    assert.equal((await fetch(`${server.origin}${unavailable.members[0]!.originalUrl}`, { headers: auth(bearer) })).status, 503);
  } finally { await server.close(); }
});

test('thumbnail finds the first eligible member without certifying unrelated captured bytes', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Thumbnail scope' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Mixed media' }, 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    const artifactId = await captureFixtures(server, bearer, project.id, asset.id,
      ['opaque-script.html', 'sequence-0.png', 'sequence-1.png'],
      { mediaTypes: ['text/html', 'image/png', 'image/png'] });
    writeFileSync(join(store.profilePath, 'artwork', artifactId, '0002.bin'),
      Buffer.alloc(fixture('sequence-1.png').length));
    const thumbnail = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media/thumbnail`,
      { headers: auth(bearer) })).json() as MediaThumbnail;
    assert.equal(thumbnail.previewUrl, `/api/artifacts/${artifactId}/media/members/1`);
    const image = await fetch(`${server.origin}${thumbnail.previewUrl}`, { headers: auth(bearer) });
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), fixture('sequence-0.png'));
    const complete = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`,
      { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(complete.content, 'unavailable');
    assert.ok(complete.members.every(member => member.preview === 'unavailable'));
    writeFileSync(join(store.profilePath, 'artwork', artifactId, '0001.bin'),
      Buffer.alloc(fixture('sequence-0.png').length));
    assert.equal((await fetch(`${server.origin}${thumbnail.previewUrl}`, { headers: auth(bearer) })).status, 503);
    const afterLoss = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media/thumbnail`,
      { headers: auth(bearer) })).json() as MediaThumbnail;
    assert.equal(afterLoss.previewUrl, null);

    const later = await captureFixtures(server, bearer, project.id, asset.id,
      ['opaque-script.html', 'opaque-script.html', 'opaque-script.html', 'opaque-script.html', 'sequence-0.png'],
      { mediaTypes: ['text/html', 'text/html', 'text/html', 'text/html', 'image/png'],
        sourceNames: ['opaque-0.html', 'opaque-1.html', 'opaque-2.html', 'opaque-3.html', 'sequence-0.png'] });
    const laterThumbnail = await (await fetch(`${server.origin}/api/artifacts/${later}/media/thumbnail`,
      { headers: auth(bearer) })).json() as MediaThumbnail;
    assert.equal(laterThumbnail.previewUrl, `/api/artifacts/${later}/media/members/4`);
    const laterImage = await fetch(`${server.origin}${laterThumbnail.previewUrl}`, { headers: auth(bearer) });
    assert.equal(laterImage.status, 200);
    assert.deepEqual(Buffer.from(await laterImage.arrayBuffer()), fixture('sequence-0.png'));
    const full = await (await fetch(`${server.origin}/api/artifacts/${later}/media`,
      { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(full.content, 'available');
    assert.equal(full.members[4]!.preview, 'available');
  } finally { await server.close(); }
});

test('aggregate decoded pixels are bounded across an ordered capture, not only per PNG', { skip }, async t => {
  const store = createStore(t);
  const project = store.catalog.createProject({ name: 'Aggregate cap' }, 'human');
  const asset = store.catalog.createAsset(project.id, { name: 'Large sequence' }, 'human');
  const { server, bearer } = await mediaServer(store);
  try {
    const names = Array.from({ length: 5 }, (_, index) => `bounded-sequence-${index}.png`);
    const artifactId = await captureFixtures(server, bearer, project.id, asset.id, names);
    const media = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`, { headers: auth(bearer) })).json() as MediaDescription;
    assert.deepEqual(media.members.map(member => member.preview), [
      'available', 'available', 'available', 'available', 'unavailable',
    ]);
    assert.equal(media.members[4]!.reason, 'decode-limit');
    const original = await fetch(`${server.origin}${media.members[4]!.originalUrl}`, { headers: auth(bearer) });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), fixture(names[4]!));
    assert.equal((await fetch(`${server.origin}/api/artifacts/${artifactId}/media/members/4`, { headers: auth(bearer) })).status, 503);
    for (let index = 0; index < 4; index++) {
      writeFileSync(join(store.profilePath, 'artwork', artifactId, `${String(index).padStart(4, '0')}.bin`),
        Buffer.alloc(fixture(names[index]!).length));
    }
    const thumbnail = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media/thumbnail`,
      { headers: auth(bearer) })).json() as MediaThumbnail;
    assert.equal(thumbnail.previewUrl, `/api/artifacts/${artifactId}/media/members/4`);
    const qualifying = await fetch(`${server.origin}${thumbnail.previewUrl}`, { headers: auth(bearer) });
    assert.equal(qualifying.status, 200);
    assert.deepEqual(Buffer.from(await qualifying.arrayBuffer()), fixture(names[4]!));
    const afterLoss = await (await fetch(`${server.origin}/api/artifacts/${artifactId}/media`,
      { headers: auth(bearer) })).json() as MediaDescription;
    assert.equal(afterLoss.content, 'unavailable');
  } finally { await server.close(); }
});
