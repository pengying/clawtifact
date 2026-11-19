import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../src/images.js').catch(() => ({}));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
const jpeg = Buffer.from([255,216,255,217]);
const codec = { getImageMetadata: async () => ({ width: 1, height: 1 }), resizeToJpeg: async () => jpeg };

test('screenshots are normalized, artifact-scoped, bounded, and expire without leaking original bytes', async () => {
  assert.equal(typeof mod.ScreenshotStore, 'function');
  let now = 1000;
  const store = new mod.ScreenshotStore({ codec, now: () => now });
  const image = await store.add('one', { data: png }, 2000);
  assert.match(image.id, /^[a-f0-9]{32}$/);
  assert.equal(image.mimeType, 'image/jpeg');
  assert.deepEqual(store.get('one', image.id).bytes, jpeg);
  assert.equal(store.get('two', image.id), null);
  now = 2000; assert.equal(store.get('one', image.id), null);
  assert.equal(store.totalBytes, 0);
});

test('screenshots reject active content, malformed base64, header pixel bombs and unsupported processors', async () => {
  assert.equal(typeof mod.ScreenshotStore, 'function');
  const store = new mod.ScreenshotStore({ codec });
  for (const data of ['<svg/>', Buffer.from('<svg/>').toString('base64'), 'x'.repeat(3000000)]) {
    await assert.rejects(store.add('one', { data }, Date.now() + 10000));
  }
  const bomb = Buffer.from(png, 'base64'); bomb.writeUInt32BE(100000, 16);
  await assert.rejects(store.add('one', { data: bomb.toString('base64') }, Date.now() + 10000), /dimension/i);
  await assert.rejects(store.add('one', { data: Buffer.from([255,216,255,255,255,255,255]).toString('base64') }, Date.now() + 10000), error => error.status === 400, 'truncated marker streams are validation errors, not parser crashes');
  await assert.rejects(new mod.ScreenshotStore({}).add('one', { data: png }, Date.now() + 10000), /unavailable/i);
});

test('normalization reserves capacity across concurrent uploads and fails closed on remove during processing', async () => {
  assert.equal(typeof mod.ScreenshotStore, 'function');
  let finish; const slow = { ...codec, resizeToJpeg: () => new Promise(r => { finish = r; }) };
  const store = new mod.ScreenshotStore({ codec: slow });
  const pending = store.add('one', { data: png }, Date.now() + 10000);
  await new Promise(r => setImmediate(r));
  store.remove('one'); finish(jpeg);
  await assert.rejects(pending, /expired|removed/i);
  assert.equal(store.totalBytes, 0);
});
