import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export const DAY = 86_400_000;
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const revisionId = () => randomBytes(16).toString('hex');
const validRevision = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const validRequest = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const formats = ['markdown', 'html', 'code', 'svg', 'mermaid', 'react'];
export class ArtifactError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function validateArtifact(input, now = Date.now()) {
  const { title, owner, expiresAt = null, language } = input;
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new ArtifactError('Title must be 1–200 characters');
  const supplied = formats.filter(format => input[format] !== undefined);
  if (supplied.length > 1) throw new ArtifactError('Supply exactly one of markdown, html, code, svg, mermaid or react');
  const format = supplied[0] ?? 'markdown';
  const content = input[format];
  if (typeof content !== 'string' || !content.trim()) throw new ArtifactError(`${format === 'html' ? 'HTML' : format === 'markdown' ? 'Markdown' : format} is required`);
  if (Buffer.byteLength(content) > 262144) throw new ArtifactError('Artifact is too large (256 KiB maximum)');
  if (language !== undefined && (format !== 'code' || typeof language !== 'string' || !language.trim() || language.length > 80)) throw new ArtifactError('Language is only supported for code (1–80 characters)');
  if (typeof owner !== 'string' || !owner) throw new ArtifactError('A session owner is required');
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) throw new ArtifactError('Artifact deadline must be in the future');
  return { format, content, ...(language === undefined ? {} : { language }) };
}
const metadata = revision => ({ revisionId: revision.id, sequence: revision.sequence, title: revision.title, format: revision.format, summary: revision.summary, createdAt: revision.created_at });
const source = revision => ({ ...metadata(revision), [revision.format]: revision.content, ...(revision.language === null ? {} : { language: revision.language }) });

const schemaHistory = db => {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_schema_migrations'").get();
  const history = exists ? db.prepare('SELECT version FROM artifact_schema_migrations ORDER BY version').all().map(row => row.version) : [];
  if (history.some((version, index) => version !== index + 1) || history.at(-1) > 2) throw new Error('Unsupported artifact schema migration history');
  return history;
};
const quoteIdentifier = name => '"' + name.replaceAll('"', '""') + '"';
const checkpointFacts = db => {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(entry => entry.type === 'table').map(entry => entry.name);
  const counts = tables.map(name => ({ name, rows: db.prepare(`SELECT count(*) n FROM ${quoteIdentifier(name)}`).get().n }));
  const sourceBytes = [];
  const digest = createHash('sha256');
  for (const [table, order, column] of [['artifacts', 'id', 'markdown'], ['artifact_revisions', 'id', 'content'], ['artifact_publish_receipts', 'document_id,request_id'], ['artifact_schema_migrations', 'version']]) {
    if (!tables.includes(table)) continue;
    if (column) sourceBytes.push({ table, bytes: db.prepare(`SELECT coalesce(sum(length(cast(${column} AS BLOB))),0) n FROM ${table}`).get().n });
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) digest.update(JSON.stringify(row) + '\n');
  }
  return JSON.stringify({ schema, counts, sourceBytes, digest: digest.digest('hex') });
};

