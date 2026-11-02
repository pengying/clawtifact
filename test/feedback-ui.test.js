import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const ui = await import('../web/feedback.js').catch(() => ({}));
const id = 'f6a39a83-1a99-46ac-9d4d-5dfe9e72fb7a';
const general = { type: 'general' };
const comment = { text: 'Please explain this.', anchor: general };

test('trusted source only: forged child data cannot route or create comments', () => {
  assert.equal(typeof ui.parseBridgeMessage, 'function');
  const child = {};
  assert.equal(ui.parseBridgeMessage({ source: {}, data: { type: 'clawtifact:selection', anchor: { type: 'text', quote: 'hello', prefix: '', suffix: '' } } }, child), null);
  assert.equal(ui.parseBridgeMessage({ source: child, data: { type: 'feedback:send', comments: [comment] } }, child), null);
  const result = ui.parseBridgeMessage({ source: child, data: { type: 'clawtifact:selection', anchor: { type: 'text', quote: '<script>x</script>', prefix: '', suffix: '' }, csrf: 'stolen', route: '/evil' } }, child);
  assert.deepEqual(result, { type: 'selection', anchor: { type: 'text', quote: '<script>x</script>', prefix: '', suffix: '' } });
});
test('anchor validation rejects oversize text and nonfinite or out-of-range regions', () => {
  assert.equal(typeof ui.normalizeAnchor, 'function');
  assert.equal(ui.normalizeAnchor({ type: 'text', quote: 'x'.repeat(2001), prefix: '', suffix: '' }), null);
  assert.equal(ui.normalizeAnchor({ type: 'region', x: .9, y: 0, width: .2, height: .1, scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 }), null);
  assert.equal(ui.normalizeAnchor({ type: 'region', x: 0, y: 0, width: .2, height: .1, scrollX: NaN, scrollY: 0, viewportWidth: 800, viewportHeight: 600 }), null);
  assert.deepEqual(ui.normalizeAnchor(general), general);
});
test('parent region drawing normalizes both drag directions independent of child messages', () => {
  assert.equal(typeof ui.regionFromPoints, 'function');
  assert.deepEqual(ui.regionFromPoints({ x: 80, y: 90 }, { x: 20, y: 30 }, { width: 100, height: 100 }, { scrollX: 0, scrollY: 0, viewportWidth: 100, viewportHeight: 100 }), { type: 'region', x: .2, y: .3, width: .6, height: .6, scrollX: 0, scrollY: 0, viewportWidth: 100, viewportHeight: 100, scrollKnown: false });
});
test('batch creation validates limits and only includes allowed protocol fields', () => {
  assert.equal(typeof ui.createBatch, 'function');
  assert.deepEqual(ui.createBatch(id, 'c'.repeat(43), [{ ...comment, route: '/evil' }]), { id, csrf: 'c'.repeat(43), comments: [comment] });
  assert.throws(() => ui.createBatch(id, 'c'.repeat(43), [{ ...comment, text: ' ' }]));
  assert.throws(() => ui.createBatch(id, 'c'.repeat(43), Array(21).fill(comment)));
  assert.throws(() => ui.createBatch(id, 'c'.repeat(43), [{ text: 'x'.repeat(1001), anchor: general }]));
  assert.throws(() => ui.createBatch(id, 'c'.repeat(43), Array(20).fill({ text: '字'.repeat(1000), anchor: general })));
});
test('queued and uncertain outcomes preserve drafts and ID, delivery alone clears', () => {
  assert.equal(typeof ui.applyBatchStatus, 'function');
  const state = { drafts: [comment], batch: { id, status: 'sending' } };
  for (const status of ['queued', 'uncertain', 'failed']) {
    const next = ui.applyBatchStatus(state, id, status);
    assert.deepEqual(next.drafts, state.drafts);
    assert.equal(next.batch.id, id);
    assert.equal(next.batch.status, status);
  }
  assert.equal(ui.applyBatchStatus(state, 'unknown', 'delivered'), state);
  assert.deepEqual(ui.applyBatchStatus(state, id, 'delivered').drafts, []);
});
test('restored in-flight submissions become uncertain without resending', () => {
  assert.equal(typeof ui.restoreDrafts, 'function');
  const stored = JSON.stringify({ drafts: [comment], batch: { id, status: 'sending' } });
  assert.deepEqual(ui.restoreDrafts(stored), { drafts: [comment], batch: { id, status: 'uncertain' } });
  assert.deepEqual(ui.restoreDrafts('{broken'), { drafts: [], batch: null });
  assert.deepEqual(ui.restoreDrafts(JSON.stringify({ drafts: [{ text: 'x', anchor: { type: 'bad' } }] })), { drafts: [], batch: null });
});
test('host and bridge do not render untrusted markup or leak credentials', async () => {
  const host = await readFile(new URL('../web/feedback.js', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../web/bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(host, /\.innerHTML\s*=/);
  assert.doesNotMatch(bridge, /\b(fetch|XMLHttpRequest|csrf|sessionStorage)\b/);
});

// A deliberately small DOM harness exercises the real parent state/network flow
// without executing authored HTML or adding a DOM dependency.
function fakeHost() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.style = {}; this.value = ''; this.attributes = {}; }
    append(...nodes) { for (const n of nodes) { this.children.push(n); if (typeof n === 'object') n.parent = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(k, v) { this.attributes[k] = v; }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
    async emit(type, data = {}) { const event = { preventDefault() {}, ...data }; for (const fn of this.listeners.get(type) || []) await fn(event); }
    async click() { if (!this.disabled) await this.emit('click'); }
    focus() { this.focused = true; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  }
  const root = new Element('div'); root.dataset = { path: '/a/example', artifactId: 'artifact-test', csrf: 'c'.repeat(43), enabled: 'true' };
  const frame = new Element('iframe'); const childMessages = []; frame.contentWindow = { postMessage: data => childMessages.push(data) };
  const listeners = new Map(); const storage = new Map();
  const env = {
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    window: { addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  };
  const all = (node = root) => [node, ...node.children.filter(n => typeof n === 'object').flatMap(n => n.children ? all(n) : [n])];
  const find = text => all().find(n => n.tagName === 'button' && n.textContent === text);
  const emit = (type, data) => { for (const fn of listeners.get(type) || []) fn(data); };
  return { root, frame, env, all, find, emit, childMessages, storage };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('real host flow requires explicit composition and sends once, with no credentials in bridge messages', async () => {
  const h = fakeHost(), previous = new Map();
  const requests = []; let deliver = false;
  const fetchStub = async (path, options) => {
    requests.push({ path, options });
    if (options.method === 'POST') return { status: 202, json: async () => ({ batchId: JSON.parse(options.body).id, status: 'queued' }) };
    const posted = requests.find(r => r.options.method === 'POST');
    return { ok: true, status: 200, json: async () => ({ enabled: true, batches: posted && deliver ? [{ batchId: JSON.parse(posted.options.body).id, status: 'delivered' }] : [] }) };
  };
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush();
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:selection', anchor: { type: 'text', quote: '<script>not markup</script>', prefix: '', suffix: '' }, comments: [comment], csrf: 'forged', route: '/evil' } });
    assert.equal(controller.getState().drafts.length, 0);
    assert.equal(requests.filter(r => r.options.method === 'POST').length, 0);
    await h.find('Use selected text').click();
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = '<img src=x onerror=evil()> Please explain'; await textarea.emit('input');
    await h.find('Add comment').click();
    const focus = h.all().find(n => n.tagName === 'button' && n.className === 'af-anchor'); await focus.click();
    assert.deepEqual(h.childMessages, [{ type: 'clawtifact:highlight', anchor: { type: 'text', quote: '<script>not markup</script>', prefix: '', suffix: '' } }]);
    await h.find('Send feedback').click(); await flush();
    assert.equal(controller.getState().batch.status, 'queued'); assert.equal(controller.getState().drafts.length, 1);
    await h.find('Send feedback').click();
    assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
    assert.equal(requests.at(-1).path, '/a/example/feedback');
    const body = JSON.parse(requests.find(r => r.options.method === 'POST').options.body);
    assert.deepEqual(Object.keys(body).sort(), ['comments', 'csrf', 'id']);
    assert.equal(body.comments[0].text, '<img src=x onerror=evil()> Please explain');
    deliver = true; await h.find('Feedback').click(); await flush();
    assert.equal(controller.getState().batch.status, 'delivered'); assert.equal(controller.getState().drafts.length, 0);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('parent region selection works with no child bridge, and reload never resubmits uncertain batch', async () => {
  const h = fakeHost(), previous = new Map(); let postCount = 0;
  const fetchStub = async (_path, options) => {
    if (options.method === 'POST') { postCount++; throw new Error('ambiguous network interruption'); }
    return { ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) };
  };
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush();
    await h.find('Select region').click();
    const overlay = h.all().find(n => n.className === 'af-region-selector');
    await overlay.emit('keydown', { key: 'Enter' });
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Region feedback'; await textarea.emit('input');
    await h.find('Add comment').click();
    assert.equal(controller.getState().drafts[0].anchor.type, 'region');
    assert.equal(controller.getState().drafts[0].anchor.viewportWidth, 800);
    await h.find('Send feedback').click(); await flush();
    assert.equal(controller.getState().batch.status, 'uncertain'); const originalID = controller.getState().batch.id;
    const reloaded = fakeHost(); reloaded.root.dataset = h.root.dataset;
    const restored = ui.initializeFeedback(reloaded.root, reloaded.frame); await flush();
    assert.equal(restored.getState().batch.id, originalID);
    assert.equal(restored.getState().drafts.length, 1); assert.equal(postCount, 1);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});


test('region anchors preserve explicit scroll knowledge and reject malformed flags', () => {
  const region = { type: 'region', x: .1, y: .1, width: .2, height: .2, scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 };
  assert.equal(ui.normalizeAnchor(region).scrollKnown, false);
  assert.equal(ui.normalizeAnchor({ ...region, scrollKnown: true }).scrollKnown, true);
  assert.equal(ui.normalizeAnchor({ ...region, scrollKnown: 'true' }), null);
});
test('batch IDs match the server UUIDv4-only protocol', () => {
  assert.throws(() => ui.createBatch('f6a39a83-1a99-16ac-9d4d-5dfe9e72fb7a', 'c'.repeat(43), [comment]));
});

test('bridge focuses unknown-scroll regions in current viewport without scrolling the artifact', async () => {
  const source = await readFile(new URL('../web/bridge.js', import.meta.url), 'utf8');
  const listeners = new Map(), markers = []; let scrollCalls = 0;
  const parent = { postMessage() {} };
  const context = {
    window: { parent, scrollX: 142, scrollY: 280, innerWidth: 800, innerHeight: 600, addEventListener: (type, fn) => listeners.set(type, fn) },
    document: { currentScript: { src: 'https://review.example.com/artifacts/assets/bridge.js' }, addEventListener() {}, body: { append: node => markers.push(node) }, createElement: () => ({ style: {}, setAttribute() {}, remove() {}, scrollIntoView() { scrollCalls++; } }) },
    clearTimeout, setTimeout, URL, requestAnimationFrame: callback => callback()
  };
  runInNewContext(source, context);
  const anchor = { type: 'region', x: .1, y: .2, width: .2, height: .3, scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600, scrollKnown: false };
  listeners.get('message')({ source: parent, data: { type: 'clawtifact:highlight', anchor } });
  assert.equal(scrollCalls, 0); assert.equal(markers[0].style.position, 'fixed');
  listeners.get('message')({ source: parent, data: { type: 'clawtifact:highlight', anchor: { ...anchor, scrollKnown: true } } });
  assert.equal(scrollCalls, 1); assert.equal(markers[1].style.position, 'absolute');
});
test('validated viewport reports produce known-scroll region drafts and accurate labels', async () => {
  const h = fakeHost(), previous = new Map();
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush();
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 420, viewportWidth: 800, viewportHeight: 600 } });
    await h.find('Select region').click();
    await h.all().find(n => n.className === 'af-region-selector').emit('keydown', { key: 'Enter' });
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Known region'; await textarea.emit('input');
    await h.find('Add comment').click();
    assert.equal(controller.getState().drafts[0].anchor.scrollKnown, true);
    assert.equal(controller.getState().drafts[0].anchor.scrollY, 420);
    assert.equal(h.all().find(n => n.className === 'af-anchor').textContent, 'Selected region');
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});
