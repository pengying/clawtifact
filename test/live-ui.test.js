import test from 'node:test';
import assert from 'node:assert/strict';
const live = await import('../web/live.js').catch(() => ({}));
const revision = n => n.toString(16).padStart(32, '0');
const head = (n, format = 'markdown') => ({ revisionId: revision(n), sequence: n, format, live: true });
const snapshot = (n, cursor = n, extra = {}) => ({ epoch: 'boot-a', snapshotSequence: cursor, head: head(n), revisions: [head(1), head(2), head(3)], feedback: { enabled: true, batches: [] }, chat: { enabled: true, messages: [] }, ...extra });
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.style = {}; this.attributes = {}; this.hidden = false; this.contentWindow = tag === 'iframe' ? { messages: [], postMessage(data) { this.messages.push(data); } } : undefined; }
  append(...nodes) { for (const n of nodes) { this.children.push(n); n.parentNode = this; } }
  replaceChildren(...nodes) { this.children.forEach(n => n.parentNode = null); this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(k, fn) { this.listeners.set(k, [...this.listeners.get(k) || [], fn]); }
  removeEventListener(k, fn) { this.listeners.set(k, (this.listeners.get(k) || []).filter(v => v !== fn)); }
  emit(k, data = {}) { for (const fn of this.listeners.get(k) || []) fn({ target: this, ...data }); }
  replaceWith(node) { const p = this.parentNode, i = p.children.indexOf(this); p.children[i] = node; node.parentNode = p; this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
}
function harness(format = 'markdown') {
  const root = new Element('div'), frame = new Element('iframe'), page = new Element('main'), win = new Element('window'), calls = [], controllers = [], sources = [], storage = new Map();
  root.dataset = { path: '/a/example', artifactId: 'document-1', revisionId: revision(1), sequence: '1', format, live: 'true', csrf: 'c'.repeat(43) };
  frame.id = 'artifact-content'; frame.src = '/a/example/content?revision=' + revision(1); frame.setAttribute('sandbox', 'allow-scripts'); page.append(frame, root);
  class Source extends Element { constructor(url) { super('source'); this.url = url; sources.push(this); } close() { this.closed = true; } }
  let busy = false;
  const mountFeedback = (_root, mountedFrame, options) => { const ctl = { frame: mountedFrame, options, snapshots: [], isBusy: () => busy, applySnapshot(value) { this.snapshots.push(value); }, dispose() { this.disposed = true; } }; controllers.push(ctl); return ctl; };
  const env = { document: { createElement: tag => new Element(tag), hidden: false }, window: win, EventSource: Source, sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, fetch: async (url, options = {}) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => snapshot(1) }; } };
  return { root, frame, page, win, calls, sources, controllers, env, busy(value) { busy = value; }, currentFrame: () => page.children.find(n => n.tagName === 'iframe' && !n.hidden), candidate: () => page.children.find(n => n.tagName === 'iframe' && n.hidden), all: () => { const walk = n => [n, ...n.children.flatMap(walk)]; return walk(page); } };
}
function start(h) { assert.equal(typeof live.createLiveViewer, 'function'); return live.createLiveViewer({ root: h.root, frame: h.frame, mountFeedback: (_r, f, options) => { const c = { frame: f, options, snapshots: [], isBusy: () => h._busy, applySnapshot(s) { this.snapshots.push(s); }, dispose() { this.disposed = true; } }; h.controllers.push(c); return c; }, ...h.env }); }
function ready(h, frame) { const request = frame.contentWindow.messages.findLast(m => m.type === 'clawtifact:request-ready'); assert.ok(request, 'load requests correlated bridge readiness'); h.win.emit('message', { source: frame.contentWindow, data: { type: 'clawtifact:ready', requestId: request.requestId } }); }
function loaded(h, frame = h.candidate()) { frame.emit('load'); ready(h, frame); }
function idle(h) { h.win.emit('message', { source: h.currentFrame().contentWindow, data: { type: 'clawtifact:activity', idle: true } }); }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('readonly idle proof stages a fresh explicit revision frame and acknowledges only after atomic load', async () => {
  const h = harness(), ctl = start(h); idle(h); ctl.applySnapshot(snapshot(2));
  const next = h.candidate(); assert.ok(next); assert.notEqual(next.contentWindow, h.frame.contentWindow); assert.match(next.src, new RegExp('revision=' + revision(2))); assert.equal(h.root.dataset.revisionId, revision(1));
  loaded(h, next); await tick(); assert.equal(h.currentFrame(), next); assert.equal(h.root.dataset.revisionId, revision(2)); assert.equal(h.controllers[0].disposed, true); assert.equal(h.controllers.length, 2);
  assert.ok(h.calls.some(c => c.url.endsWith('/applied') && JSON.parse(c.options.body).revisionId === revision(2))); ctl.dispose();
});

