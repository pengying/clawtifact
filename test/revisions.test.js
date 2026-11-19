import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ArtifactStore, validateArtifact, hash, secret } from '../src/store.js';

function fixture(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-revisions-'));
  const file = join(dir, 'db.sqlite');
  let now = 1000;
  const store = new ArtifactStore({ file, now: () => now, ...opts });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file, dir, advance: value => { now = value; } };
}
const publish = (store, item, source, options = {}) => store.publish({ id: item.id, owner: 'owner', expectedRevision: item.revisionId, requestId: randomUUID(), markdown: source, ...options });
const status = expected => error => error.status === expected;

test('new documents expose immutable initial revisions and exact typed-source validation', t => {
  const { store } = fixture(t);
  for (const format of ['markdown', 'html', 'code', 'svg', 'mermaid', 'react']) {
    const source = { [format]: 'source', ...(format === 'code' ? { language: 'js' } : {}) };
    assert.deepEqual(validateArtifact({ title: 'Title', owner: 'owner', ...source }), { format, content: 'source', ...(format === 'code' ? { language: 'js' } : {}) });
    const item = store.create({ title: 'Title', owner: 'owner', ...source });
    assert.match(item.revisionId, /^[a-f0-9]{32}$/);
    assert.equal(item.sequence, 1);
    assert.deepEqual(store.get(item.token), { kind: 'unclaimed' });
    const session = store.claim(item.token);
    const doc = store.get(item.token, session);
    assert.equal(doc.documentId, item.id);
    assert.equal(doc.revisionId, item.revisionId);
    assert.equal(doc.headRevision, item.revisionId);
    assert.equal(doc.live, true);
    assert.equal(doc[format], 'source');
  }
  for (const source of [{ markdown: 'a', svg: 'b' }, { code: 3 }, { svg: 'x', language: 'js' }, { code: 'x', language: 'x'.repeat(81) }]) {
    assert.throws(() => store.create({ title: 'T', owner: 'owner', ...source }), status(400));
  }
});

test('publish CAS retains old source, stable claims and deadlines, bounded receipts before CAS', t => {
  const { store, advance } = fixture(t, { readMs: 1000 });
  const item = store.create({ title: 'First', owner: 'owner', markdown: 'v1', expiresAt: 2000 });
  const session = store.claim(item.token);
  const requestId = randomUUID();
  const input = { id: item.id, owner: 'owner', expectedRevision: item.revisionId, requestId, code: 'v2', language: 'js', title: 'Second', summary: 'Changed source' };
  const receipt = store.publish(input);
  assert.equal(receipt.sequence, 2);
  assert.equal(receipt.documentId, item.id);
  assert.notEqual(receipt.revisionId, item.revisionId);
  const third = publish(store, { ...item, revisionId: receipt.revisionId }, 'v3');
  assert.deepEqual(store.publish(input), receipt, 'exact retries return original receipt after head advances');
  assert.throws(() => store.publish({ ...input, code: 'different' }), status(409));
  assert.throws(() => publish(store, item, 'stale'), status(409));
  assert.throws(() => publish(store, item, 'x', { owner: 'stranger' }), status(404));
  assert.throws(() => publish(store, item, 'x', { requestId: 'bad' }), status(400));
  const old = store.get(item.token, session, item.revisionId);
  assert.equal(old.markdown, 'v1');
  assert.equal(old.title, 'First');
  assert.equal(old.headRevision, third.revisionId);
  const head = store.get(item.token, session);
  assert.equal(head.markdown, 'v3');
  assert.equal(head.readUntil, 2000);
  assert.equal(store.get(item.token, session, 'f'.repeat(32)), null);
  assert.equal(store.get(item.token, secret(), item.revisionId), null);
  const metadata = store.inspect(item.id, 'owner');
  assert.equal(metadata.history.length, 3);
  assert.equal(metadata.headRevision, third.revisionId);
  assert.equal('markdown' in metadata, false);
  assert.equal('token' in metadata, false);
  assert.equal('cookie' in metadata, false);
  assert.deepEqual(store.inspect(item.id, 'owner', { requestId }).receipt, receipt);
  assert.equal(store.inspect(item.id, 'owner', { revisionId: receipt.revisionId }).code, 'v2');
  assert.throws(() => store.inspect(item.id, 'stranger'), status(404));
  assert.equal(store.markApplied(item.token, session, receipt.revisionId), true);
  assert.equal(store.markApplied(item.token, session, item.revisionId), true);
  assert.equal(store.inspect(item.id, 'owner').appliedRevision, receipt.revisionId);
  assert.equal(store.markApplied(item.token, secret(), third.revisionId), false);
  advance(2000);
  assert.throws(() => publish(store, { ...item, revisionId: third.revisionId }, 'late'), status(404));
  assert.throws(() => store.inspect(item.id, 'owner'), status(404));
  assert.equal(store.get(item.token, session), null);
  assert.equal(store.cleanup(), 1);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_revisions').get().n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_publish_receipts').get().n, 0);
});

