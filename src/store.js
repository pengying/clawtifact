import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const DAY = 86_400_000;
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function validateArtifact({ title, markdown, html, owner, expiresAt = null }, now = Date.now()) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Title must be 1–200 characters');
    if (markdown !== undefined && html !== undefined) throw new Error('Supply exactly one of markdown or html');
    const format = html !== undefined ? 'html' : 'markdown';
    const content = format === 'html' ? html : markdown;
    if (typeof content !== 'string' || !content.trim()) throw new Error(format === 'html' ? 'HTML is required' : 'Markdown is required');
    if (Buffer.byteLength(content) > 262144) throw new Error('Artifact is too large (256 KiB maximum)');
    if (typeof owner !== 'string' || !owner) throw new Error('A session owner is required');
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) throw new Error('Artifact deadline must be in the future');
    return { format, content };
}

export class ArtifactStore {
  constructor({ file, now = Date.now, claimMs = DAY, readMs = DAY, capacity = 1000 }) {
    this.now = now;
    this.claimMs = claimMs;
    this.readMs = readMs;
    this.capacity = capacity;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
        title TEXT NOT NULL, markdown TEXT NOT NULL, claim_until INTEGER NOT NULL,
        session_hash TEXT, read_until INTEGER, revoked INTEGER NOT NULL DEFAULT 0
      );`);
    // Additive migration preserves previously issued links and sessions.
    if (!this.db.prepare('PRAGMA table_info(artifacts)').all().some(column => column.name === 'format')) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN format TEXT NOT NULL DEFAULT 'markdown'");
    }
    if (!this.db.prepare('PRAGMA table_info(artifacts)').all().some(column => column.name === 'expires_at')) {
      this.db.exec('ALTER TABLE artifacts ADD COLUMN expires_at INTEGER');
    }
  }
  create({ title, markdown, html, owner, expiresAt = null }) {
    const { format, content } = validateArtifact({ title, markdown, html, owner, expiresAt }, this.now());
    this.cleanup();
    const token = secret();
    const id = randomBytes(16).toString('hex');
    const claimUntil = Math.min(this.now() + this.claimMs, expiresAt ?? Infinity);
    // Serialize count+insert across connections, not merely within this process.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT count(*) AS n FROM artifacts').get().n >= this.capacity) throw new Error('Artifact capacity reached');
      this.db.prepare('INSERT INTO artifacts(id, token_hash, owner, title, markdown, claim_until, format, expires_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, hash(token), owner, title, content, claimUntil, format, expiresAt);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { id, token, claimUntil };
  }
  get(token, session) {
    if (!validToken(token)) return null;
    const row = this.db.prepare('SELECT * FROM artifacts WHERE token_hash=? AND revoked=0').get(hash(token));
    if (!row || (row.expires_at !== null && this.now() >= row.expires_at)) return null;
    if (!row.session_hash) return this.now() < row.claim_until ? { kind: 'unclaimed' } : null;
    if (!validToken(session) || hash(session) !== row.session_hash || this.now() >= row.read_until) return null;
    return { kind: 'claimed', id: row.id, title: row.title, format: row.format, [row.format === 'html' ? 'html' : 'markdown']: row.markdown, readUntil: row.read_until };
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
  revoke(id, owner) {
    // Immediately erase content as well as invalidating access.
    return this.db.prepare('DELETE FROM artifacts WHERE id=? AND owner=?').run(id, owner).changes === 1;
  }
  cleanup() {
    const now = this.now();
    return this.db.prepare(`DELETE FROM artifacts WHERE revoked=1 OR
      (session_hash IS NULL AND claim_until<=?) OR (session_hash IS NOT NULL AND read_until<=?)`).run(now, now).changes;
  }
  close() { this.db.close(); }
}
