import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('sandbox bridge sends selection metadata only to the trusted host origin', () => {
  const sent = [];
  const win = { parent: { postMessage: (...args) => sent.push(args) }, scrollX: 0, scrollY: 20, innerWidth: 1200, innerHeight: 800, addEventListener() {} };
  const document = { currentScript: { src: 'https://review.example.com/artifacts/assets/bridge.js' }, addEventListener() {} };
  vm.runInNewContext(readFileSync(new URL('../web/bridge.js', import.meta.url), 'utf8'), { window: win, document, URL, setTimeout, clearTimeout, requestAnimationFrame() {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], 'https://review.example.com');
  assert.equal(sent[0][0].type, 'clawtifact:viewport');
  assert.ok(!JSON.stringify(sent).includes('csrf'));
});