test('revision count and accumulated bytes are bounded; revoke erases revisions and receipts', t => {
  const { store } = fixture(t);
  const small = store.create({ title: 'Count', owner: 'owner', markdown: 'v1' });
  let current = small;
  for (let i = 2; i <= 50; i++) current = { ...small, ...publish(store, current, `v${i}`) };
  assert.throws(() => publish(store, current, 'v51'), status(429));
  const large = store.create({ title: 'Bytes', owner: 'owner', markdown: 'x'.repeat(262144) });
  let largeCurrent = large;
  for (let i = 2; i <= 32; i++) largeCurrent = { ...large, ...publish(store, largeCurrent, 'x'.repeat(262144)) };
  assert.throws(() => publish(store, largeCurrent, 'x'), status(429));
  assert.equal(store.inspect(large.id, 'owner').history.length, 32);
  assert.equal(store.revoke(small.id, 'stranger'), false);
  assert.equal(store.revoke(small.id, 'owner'), true);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_revisions WHERE document_id=?').get(small.id).n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_publish_receipts WHERE document_id=?').get(small.id).n, 0);
});

test('legacy migrations preserve claims, tokens and source, stay frozen, reopen and snapshot-restore', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'old.sqlite');
  const token = secret(), session = secret(), id = 'a'.repeat(32);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE artifacts(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL, session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`);
  old.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)').run(id, hash(token), 'owner', 'Legacy', '# preserved', 2000, hash(session), 3000, 0);
  old.close();
  let store = new ArtifactStore({ file, now: () => 1000 });
  const legacy = store.get(token, session);
  assert.equal(legacy.markdown, '# preserved');
  assert.equal(legacy.live, false);
  assert.equal(legacy.sequence, 1);
  assert.throws(() => publish(store, legacy, 'no'), status(409));
  const history = store.db.prepare('SELECT version FROM artifact_schema_migrations ORDER BY version').all();
  assert.ok(history.length >= 2);
  assert.deepEqual(history.map(row => row.version), [1, 2]);
  const item = store.create({ title: 'Snapshot', owner: 'owner', html: '<b>first</b>' });
  const browser = store.claim(item.token);
  const receipt = publish(store, item, 'second');
  store.markApplied(item.token, browser, receipt.revisionId);
  const snapshot = join(dir, 'backup.sqlite');
  store.db.prepare('VACUUM INTO ?').run(snapshot);
  store.close();
  store = new ArtifactStore({ file, now: () => 1000 });
  assert.equal(store.get(token, session).revisionId, legacy.revisionId);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_schema_migrations').get().n, 2);
  store.revoke(item.id, 'owner');
  store.close();
  const restored = new ArtifactStore({ file: snapshot, now: () => 1000 });
  t.after(() => restored.close());
  assert.equal(restored.get(token, session).markdown, '# preserved');
  assert.equal(restored.get(item.token, browser).markdown, 'second');
  assert.deepEqual(restored.inspect(item.id, 'owner', { requestId: restored.db.prepare('SELECT request_id FROM artifact_publish_receipts WHERE document_id=?').get(item.id).request_id }).receipt, receipt);
  assert.equal(restored.inspect(item.id, 'owner').appliedRevision, receipt.revisionId);
});

test('independent writers racing one head have one CAS winner and no partial revisions', async t => {
  const { store, file } = fixture(t);
  const item = store.create({ title: 'Race', owner: 'owner', markdown: 'initial' });
  const gate = new SharedArrayBuffer(4);
  const source = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{ const {ArtifactStore}=await import(workerData.module); const s=new ArtifactStore({file:workerData.file,now:()=>1000});
    parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.gate),0,0);
    try { parentPort.postMessage({receipt:s.publish(workerData.input)}); } catch(e){parentPort.postMessage({status:e.status});} s.close(); })();`;
  const workers = [0, 1].map(i => new Worker(source, { eval: true, workerData: { file, gate, module: new URL('../src/store.js', import.meta.url).href, input: { id: item.id, owner: 'owner', expectedRevision: item.revisionId, requestId: randomUUID(), markdown: `writer${i}` } } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
  const results = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, 2);
  const outcomes = await Promise.all(results);
  assert.equal(outcomes.filter(outcome => outcome.receipt).length, 1);
  assert.deepEqual(outcomes.filter(outcome => outcome.status).map(outcome => outcome.status), [409]);
  assert.equal(store.inspect(item.id, 'owner').history.length, 2);
});

test('viewer status is cookie-authenticated metadata only, including bounded history', t => {
  const { store } = fixture(t);
  const item = store.create({ title: 'Viewer', owner: 'owner', markdown: 'private initial' });
  assert.equal(store.viewerStatus(item.token), null);
  const session = store.claim(item.token);
  const next = publish(store, item, 'private update', { summary: 'Update summary' });
  assert.equal(store.viewerStatus(item.token, secret()), null);
  const snapshot = store.viewerStatus(item.token, session);
  assert.equal(snapshot.head.revisionId, next.revisionId);
  assert.equal(snapshot.head.live, true);
  assert.equal(snapshot.revisions.length, 2);
  assert.equal(snapshot.revisions[1].summary, 'Update summary');
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  assert.equal(JSON.stringify(snapshot).includes('owner'), false);
});

test('failed schema upgrades roll back completely and retry; future schemas fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-migrate-rollback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'rollback.sqlite');
  let db = new DatabaseSync(file);
  db.exec(`CREATE TABLE artifacts(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL, session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT 'markdown', expires_at INTEGER);
    CREATE TABLE artifact_revisions(id TEXT, content TEXT)`);
  const token = secret(), id = 'b'.repeat(32);
  db.prepare('INSERT INTO artifacts(id,token_hash,owner,title,markdown,claim_until,format,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(id, hash(token), 'owner', 'HTML legacy', '<b>preserved</b>', 2000, 'html', 2500);
  db.close();
  assert.throws(() => new ArtifactStore({ file, now: () => 1000 }), /already exists/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='artifact_schema_migrations'").get().n, 0);
  assert.equal(db.prepare('PRAGMA table_info(artifacts)').all().some(column => column.name === 'live'), false);
  assert.equal(db.prepare('SELECT markdown FROM artifacts').get().markdown, '<b>preserved</b>');
  db.exec('DROP TABLE artifact_revisions');
  db.close();
  const store = new ArtifactStore({ file, now: () => 1000 });
  const browser = store.claim(token);
  assert.equal(store.get(token, browser).html, '<b>preserved</b>');
  assert.equal(store.get(token, browser).readUntil, 2500);
  assert.equal(store.get(token, browser).live, false);
  store.db.prepare('INSERT INTO artifact_schema_migrations VALUES(3,1000)').run();
  store.close();
  assert.throws(() => new ArtifactStore({ file, now: () => 1000 }), /Unsupported artifact schema/);
  db = new DatabaseSync(file);
  assert.equal(db.prepare('SELECT count(*) n FROM artifact_schema_migrations').get().n, 3);
  db.close();
});

test('concurrent identical publications create one revision and one durable receipt', async t => {
  const { store, file } = fixture(t);
  const item = store.create({ title: 'Retry race', owner: 'owner', markdown: 'initial' });
  const gate = new SharedArrayBuffer(4);
  const input = { id: item.id, owner: 'owner', expectedRevision: item.revisionId, requestId: randomUUID(), markdown: 'published once' };
  const source = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{ const {ArtifactStore}=await import(workerData.module); const s=new ArtifactStore({file:workerData.file,now:()=>1000});
    parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.gate),0,0);
    parentPort.postMessage(s.publish(workerData.input)); s.close(); })();`;
  const workers = [0, 1].map(() => new Worker(source, { eval: true, workerData: { file, gate, module: new URL('../src/store.js', import.meta.url).href, input } }));
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  await Promise.all(workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); })));
  const results = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, 2);
  const outcomes = await Promise.all(results);
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(store.inspect(item.id, 'owner').history.length, 2);
  assert.equal(store.db.prepare('SELECT count(*) n FROM artifact_publish_receipts WHERE document_id=?').get(item.id).n, 1);
});


test('legacy upgrade first creates a private verified old-schema checkpoint; new/current stores skip it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-auto-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const freshFile = join(dir, 'fresh.sqlite');
  const fresh = new ArtifactStore({ file: freshFile });
  assert.equal(fresh.migrationBackupPath, undefined);
  fresh.close();
  const current = new ArtifactStore({ file: freshFile });
  assert.equal(current.migrationBackupPath, undefined);
  current.close();
  const file = join(dir, 'old.sqlite');
  const token = secret(), session = secret();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE artifacts(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL, session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`);
  old.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)').run('a'.repeat(32), hash(token), 'owner', 'Saved', 'source preserved α', 2000, hash(session), 3000, 0);
  old.close();
  const store = new ArtifactStore({ file, now: () => 1000 });
  t.after(() => store.close());
  assert.equal(typeof store.migrationBackupPath, 'string');
  assert.equal(store.migrationBackupPath.startsWith(file + '.pre-migration-v0-'), true);
  assert.equal(statSync(store.migrationBackupPath).mode & 0o777, 0o600);
  const checkpoint = new DatabaseSync(store.migrationBackupPath, { readOnly: true });
  t.after(() => checkpoint.close());
  assert.deepEqual(checkpoint.prepare('PRAGMA integrity_check').get(), Object.assign(Object.create(null), { integrity_check: 'ok' }));
  assert.equal(checkpoint.prepare('PRAGMA table_info(artifacts)').all().some(column => column.name === 'live'), false);
  assert.equal(checkpoint.prepare("SELECT count(*) n FROM sqlite_master WHERE name='artifact_schema_migrations'").get().n, 0);
  const saved = checkpoint.prepare('SELECT * FROM artifacts').get();
  assert.equal(saved.token_hash, hash(token));
  assert.equal(saved.session_hash, hash(session));
  assert.equal(saved.markdown, 'source preserved α');
  assert.equal(saved.read_until, 3000);
  assert.equal(store.get(token, session).markdown, saved.markdown);
  assert.equal(store.get(token, session).live, false);
  assert.throws(() => checkpoint.exec('DELETE FROM artifacts'), /readonly/);
});

