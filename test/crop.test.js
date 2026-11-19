import test from 'node:test';
import assert from 'node:assert/strict';
const mod = await import('../web/images.js').catch(() => ({}));
test('crop bounds identify only the explicitly selected image area and cap the rendered preview size', () => {
  assert.equal(typeof mod.cropPixels, 'function');
  assert.deepEqual(mod.cropPixels({ x: .25, y: .25, width: .5, height: .5 }, 4000, 2000), { sx: 1000, sy: 500, sw: 2000, sh: 1000, width: 1600, height: 800 });
  for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: .9, y: 0, width: .2, height: 1 }, { x: 0, y: 0, width: NaN, height: 1 }]) assert.throws(() => mod.cropPixels(region, 100, 100));
  assert.throws(() => mod.cropPixels({ x: 0, y: 0, width: 1, height: 1 }, 100000, 100000));
});
test('automatic capture accepts only a browser tab with this page’s unguessable capture handle', () => {
  assert.equal(typeof mod.isOwnTab, 'function');
  const track = (surface, handle) => ({ getSettings: () => ({ displaySurface: surface }), getCaptureHandle: () => ({ handle }) });
  assert.equal(mod.isOwnTab(track('browser', 'this-page'), 'this-page'), true);
  assert.equal(mod.isOwnTab(track('monitor', 'this-page'), 'this-page'), false);
  assert.equal(mod.isOwnTab(track('browser', 'another-page'), 'this-page'), false);
  assert.equal(mod.isOwnTab({ getSettings: () => ({ displaySurface: 'browser' }) }, 'this-page'), false);
});
