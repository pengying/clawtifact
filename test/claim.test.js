import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../web/claim.js', import.meta.url), 'utf8');
test('only a visible browser claims, once, including after prerender activation', () => {
  let claims = 0;
  const events = {};
  const document = {
    visibilityState: 'hidden', prerendering: true,
    querySelector: () => ({ requestSubmit: () => claims++ }),
    addEventListener: (name, callback) => { events[name] = callback; },
  };
  runInNewContext(source, { document });
  assert.equal(claims, 0);
  document.visibilityState = 'visible';
  events.visibilitychange();
  assert.equal(claims, 0);
  document.prerendering = false;
  events.prerenderingchange();
  assert.equal(claims, 1);
  events.visibilitychange();
  events.prerenderingchange();
  assert.equal(claims, 1);
});
