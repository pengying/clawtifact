import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactStore } from '../src/store.js';
import { createHandler } from '../src/http.js';
import { reader } from '../src/render.js';
import plugin from '../index.js';
const html = '<!doctype html><html><head><style>body{background:#112}</style></head><body><button onclick="this.textContent=\'Clicked\'">Try me</button><script>window.ready=true</script></body></html>';

test('HTML persists across reopening; reject mixed, absent and oversized input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'art-format-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'db');
  let store = new ArtifactStore({ file });
  const item = store.create({ title: 'Mini page', html, owner: 'a' });
  const session = store.claim(item.token);
  store.close();
  store = new ArtifactStore({ file });
  t.after(() => store.close());
  assert.equal(store.get(item.token, session).html, html);
  assert.equal(store.get(item.token, session).format, 'html');
  assert.throws(() => store.create({ title: 'x', html, markdown: 'mixed', owner: 'a' }), /exactly one/i);
  assert.throws(() => store.create({ title: 'x', html: '💡'.repeat(65537), owner: 'a' }), /large/i);
  assert.throws(() => store.create({ title: 'x', html: '', owner: 'a' }), /required/i);
});

test('existing Markdown database is migrated without changing claims', t => {
  const dir = mkdtempSync(join(tmpdir(), 'art-migration-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE artifacts (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL, session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0)');
  db.close();
  const store = new ArtifactStore({ file });
  t.after(() => store.close());
  const item = store.create({ title: 'Old', markdown: '# Existing', owner: 'a' });
  assert.equal(store.get(item.token, store.claim(item.token)).format, 'markdown');
});

test('Markdown reader contains only authored content, not injected branding or metadata', () => {
  const output = reader({ title: 'GENERATED TITLE', markdown: '# Actual heading\n\nBody', readUntil: Date.now() });
  const body = output.split('<body>')[1];
  assert.match(body, /Actual heading/);
  assert.doesNotMatch(body, /GENERATED TITLE|OPENCLAW|SHARED DOCUMENT|Available in|<header|<footer|document-heading/);
});

test('HTML creation tool supports task-driven format selection', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'art-api-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const reg = {};
  plugin.register({ pluginConfig: { publicBaseUrl: 'https://example.com' }, runtime: { state: { resolveStateDir: () => dir } }, logger: { error() {} }, registerTool: f => reg.factory = f, registerHttpRoute() {}, registerService: s => reg.service = s });
  t.after(() => reg.service.stop());
  const create = reg.factory({ sessionKey: 'a' })[0];
  assert.ok(create.parameters.properties.html);
  assert.match(create.description, /choose/i);
  const created = await create.execute('a', { title: 'Interactive', html });
  assert.match(created.details.url, /\/artifacts\//);
});

test('HTML private lifecycle and restrictive opaque-origin sandbox', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'art-html-http-'));
  const store = new ArtifactStore({ file: join(dir, 'db') });
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  handler = createHandler({ store, origin, secure: false });
  t.after(async () => { await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true }); });
  const item = store.create({ title: 'Private', html, owner: 'a' });
  const path = `/artifacts/${item.token}`;
  const preview = await fetch(origin + path);
  assert.doesNotMatch(await preview.text(), /Try me|window.ready/);
  const session = store.claim(item.token);
  const headers = { cookie: `oc_art_session=${session}` };
  for (let n = 0; n < 2; n++) {
    const view = await fetch(origin + path + "/content", { headers });
    assert.equal(view.status, 200);
    assert.match(await view.text(), /window.ready=true/);
    const csp = view.headers.get('content-security-policy');
    assert.match(csp, /sandbox allow-scripts;/);
    assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-top-navigation|unsafe-eval/);
    for (const directive of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "script-src 'unsafe-inline'"]) assert.ok(csp.includes(directive));
    assert.equal(view.headers.get('referrer-policy'), 'no-referrer');
  }
  assert.equal((await fetch(origin + path)).status, 404);
  assert.equal((await fetch(origin + path, { headers: { cookie: 'oc_art_session=' + 'x'.repeat(43) } })).status, 404);
  store.revoke(item.id, 'a');
  assert.equal((await fetch(origin + path, { headers })).status, 404);
});