test('feedback/chat drafts, selection, render, upload and submissions pin even explicit Apply', () => {
  const h = harness(), ctl = start(h); h._busy = true; idle(h); ctl.applySnapshot(snapshot(2)); assert.equal(h.candidate(), undefined); assert.equal(ctl.applyLatest(), false); assert.equal(h.root.dataset.revisionId, revision(1));
  h._busy = false; assert.equal(ctl.applyLatest(), true); loaded(h); assert.equal(h.root.dataset.revisionId, revision(2)); ctl.dispose();
});

test('new interaction before candidate load defers the switch without discarding the reviewed frame', () => {
  const h = harness(), ctl = start(h); idle(h); ctl.applySnapshot(snapshot(2)); const next = h.candidate(); h._busy = true; next.emit('load'); assert.equal(h.currentFrame(), h.frame); assert.equal(h.controllers[0].disposed, undefined); assert.equal(h.root.dataset.revisionId, revision(1)); ctl.dispose();
});

test('HTML and React require explicit Apply even if child claims idle', () => {
  for (const format of ['html', 'react']) {
    const h = harness(format), ctl = start(h); idle(h); ctl.applySnapshot(snapshot(2, 2, { head: head(2, format) })); assert.equal(h.candidate(), undefined); assert.ok(h.all().some(n => n.textContent === 'Apply')); assert.equal(ctl.applyLatest(), true); loaded(h); assert.equal(h.root.dataset.revisionId, revision(2)); ctl.dispose();
  }
});

test('missing idle proof is conservative; stale frames cannot unlock a new generation', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(2)); assert.equal(h.candidate(), undefined); ctl.applyLatest(); const next = h.candidate(); loaded(h, next);
  h.win.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:activity', idle: true } }); ctl.applySnapshot(snapshot(3)); assert.equal(h.candidate(), undefined); ctl.dispose();
});

test('snapshot cursor tracks status-only events, drops out-of-order delivery and resets on epoch', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(1, 8)); const old = h.controllers[0].snapshots.length;
  ctl.applySnapshot(snapshot(1, 9, { chat: { enabled: true, messages: [{ role: 'agent', text: 'Pushed reply' }] } })); assert.equal(h.controllers[0].snapshots.length, old + 1);
  ctl.applySnapshot(snapshot(3, 7)); assert.equal(h.controllers[0].snapshots.length, old + 1);
  ctl.applySnapshot(snapshot(2, 1, { epoch: 'boot-b' })); assert.equal(h.controllers[0].snapshots.length, old + 2); assert.equal(ctl.getState().head.revisionId, revision(2)); ctl.dispose();
});

test('historical message version navigation remains pinned until View latest', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(3)); ctl.viewRevision(revision(2)); loaded(h); idle(h); ctl.applySnapshot(snapshot(3, 4)); assert.equal(h.candidate(), undefined); assert.ok(h.all().some(n => n.textContent === 'View latest')); ctl.applyLatest(); loaded(h); assert.equal(h.root.dataset.revisionId, revision(3)); ctl.dispose();
});

test('named SSE snapshots reconcile discussion and terminal expiry removes all authored access', () => {
  const h = harness(), ctl = start(h); assert.equal(h.sources.length, 1); assert.ok(h.sources[0].url.endsWith('/events'));
  h.sources[0].emit('snapshot', { data: JSON.stringify(snapshot(1, 1)) }); assert.equal(h.controllers[0].snapshots.length, 1);
  h.sources[0].emit('error'); assert.ok(h.all().some(n => /Reconnect/.test(n.textContent || '')));
  h.sources[0].emit('expired'); assert.equal(h.sources[0].closed, true); assert.equal(h.controllers[0].disposed, true); assert.equal(h.currentFrame(), undefined); assert.equal(ctl.applyLatest(), false); ctl.dispose();
});