export class ArtifactStore {
  constructor({ file, now = Date.now, claimMs = DAY, readMs = DAY, capacity = 1000 }) {
    this.now = now;
    this.claimMs = claimMs;
    this.readMs = readMs;
    this.capacity = capacity;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const history = schemaHistory(this.db);
      const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
      // Serial plugin startup provides stopped-writer custody. This is a verified
      // old-state checkpoint, not automatic rollback to an old runtime.
      if (existing && history.length < 2) this.checkpointBeforeMigration(file, history.length);
      this.db.exec('PRAGMA journal_mode=DELETE');
      this.migrate();
    } catch (error) { this.db.close(); throw error; }
  }
  checkpointBeforeMigration(file, oldVersion) {
    const path = `${file}.pre-migration-v${oldVersion}-${Date.now()}-${revisionId()}.sqlite`;
    let reserved = false;
    try {
      const expected = checkpointFacts(this.db);
      // SQLite accepts an empty destination. Exclusive reservation guarantees
      // permissions from the first byte and cannot silently overwrite a file.
      const fd = openSync(path, 'wx', 0o600);
      reserved = true;
      closeSync(fd);
      this.db.prepare('VACUUM INTO ?').run(path);
      const saved = new DatabaseSync(path, { readOnly: true });
      try {
        const integrity = saved.prepare('PRAGMA integrity_check').all();
        if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || checkpointFacts(saved) !== expected) throw new Error('Checkpoint verification mismatch');
      } finally { saved.close(); }
      this.migrationBackupPath = path;
    } catch (error) {
      if (reserved) { try { unlinkSync(path); } catch {} }
      throw new Error('Artifact pre-migration checkpoint failed; live schema unchanged', { cause: error });
    }
  }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrate() {
    // Plugin-owned, ordered schema history; schema and history commit atomically.
    // A consistent SQLite snapshot includes this table, revisions and receipts.
    this.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS artifact_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
      const history = schemaHistory(this.db);
      if (history.length < 1) {
        this.db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
          title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL,
          session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0
        )`);
        const columns = this.db.prepare('PRAGMA table_info(artifacts)').all().map(column => column.name);
        if (!columns.includes('format')) this.db.exec("ALTER TABLE artifacts ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'");
        if (!columns.includes('expires_at')) this.db.exec('ALTER TABLE artifacts ADD COLUMN expires_at INTEGER');
        this.db.prepare('INSERT INTO artifact_schema_migrations VALUES(1,?)').run(this.now());
      }
      if (history.length < 2) {
        this.db.exec(`ALTER TABLE artifacts ADD COLUMN live INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE artifacts ADD COLUMN feedback_mode TEXT NOT NULL DEFAULT 'discuss';
          ALTER TABLE artifacts ADD COLUMN head_revision TEXT;
          ALTER TABLE artifacts ADD COLUMN applied_revision TEXT;
          CREATE TABLE artifact_revisions (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
            format TEXT NOT NULL, content TEXT NOT NULL, language TEXT, byte_length INTEGER NOT NULL,
            created_at INTEGER NOT NULL, UNIQUE(document_id, sequence)
          );
          CREATE TABLE artifact_publish_receipts (
            document_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL,
            PRIMARY KEY(document_id, request_id)
          );`);
        const insert = this.db.prepare('INSERT INTO artifact_revisions(id,document_id,sequence,title,format,content,byte_length,created_at) VALUES(?,?,1,?,?,?,?,?)');
        const update = this.db.prepare('UPDATE artifacts SET head_revision=? WHERE id=?');
        for (const row of this.db.prepare('SELECT * FROM artifacts').all()) {
          const id = revisionId();
          insert.run(id, row.id, row.title, row.format, row.markdown, Buffer.byteLength(row.markdown), this.now());
          update.run(id, row.id);
        }
        this.db.prepare('INSERT INTO artifact_schema_migrations VALUES(2,?)').run(this.now());
      }
    });
  }
  create(input) {
    const { title, owner, expiresAt = null, feedbackMode = 'discuss' } = input;
    if (!['discuss', 'revise'].includes(feedbackMode)) throw new ArtifactError('Feedback mode must be discuss or revise');
    const { format, content, language } = validateArtifact(input, this.now());
    this.cleanup();
    const token = secret(), id = revisionId(), initial = revisionId();
    const claimUntil = Math.min(this.now() + this.claimMs, expiresAt ?? Infinity);
    this.transaction(() => {
      if (this.db.prepare('SELECT count(*) AS n FROM artifacts').get().n >= this.capacity) throw new ArtifactError('Artifact capacity reached', 429);
      this.db.prepare('INSERT INTO artifacts(id,token_hash,owner,title,markdown,claim_until,format,expires_at,live,head_revision,feedback_mode) VALUES(?,?,?,?,?,?,?,?,1,?,?)')
        .run(id, hash(token), owner, title, '', claimUntil, format, expiresAt, initial, feedbackMode);
      this.db.prepare('INSERT INTO artifact_revisions(id,document_id,sequence,title,format,content,language,byte_length,created_at) VALUES(?,?,1,?,?,?,?,?,?)')
        .run(initial, id, title, format, content, language ?? null, Buffer.byteLength(content), this.now());
    });
    return { id, token, claimUntil, revisionId: initial, sequence: 1 };
  }
  alive(row) {
    const now = this.now();
    return row && !row.revoked && (row.expires_at === null || now < row.expires_at) && (row.session_hash ? now < row.read_until : now < row.claim_until);
  }
  browserRow(token, session) {
    if (!validToken(token) || !validToken(session)) return null;
    const row = this.db.prepare('SELECT * FROM artifacts WHERE token_hash=?').get(hash(token));
    return this.alive(row) && row.session_hash === hash(session) ? row : null;
  }
  get(token, session, selectedRevision) {
    if (!validToken(token)) return null;
    const row = this.db.prepare('SELECT * FROM artifacts WHERE token_hash=?').get(hash(token));
    if (!this.alive(row)) return null;
    if (!row.session_hash) return { kind: 'unclaimed' };
    if (!validToken(session) || hash(session) !== row.session_hash) return null;
    const revision = this.db.prepare('SELECT * FROM artifact_revisions WHERE document_id=? AND id=?').get(row.id, selectedRevision ?? row.head_revision);
    if (!revision) return null;
    return { kind: 'claimed', id: row.id, documentId: row.id, ...source(revision), feedbackMode: row.feedback_mode, live: Boolean(row.live), headRevision: row.head_revision, readUntil: row.read_until };
  }
  claim(token) {
    if (!validToken(token)) return null;
    const session = secret();
    const now = this.now();
    const result = this.db.prepare(`UPDATE artifacts SET session_hash=?, read_until=MIN(?, COALESCE(expires_at, ?))
      WHERE token_hash=? AND session_hash IS NULL AND revoked=0 AND claim_until>? AND (expires_at IS NULL OR expires_at>?)`)
      .run(hash(session), now + this.readMs, now + this.readMs, hash(token), now, now);
    return result.changes === 1 ? session : null;
  }
  ownerRow(id, owner) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=? AND owner=?').get(id, owner);
    if (!this.alive(row)) throw new ArtifactError('Artifact unavailable', 404);
    return row;
  }
  inspect(id, owner, { requestId, revisionId: selectedRevision } = {}) {
    if (requestId !== undefined && !validRequest(requestId)) throw new ArtifactError('Request ID must be a UUIDv4');
    if (selectedRevision !== undefined && !validRevision(selectedRevision)) throw new ArtifactError('Invalid revision ID');
    const row = this.ownerRow(id, owner);
    const history = this.db.prepare('SELECT * FROM artifact_revisions WHERE document_id=? ORDER BY sequence').all(id).map(metadata);
    const head = history.find(revision => revision.revisionId === row.head_revision);
    const result = { id, documentId: id, feedbackMode: row.feedback_mode, live: Boolean(row.live), headRevision: row.head_revision, sequence: head.sequence, title: head.title, claimUntil: row.claim_until, readUntil: row.read_until, appliedRevision: row.applied_revision, history, revisions: history };
    if (selectedRevision !== undefined) {
      const revision = this.db.prepare('SELECT * FROM artifact_revisions WHERE document_id=? AND id=?').get(id, selectedRevision);
      if (!revision) throw new ArtifactError('Revision unavailable', 404);
      Object.assign(result, source(revision));
    }
    if (requestId !== undefined) {
      const prior = this.db.prepare('SELECT receipt FROM artifact_publish_receipts WHERE document_id=? AND request_id=?').get(id, requestId.toLowerCase());
      result.receipt = prior ? JSON.parse(prior.receipt) : null;
    }
    return result;
  }
  publish(input) {
    const { id, owner, expectedRevision, requestId, title, summary = '' } = input;
    if (!validRevision(expectedRevision)) throw new ArtifactError('Invalid expected revision');
    if (!validRequest(requestId)) throw new ArtifactError('Request ID must be a UUIDv4');
    if (typeof summary !== 'string' || summary.length > 1000) throw new ArtifactError('Summary must be at most 1000 characters');
    const validated = validateArtifact({ ...input, title: title === undefined ? 'Revision' : title, expiresAt: null }, this.now());
    const fingerprint = hash(JSON.stringify({ expectedRevision, title: title ?? null, summary, ...validated }));
    return this.transaction(() => {
      const row = this.ownerRow(id, owner);
      if (!row.live) throw new ArtifactError('Legacy artifacts are frozen; create a new live artifact', 409);
      const prior = this.db.prepare('SELECT * FROM artifact_publish_receipts WHERE document_id=? AND request_id=?').get(id, requestId.toLowerCase());
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ArtifactError('Request ID already has a different publication', 409);
        return JSON.parse(prior.receipt);
      }
      if (row.head_revision !== expectedRevision) throw new ArtifactError('Artifact revision conflict', 409);
      const usage = this.db.prepare('SELECT count(*) n, sum(byte_length) bytes FROM artifact_revisions WHERE document_id=?').get(id);
      if (usage.n >= 50 || usage.bytes + Buffer.byteLength(validated.content) > 8 * 1024 * 1024) throw new ArtifactError('Artifact revision capacity reached', 429);
      const revision = revisionId(), sequence = usage.n + 1;
      const head = this.db.prepare('SELECT title FROM artifact_revisions WHERE id=?').get(row.head_revision);
      this.db.prepare('INSERT INTO artifact_revisions(id,document_id,sequence,title,summary,format,content,language,byte_length,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(revision, id, sequence, title ?? head.title, summary, validated.format, validated.content, validated.language ?? null, Buffer.byteLength(validated.content), this.now());
      this.db.prepare('UPDATE artifacts SET head_revision=? WHERE id=?').run(revision, id);
      const receipt = { id, documentId: id, revisionId: revision, sequence, headRevision: revision };
      this.db.prepare('INSERT INTO artifact_publish_receipts(document_id,request_id,fingerprint,receipt) VALUES(?,?,?,?)').run(id, requestId.toLowerCase(), fingerprint, JSON.stringify(receipt));
      return receipt;
    });
  }
  viewerStatus(token, session) {
    const row = this.browserRow(token, session);
    if (!row) return null;
    const revisions = this.db.prepare('SELECT * FROM artifact_revisions WHERE document_id=? ORDER BY sequence').all(row.id).map(metadata);
    const head = revisions.find(revision => revision.revisionId === row.head_revision);
    return { head: { revisionId: head.revisionId, sequence: head.sequence, format: head.format, summary: head.summary, live: Boolean(row.live) }, revisions };
  }
  markApplied(token, session, selectedRevision) {
    if (!validRevision(selectedRevision)) return false;
    return this.transaction(() => {
      const row = this.browserRow(token, session);
      if (!row) return false;
      const next = this.db.prepare('SELECT sequence FROM artifact_revisions WHERE document_id=? AND id=?').get(row.id, selectedRevision);
      if (!next) return false;
      const prior = row.applied_revision && this.db.prepare('SELECT sequence FROM artifact_revisions WHERE document_id=? AND id=?').get(row.id, row.applied_revision);
      if (!prior || next.sequence > prior.sequence) this.db.prepare('UPDATE artifacts SET applied_revision=? WHERE id=?').run(selectedRevision, row.id);
      return true;
    });
  }
  revoke(id, owner) {
    // Foreign-key cascades erase all source revisions and idempotency receipts.
    return this.db.prepare('DELETE FROM artifacts WHERE id=? AND owner=?').run(id, owner).changes === 1;
  }
  cleanup() {
    const now = this.now();
    return this.db.prepare(`DELETE FROM artifacts WHERE revoked=1 OR (expires_at IS NOT NULL AND expires_at<=?) OR
      (session_hash IS NULL AND claim_until<=?) OR (session_hash IS NOT NULL AND read_until<=?)`).run(now, now, now).changes;
  }
  close() { this.db.close(); }
}
