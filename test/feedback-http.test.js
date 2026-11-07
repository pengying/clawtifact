import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ArtifactStore } from '../src/store.js';
import { FeedbackBroker } from '../src/feedback.js';
import { createHandler } from '../src/http.js';
const id = '12345678-1234-4234-8234-123456789abc';
async function fixture(t, format, { target = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'feedback-http-'));
  let now = 1000; const calls = [];
  const store = new ArtifactStore({ file: join(dir, 'db'), now: () => now });
  const broker = new FeedbackBroker({ now: () => now, system: { captureSessionEventTarget: async () => target, enqueueSessionEvent(text, opts) { calls.push({ text, opts }); return { accepted: Promise.resolve({ ok: true }), settled: Promise.resolve({ status: 'completed', delivered: true }) }; } } });
  const item = store.create({ title: 'Private title', [format]: format === 'html' ? '<!doctype html><html><body>SECRET-CONTENT<script>window.authored=true</script></body></html>' : '# SECRET-CONTENT', owner: 'source', expiresAt: 2000 });
  broker.bind(item.id, await broker.capture({ agentId: 'main', sessionKey: 'source', deliveryContext: { channel: 'telegram', to: 'source', threadId: 'original-thread' } }), 2000);
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createHandler({ store, origin, secure: false, feedback: broker });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(dir, { recursive: true }); });
  const path = '/artifacts/' + item.token;
  const session = store.claim(item.token);
  const request = (suffix = '', options = {}) => fetch(origin + path + suffix, { redirect: 'manual', ...options });
  const host = await request('', { headers: { cookie: 'oc_art_session=' + session } });
  assert.match(host.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await host.text();
  const csrf = /data-csrf="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  const csrfCookie = host.headers.getSetCookie().find(x => x.startsWith('oc_art_feedback='))?.split(';')[0];
  const cookie = `oc_art_session=${session}; ${csrfCookie || ''}`;
  const payload = { id, csrf, comments: [{ text: 'Explain this section', anchor: { type: 'text', quote: 'SECRET-CONTENT', prefix: '', suffix: '' } }] };
  const post = (data = payload, overrides = {}) => request('/feedback', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', ...overrides }, body: JSON.stringify(data) });
  return { store, broker, item, calls, request, post, html, csrf, cookie, payload, expire: () => { now = 2000; } };
}
for (const format of ['markdown', 'html']) test(`${format}: authored content is isolated from the credentialed overlay`, async t => {
  const f = await fixture(t, format);
  assert.match(f.html, /id="artifact-content"/);
  assert.match(f.html, /sandbox="allow-scripts"/);
  assert.match(f.html, /id="artifact-feedback"/);
  assert.equal(typeof f.csrf, 'string');
  assert.doesNotMatch(f.html, /SECRET-CONTENT|window.authored/);
  const child = await f.request('/content', { headers: { cookie: f.cookie } });
  assert.equal(child.status, 200);
  const inner = await child.text();
  assert.match(inner, /SECRET-CONTENT/); assert.match(inner, /bridge.js/);
  assert.doesNotMatch(inner, /data-csrf|oc_art_feedback/);
  assert.match(child.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.match(child.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.doesNotMatch(child.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal((await f.request('/content')).status, 404);
});
test('feedback rejects outsiders, cross-origin, missing csrf, oversized or retargeted payloads; deduplicates valid batches', async t => {
  const f = await fixture(t, 'markdown');
  assert.equal((await f.post()).status, 202, 'a claimed browser can submit feedback');
  assert.equal((await f.post()).status, 202);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.deliveryContext.threadId, 'original-thread');
  assert.equal((await f.post(f.payload, { cookie: '' })).status, 404);
  assert.equal((await f.post(f.payload, { origin: 'https://evil.invalid' })).status, 404);
  assert.equal((await f.post({ ...f.payload, csrf: 'z'.repeat(43) })).status, 404);
  assert.equal((await f.post({ ...f.payload, destination: 'attacker' })).status, 400);
  assert.equal((await f.post({ ...f.payload, comments: [{ text: 'x'.repeat(40000), anchor: { type: 'general' } }] })).status, 400);
  const status = await f.request('/feedback', { headers: { cookie: f.cookie } });
  assert.equal((await status.json()).batches[0].status, 'delivered');
  f.expire(); assert.equal((await f.post()).status, 404); assert.equal((await f.request('/feedback', { headers: { cookie: f.cookie } })).status, 404);
});
test('revoked and lost-target artifacts cannot send feedback', async t => {
  const f = await fixture(t, 'html');
  f.broker.clear(); assert.equal((await f.post()).status, 503); assert.equal(f.calls.length, 0);
  f.store.revoke(f.item.id, 'source'); assert.equal((await f.post()).status, 404);
});


test('missing opaque capture authority disables the browser feedback boundary', async t => {
  const f = await fixture(t, 'markdown', { target: null });
  assert.match(f.html, /data-enabled="false"/);
  assert.equal((await f.post()).status, 503);
  assert.equal(f.calls.length, 0);
  const status = await f.request('/feedback', { headers: { cookie: f.cookie } });
  assert.deepEqual(await status.json(), { enabled: false, batches: [] });
});