test('initial shell has no update notice until an authoritative head is known', () => {
  const h = harness(), ctl = start(h); assert.equal(h.all().find(n => n.className === 'af-live-bar').hidden, true); ctl.dispose();
});

test('a saved reviewed revision survives initial snapshot arrival while its frame loads', () => {
  const h = harness(); h.env.sessionStorage.setItem('clawtifact:pin:feedback:document-1', JSON.stringify(head(2))); const ctl = start(h); const next = h.candidate(); assert.ok(next);
  ctl.applySnapshot(snapshot(3)); assert.equal(h.candidate(), next); loaded(h, next); assert.equal(h.root.dataset.revisionId, revision(2)); assert.equal(ctl.getState().historical, true); ctl.dispose();
});

test('new readonly idle proof can apply an already-announced head without waiting for another publication', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(2)); assert.equal(h.candidate(), undefined); idle(h); assert.ok(h.candidate()); ctl.dispose();
});

test('retired-epoch delayed delivery never overwrites a newer reconnect snapshot', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(1, 99)); ctl.applySnapshot(snapshot(2, 1, { epoch: 'boot-b' })); ctl.applySnapshot(snapshot(3, 100)); assert.equal(ctl.getState().head.revisionId, revision(2)); ctl.dispose();
});

test('preloaded iframe is revealed in place without reparenting its browsing context', () => {
  const h = harness(), ctl = start(h); h.frame.replaceWith = () => assert.fail('moving the preloaded iframe can reload its browsing context'); ctl.applySnapshot(snapshot(2)); ctl.applyLatest(); const next = h.candidate(); loaded(h, next); assert.equal(h.currentFrame(), next); ctl.dispose();
});


test('load alone (including an HTTP error document) never switches or acknowledges a candidate', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(2)); ctl.applyLatest(); const next = h.candidate(); next.emit('load');
  assert.equal(h.currentFrame(), h.frame); assert.equal(h.root.dataset.revisionId, revision(1)); assert.equal(h.calls.some(c => c.url.endsWith('/applied') && JSON.parse(c.options.body).revisionId === revision(2)), false);
  const request = next.contentWindow.messages.findLast(m => m.type === 'clawtifact:request-ready');
  h.win.emit('message', { source: {}, data: { type: 'clawtifact:ready', requestId: request.requestId } });
  h.win.emit('message', { source: next.contentWindow, data: { type: 'clawtifact:ready', requestId: 'wrong' } }); assert.equal(h.currentFrame(), h.frame);
  ready(h, next); assert.equal(h.currentFrame(), next); ctl.dispose();
});

test('selection activity pins immediately, before debounced quote capture reaches feedback', () => {
  const h = harness(), ctl = start(h); ctl.applySnapshot(snapshot(2));
  h.win.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:activity', idle: false, selection: true } }); assert.equal(ctl.applyLatest(), false);
  h.win.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:activity', idle: true, selection: false } }); assert.ok(h.candidate()); ctl.dispose();
});

test('initial bridge readiness replays idle request lost before frame scripts initialized', () => {
  const h = harness(), ctl = start(h); const before = h.frame.contentWindow.messages.filter(m => m.type === 'clawtifact:request-activity').length; ready(h, h.frame); assert.equal(h.frame.contentWindow.messages.filter(m => m.type === 'clawtifact:request-activity').length, before + 1); ctl.dispose();
});

test('storage-disabled browsers still initialize the live controller', () => {
  const h = harness(), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'); h.env.sessionStorage = undefined;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  try { const ctl = start(h); assert.ok(ctl); ctl.dispose(); } finally { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else delete globalThis.sessionStorage; }
});

test('Updated notice is brief and its timer is disposed with the viewer', () => {
  const h = harness(), timers = new Map(); let nextId = 0;
  h.env.setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, { fn: () => { timers.delete(id); fn(); }, ms }); return id; }; h.env.clearTimeout = id => timers.delete(id);
  const ctl = start(h); ctl.applySnapshot(snapshot(2)); ctl.applyLatest(); loaded(h); const notice = [...timers.values()].find(t => t.ms === 3500); assert.ok(notice); notice.fn(); assert.equal(h.all().find(n => n.className === 'af-live-bar').hidden, true);
  ctl.applySnapshot(snapshot(3)); ctl.applyLatest(); loaded(h); ctl.dispose(); assert.equal(timers.size, 0);
});