test('checkpoint failure aborts opening before any live schema or database changes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-checkpoint-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A legal existing filename near NAME_MAX leaves no room for the unique snapshot suffix.
  const file = join(dir, 'x'.repeat(240));
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE artifacts(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL, session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0)`);
  old.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)').run('a'.repeat(32), hash(secret()), 'owner', 'Old', 'unchanged', 2000, null, null, 0);
  old.close();
  const original = readFileSync(file);
  assert.throws(() => new ArtifactStore({ file, now: () => 1000 }), /checkpoint|ENAMETOOLONG/i);
  assert.deepEqual(readFileSync(file), original, 'failed checkpoint leaves original DB bytes unchanged');
  const unchanged = new DatabaseSync(file, { readOnly: true });
  t.after(() => unchanged.close());
  assert.equal(unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE name='artifact_schema_migrations'").get().n, 0);
  assert.equal(unchanged.prepare('PRAGMA table_info(artifacts)').all().some(column => column.name === 'live'), false);
  assert.equal(unchanged.prepare('SELECT markdown FROM artifacts').get().markdown, 'unchanged');
  assert.deepEqual(readdirSync(dir), ['x'.repeat(240)]);
});

test('trusted owner feedback mode defaults to discuss, is validated and persists across publish/reopen', t => {
  const { store, file } = fixture(t);
  const discussion = store.create({ title: 'Default', owner: 'owner', markdown: 'source' });
  assert.equal(store.inspect(discussion.id, 'owner').feedbackMode, 'discuss');
  assert.throws(() => store.create({ title: 'Invalid', owner: 'owner', markdown: 'source', feedbackMode: 'arbitrary' }), status(400));
  const item = store.create({ title: 'Revise', owner: 'owner', markdown: 'source', feedbackMode: 'revise' });
  const session = store.claim(item.token);
  const next = publish(store, item, 'new source', { feedbackMode: 'discuss' });
  assert.equal(store.inspect(item.id, 'owner').feedbackMode, 'revise', 'publish cannot alter owner opt-in');
  assert.equal(store.get(item.token, session, next.revisionId).feedbackMode, 'revise');
  const reopened = new ArtifactStore({ file, now: () => 1000 });
  t.after(() => reopened.close());
  assert.equal(reopened.inspect(item.id, 'owner').feedbackMode, 'revise');
  assert.equal(reopened.get(item.token, session).feedbackMode, 'revise');
});
