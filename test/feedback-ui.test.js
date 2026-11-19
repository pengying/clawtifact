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
    async emit(type, data = {}) { const event = { preventDefault() {}, stopPropagation() {}, target: this, ...data }; for (const fn of this.listeners.get(type) || []) await fn(event); }
    async click() { if (!this.disabled) await this.emit('click'); }
    focus() { this.focused = true; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
    setPointerCapture() {}
    attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
    getContext() { return { drawImage() {}, strokeRect() {} }; }
    toDataURL() { return 'data:image/jpeg;base64,/9j/2Q=='; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  }
  const root = new Element('div'); root.dataset = { path: '/a/example', artifactId: 'artifact-test', csrf: 'c'.repeat(43), enabled: 'true' };
  const frame = new Element('iframe'); const childMessages = []; frame.contentWindow = { postMessage: data => childMessages.push(data) };
  const listeners = new Map(); const storage = new Map();
  const env = {
    document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
    window: { addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); } },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  };
  const all = (node = root) => [node, ...node.children.filter(n => typeof n === 'object').flatMap(n => n.children ? all(n) : [n])];
  const find = text => all().find(n => n.tagName === 'button' && (n.textContent === text || n.attributes['aria-label'] === text));
  const emit = (type, data) => { for (const fn of listeners.get(type) || []) fn(data); };
  return { root, frame, env, all, find, emit, childMessages, storage };
}
async function beginSelection(h) {
  const panel=h.all().find(n=>n.className==='af-panel');
  if (!panel.hidden) await h.find('Close').click();
  await h.find('Feedback').click(); await h.find('Selector').click();
  if (panel.dataset.mode==='drafts') await h.find('Add another').click();
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('submission status and live agent replies sit above the feedback card and stay batch-scoped', async () => {
  const h = fakeHost(), previous = new Map(), posts = []; let finishPost;
  h.root.dataset.revisionId = 'a'.repeat(32);
  h.root.dataset.sequence = '1'; h.root.dataset.format = 'react';
  const pending = new Promise(resolve => { finishPost = resolve; });
  for (const [key, value] of Object.entries({ ...h.env, fetch: async (_path, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return pending; }
    return { ok: true, status: 200, json: async () => ({ enabled: true, chatEnabled: true, batches: [], messages: [] }) };
  } })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  const viewed = [];
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame, { onViewRevision: value => viewed.push(value) }); await flush();
    const panel = h.all().find(n => n.dataset.kind === 'feedback');
    const conversation = h.all().find(n => n.className === 'af-feedback-conversation');
    const card = h.all().find(n => n.className === 'af-feedback-card');
    assert.ok(conversation && card, 'conversation and composer are distinct lightweight areas');
    assert.ok(panel.children.indexOf(conversation) < panel.children.indexOf(card), 'conversation is above the feedback card');
    assert.equal(conversation.hidden, true, 'no blank status bubble before submission');
    const composer = h.all().find(n => n.tagName === 'textarea'); composer.value = 'Change the panel'; await composer.emit('input');
    await h.find('Add').click(); const sending = h.find('Submit feedback').click(); await flush();
    const status = h.all().find(n => n.className === 'af-status');
    assert.equal(status.parent, conversation); assert.equal(conversation.hidden, false); assert.equal(status.textContent, 'Submitting…');
    ctl.applySnapshot({ feedback: { enabled: true, chatEnabled: true, batches: [{ batchId: posts[0].id, status: 'received' }] }, chat: { enabled: true, messages: [{ id, role: 'agent', text: '<script>plain text</script> Published revision 2.', status: 'replied', revisionId: 'a'.repeat(32) }] } });
    finishPost({ status: 202, json: async () => ({ batchId: posts[0].id, status: 'queued' }) }); await sending;
    assert.match(status.textContent, /Received/); assert.equal(status.children.length, 0, 'do not display raw batch IDs');
    const notes = h.all().find(n => n.className === 'af-feedback-replies');
    assert.ok(notes.children.some(n => n.textContent === '<script>plain text</script> Published revision 2.'));
    assert.equal(ctl.getState().batch.status, 'received', 'late HTTP acknowledgement cannot demote the agent receipt');
    composer.value = 'A second batch'; await composer.emit('input'); await h.find('Add').click();
    ctl.applySnapshot({ feedback: { enabled: true, chatEnabled: true, batches: [{ batchId: posts[0].id, status: 'received' }] }, chat: { enabled: true, messages: [{ id, role: 'agent', text: 'Published revision 2.', status: 'replied', revisionId: 'b'.repeat(32) }] } });
    assert.equal(status.textContent, ''); assert.equal(status.hidden, true); assert.equal(ctl.getState().drafts[0].text, 'A second batch');
    assert.ok(notes.children.some(n => n.textContent === 'Published revision 2.'), 'starting feedback preserves discussion');
    await notes.children.find(n => n.tagName === 'button' && n.textContent === 'View version').click();
    assert.deepEqual(viewed, ['b'.repeat(32)]); assert.equal(posts.length, 1, 'no resubmission from status changes'); ctl.dispose();
  } finally { finishPost({ status: 202, json: async () => ({ batchId: posts[0]?.id, status: 'queued' }) }); h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('full Chat places its status below the conversation and directly above the composer', async () => {
  const h = fakeHost(), previous = new Map();
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame); await flush();
    const panel = h.all().find(n => n.className === 'af-panel af-chat-panel');
    const log = panel.children.find(n => n.className === 'af-chat-log');
    const status = panel.children.find(n => n.className === 'af-status');
    const composer = panel.children.find(n => n.className === 'af-chat-compose');
    assert.ok(panel.children.indexOf(log) < panel.children.indexOf(status));
    assert.ok(panel.children.indexOf(status) < panel.children.indexOf(composer)); ctl.dispose();
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('pre-submission validation errors unhide the above-composer status without posting', async () => {
  const h = fakeHost(), previous = new Map(), posts = [];
  h.storage.set('clawtifact:feedback:artifact-test', JSON.stringify({ drafts: Array.from({ length: 20 }, () => ({ text: '字'.repeat(1000), anchor: general })), batch: null }));
  for (const [key, value] of Object.entries({ ...h.env, fetch: async (_path, options) => { if (options.method === 'POST') posts.push(options.body); return { ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }; } })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame); await flush();
    const conversation = h.all().find(n => n.className === 'af-feedback-conversation'); assert.equal(conversation.hidden, true);
    await h.find('Submit feedback').click(); const status = h.all().find(n => n.className === 'af-status');
    assert.match(status.textContent, /too large/); assert.equal(status.hidden, false); assert.equal(conversation.hidden, false);
    assert.equal(posts.length, 0); assert.equal(ctl.getState().drafts.length, 20); ctl.dispose();
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('selector accepts click/drag gestures, keeps document markers and batches multiple comments once', async () => {
  const h = fakeHost(), previous = new Map(), posts = [];
  const fetchStub = async (_path, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); return { status: 202, json: async () => ({ batchId: posts[0].id, status: 'queued' }) }; }
    return { ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) };
  };
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush(); h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 } });
    await h.find('Feedback').click();
    assert.ok(h.find('Selector'), 'the floating menu exposes Selector');
    assert.equal(h.find('Chat unavailable')?.disabled, true, 'do not advertise Chat when its original-session capability is unavailable');
    await h.find('Selector').click();
    const layer = h.all().find(n => n.className === 'af-region-selector');
    await layer.emit('pointerdown', { button: 0, clientX: 80, clientY: 60, pointerId: 1 });
    await layer.emit('pointermove', { clientX: 240, clientY: 180 });
    await layer.emit('pointerup', { clientX: 240, clientY: 180 });
    assert.equal(h.all().includes(layer), false, 'pointer-up opens the composer without a mode toolbar');
    const textarea = h.all().find(n => n.tagName === 'textarea');
    textarea.value = 'First rectangle'; await textarea.emit('input'); await h.find('Add').click();
    assert.ok(h.childMessages.some(m=>m.type==='clawtifact:draft-markers'&&m.visible&&m.markers.length===1), 'saved comments get document-plane decorations');
    assert.equal(h.all().some(n=>n.className==='af-region-marker'),false,'no fixed host rectangle trails scrolling');
    assert.deepEqual(controller.getState().drafts[0].anchor, { type: 'region', x: .1, y: .1, width: .2, height: .2, scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600, scrollKnown: true });
    await beginSelection(h);
    await h.all().find(n => n.className === 'af-region-selector').emit('keydown', { key: 'Enter' });
    textarea.value = 'Second rectangle'; await textarea.emit('input'); await h.find('Add').click();
    assert.equal(posts.length, 0, 'composing multiple selections never sends them');
    await h.find('Submit feedback').click(); await flush();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].comments.map(c => c.text), ['First rectangle', 'Second rectangle']);
    assert.equal(controller.getState().batch.status, 'queued');
    assert.equal(h.find('Add another').disabled, true);
    await h.find('Close').click(); await h.find('Feedback').click();
    assert.equal(h.find('Selector').disabled, false, 'locked drafts remain available for read-only inspection');
    await h.find('Selector').click();
    assert.equal(h.all().find(n => n.className === 'af-panel').hidden, false);
    assert.equal(h.all().some(n => n.className === 'af-region-selector'), false);
    await h.find('Submit feedback').click(); assert.equal(posts.length, 1);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('reverse drawing stores normalized rectangle geometry', async () => {
  const h = fakeHost(), previous = new Map();
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller=ui.initializeFeedback(h.root, h.frame); await flush(); h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 } }); await beginSelection(h);
    const layer = h.all().find(n => n.className === 'af-region-selector');
    await layer.emit('pointerdown', { button: 0, clientX: 600, clientY: 450, pointerId: 1 });
    await layer.emit('pointerup', { clientX: 200, clientY: 150 });
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Reverse region'; await textarea.emit('input'); await h.find('Add').click();
    assert.deepEqual(ui.normalizeAnchor({type:'region',x:.25,y:.25,width:.5,height:.5,scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600,scrollKnown:true}),controller.getState().drafts[0].anchor);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('deleting a comment clears its decoration and recreating never sends prematurely', async () => {
  const h = fakeHost(), previous = new Map(); let posts = 0;
  for (const [key, value] of Object.entries({ ...h.env, fetch: async (_p, options) => { if (options.method === 'POST') posts++; return { ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }; } })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush(); h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 } });
    await beginSelection(h); await h.all().find(n => n.className === 'af-region-selector').emit('keydown', { key: 'Enter' });
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Keep this'; await textarea.emit('input'); await h.find('Add').click();
    assert.equal(h.find('Edit'),undefined);assert.equal(h.find('Adjust rectangle'),undefined);
    const original=structuredClone(controller.getState().drafts);
    await h.find('Add another').click();const layer=h.all().find(n=>n.className==='af-region-selector');
    await layer.emit('keydown',{key:'Enter',target:h.find('Cancel selection')});assert.ok(h.all().includes(layer),'controls cannot accept a region accidentally');
    await h.find('Cancel selection').click();assert.deepEqual(controller.getState().drafts,original);
    await h.find('Delete comment 1').click();assert.equal(controller.getState().drafts.length,0);assert.equal(posts,0);
    assert.equal(h.childMessages.findLast(m=>m.type==='clawtifact:draft-markers').markers.length,0,'deleting clears the document decoration');
    await h.find('Add another').click();await h.find('Move right').click();await h.find('Done selecting').click();
    textarea.value='Replacement';await textarea.emit('input');await h.find('Add').click();assert.equal(controller.getState().drafts.length,1);assert.equal(controller.getState().drafts[0].text,'Replacement');assert.equal(controller.getState().drafts[0].anchor.x,208/800);assert.equal(posts,0);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('non-drag controls adjust regions and a changed viewport cancels rather than accepting stale geometry', async () => {
  const h = fakeHost(), previous = new Map();
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush(); h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 } });
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 } });
    await beginSelection(h);
    assert.ok(h.find('Move right'), 'selection is operable without dragging');
    await h.find('Move right').click(); await h.find('Wider').click();
    await h.find('Done selecting').click();
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Adjusted'; await textarea.emit('input'); await h.find('Add').click();
    assert.equal(controller.getState().drafts[0].anchor.x, 208 / 800);
    assert.equal(controller.getState().drafts[0].anchor.width, 408 / 800);
    const original = structuredClone(controller.getState().drafts);
    await h.find('Add another').click();
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 400, viewportWidth: 800, viewportHeight: 600 } });
    assert.equal(h.all().some(n => n.className === 'af-region-selector'), false);
    assert.deepEqual(controller.getState().drafts, original);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('automatic crops stay local until explicit Send without a preview or edit requirement', async () => {
  const h=fakeHost(), previous=new Map(), posts=[];
  const fetchStub=async(path,options)=>{
    if(options.method==='POST'){
      const body=JSON.parse(options.body); posts.push({path,body});
      return {status:202,json:async()=>path.endsWith('/images')?{id:body.id,mimeType:'image/jpeg'}:{batchId:body.id,status:'queued'}};
    }
    return {ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})};
  };
  for(const[k,v]of Object.entries({...h.env,fetch:fetchStub})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try{
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    assert.equal(h.find('Attach screenshot'),undefined);await beginSelection(h);await h.find('Done selecting').click();
    const req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    const text=h.all().find(n=>n.tagName==='textarea');text.value='See this crop';await text.emit('input');await h.find('Add').click();
    assert.equal(h.find('View image'),undefined,'the list stays text and Delete only');
    assert.equal(ctl.getState().drafts[0].image.data,'/9j/2Q==');assert.equal(posts.length,0);
    assert.doesNotMatch([...h.storage.values()].join(''),/\/9j\/2Q==/);
    await h.find('Submit feedback').click();await flush();assert.equal(posts.length,2);assert.match(posts[0].path,/\/images$/);assert.equal(posts[1].body.comments[0].imageId,posts[0].body.id);
    await h.find('Submit feedback').click();assert.equal(posts.length,2);
  }finally{h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('restored screenshot references are validated and missing local crops block sending', () => {
  const imageId = 'a'.repeat(32);
  assert.equal(ui.restoreDrafts(JSON.stringify({ drafts: [{ ...comment, imageId }] })).drafts[0].imageId, imageId);
  assert.deepEqual(ui.restoreDrafts(JSON.stringify({ drafts: [{ ...comment, imageId: '../../secret' }] })).drafts, []);
  assert.equal(ui.restoreDrafts(JSON.stringify({ drafts: [{ ...comment, imageMissing: true }] })).drafts[0].imageMissing, true);
});

test('Chat updates the artifact with canonical replies and never sends routes, private context, or duplicate requests', async () => {
  const h = fakeHost(), previous = new Map(), posts = []; let messages = [], holdChatRead = true, finishChatRead;
  const fetchStub = async (path, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); posts.push({ path, body });
      messages = [{ id: body.id, text: body.text, status: 'queued', mirrorStatus: 'pending' }];
      return { status: 202, json: async () => messages[0] };
    }
    const response = { ok: true, status: 200, json: async () => path.endsWith('/chat') ? { enabled: true, messages } : { enabled: true, chatEnabled: true, batches: [] } };
    if (path.endsWith('/chat') && holdChatRead) { holdChatRead = false; return new Promise(resolve => { finishChatRead = () => resolve(response); }); }
    return response;
  };
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    ui.initializeFeedback(h.root, h.frame); await flush();
    assert.ok(h.find('Chat'), 'Chat is offered when the server confirms its capability');
    await h.find('Chat').click();
    const composer = h.all().find(n => n.className === 'af-chat-compose');
    assert.equal(composer.disabled, false, 'opening Chat must not drop input focus during its status read');
    composer.value = 'Draft during status read'; await composer.emit('input');
    finishChatRead(); await flush(); assert.equal(composer.value, 'Draft during status read');
    composer.value = 'Explain this design'; await composer.emit('input'); await h.find('Send message').click(); await flush();
    assert.equal(posts.length, 1); assert.match(posts[0].path, /\/chat$/);
    assert.deepEqual(Object.keys(posts[0].body).sort(), ['csrf', 'id', 'text']);
    await h.find('Send message').click(); assert.equal(posts.length, 1);
    messages = [{ ...messages[0], status: 'replied', reply: '<script>display as text</script> Simplify step two.', mirrorStatus: 'delivered' }];
    await h.find('Close chat').click(); await h.find('Chat').click(); await flush();
    assert.match(h.all().find(n => n.className === 'af-chat-model').textContent, /Simplify step two/);
    assert.equal(posts.length, 1); assert.deepEqual(h.childMessages.filter(m=>m.type!=='clawtifact:draft-markers'), [{ type: 'clawtifact:request-viewport' }]);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('Chat keeps polling and blocks conflicting sends for a server-side pending turn without local storage', async () => {
  const h = fakeHost(), previous = new Map(), timers = []; let messages = [{ id, text: 'From another tab', status: 'queued', mirrorStatus: 'pending' }];
  const fetchStub = async path => ({ ok: true, status: 200, json: async () => path.endsWith('/chat') ? { enabled: true, messages } : { enabled: true, chatEnabled: true, batches: [] } });
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {} })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    ui.initializeFeedback(h.root, h.frame); await flush(); await h.find('Chat').click(); await flush();
    const composer = h.all().find(n => n.className === 'af-chat-compose'); composer.value = 'Another question'; await composer.emit('input');
    assert.equal(h.find('Send message').disabled, true);
    assert.ok(timers.length, 'server-side pending messages schedule updates even without a local request ID');
    messages = [{ ...messages[0], status: 'replied', reply: 'Reply from the original session.', mirrorStatus: 'delivered' }];
    await timers.at(-1)(); await flush();
    assert.match(h.all().find(n => n.className === 'af-chat-model').textContent, /original session/);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('real host flow requires explicit composition and sends once, with no credentials in bridge messages', async () => {
  const h = fakeHost(), previous = new Map();
  const requests = [], timers = []; let deliver = false;
  const fetchStub = async (path, options) => {
    requests.push({ path, options });
    if (options.method === 'POST') return { status: 202, json: async () => ({ batchId: JSON.parse(options.body).id, status: 'queued' }) };
    const posted = requests.find(r => r.options.method === 'POST');
    return { ok: true, status: 200, json: async () => ({ enabled: true, batches: posted && deliver ? [{ batchId: JSON.parse(posted.options.body).id, status: 'delivered' }] : [] }) };
  };
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush();
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:selection', anchor: { type: 'text', quote: '<script>not markup</script>', prefix: '', suffix: '' }, comments: [comment], csrf: 'forged', route: '/evil' } });
    assert.equal(controller.getState().drafts.length, 0);
    assert.equal(requests.filter(r => r.options.method === 'POST').length, 0);
    await h.find('Feedback').click(); await h.find('Selector').click();
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = '<img src=x onerror=evil()> Please explain'; await textarea.emit('input');
    await h.find('Add').click();
    assert.deepEqual(h.childMessages.filter(m=>m.type!=='clawtifact:draft-markers'), [{ type: 'clawtifact:request-viewport' }]);
    await h.find('Submit feedback').click(); await flush();
    assert.equal(controller.getState().batch.status, 'queued'); assert.equal(controller.getState().drafts.length, 1);
    await h.find('Submit feedback').click();
    assert.equal(requests.filter(r => r.options.method === 'POST').length, 1);
    assert.equal(requests.at(-1).path, '/a/example/feedback');
    const body = JSON.parse(requests.find(r => r.options.method === 'POST').options.body);
    assert.deepEqual(Object.keys(body).sort(), ['comments', 'csrf', 'id']);
    assert.equal(body.comments[0].text, '<img src=x onerror=evil()> Please explain');
    deliver = true; assert.ok(timers.length,'queued submissions schedule confirmation checks');await timers.at(-1)();await flush();
    assert.equal(controller.getState().batch.status, 'delivered'); assert.equal(controller.getState().drafts.length, 0);
    const panel=h.all().find(n=>n.className==='af-panel');assert.equal(panel.hidden,false,'delivery confirmation keeps the card open');assert.equal(h.all().find(n=>n.className==='af-status').textContent,'Submitted. Thank you.');assert.equal(h.find('Submit feedback').hidden,true,'confirmed delivery clears the old batch from the list');
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
    const controller = ui.initializeFeedback(h.root, h.frame); await flush(); h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 0, viewportWidth: 800, viewportHeight: 600 } });
    await beginSelection(h);
    const overlay = h.all().find(n => n.className === 'af-region-selector');
    await overlay.emit('keydown', { key: 'Enter' });
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Region feedback'; await textarea.emit('input');
    await h.find('Add').click();
    assert.equal(controller.getState().drafts[0].anchor.type, 'region');
    assert.equal(controller.getState().drafts[0].anchor.viewportWidth, 800);
    await h.find('Submit feedback').click(); await flush();
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
test('validated viewport reports produce known-scroll region drafts without dialog metadata', async () => {
  const h = fakeHost(), previous = new Map();
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const controller = ui.initializeFeedback(h.root, h.frame); await flush();
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:viewport', scrollX: 0, scrollY: 420, viewportWidth: 800, viewportHeight: 600 } });
    await beginSelection(h);
    await h.all().find(n => n.className === 'af-region-selector').emit('keydown', { key: 'Enter' });
    const textarea = h.all().find(n => n.tagName === 'textarea'); textarea.value = 'Known region'; await textarea.emit('input');
    await h.find('Add').click();
    assert.equal(controller.getState().drafts[0].anchor.scrollKnown, true);
    assert.equal(controller.getState().drafts[0].anchor.scrollY, 420);
    assert.equal(h.all().some(n=>n.className==='af-location'||n.className==='af-anchor'),false,'location stays in the protocol, not dialog chrome');
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('Chat displays a pre-inference blocker and retries only on an explicit click using the same ID', async () => {
  const h = fakeHost(), previous = new Map(), posts = [];
  let messages = [{ id, text: 'Explain this', status: 'blocked', error: 'Current original-thread delivery is unavailable.', mirrorStatus: 'pending' }];
  const fetchStub = async (path, options = {}) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); posts.push(body);
      messages = [{ id: body.id, text: body.text, status: 'queued', mirrorStatus: 'pending' }];
      return { status: 202, json: async () => messages[0] };
    }
    return { ok: true, status: 200, json: async () => path.endsWith('/chat') ? { enabled: true, messages } : { enabled: true, chatEnabled: true, batches: [] } };
  };
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    ui.initializeFeedback(h.root, h.frame); await flush(); await h.find('Chat').click(); await flush();
    assert.ok(h.all().some(n => n.textContent === messages[0].error));
    assert.ok(h.find('Retry reply')); assert.equal(posts.length, 0, 'status reads never retry');
    await h.find('Retry reply').click(); await flush();
    assert.deepEqual(posts, [{ csrf: h.root.dataset.csrf, id, text: 'Explain this', retry: true }]);
    assert.equal(h.find('Send message').disabled, true, 'a queued retry still blocks conflicting sends');
    messages = [{ ...messages[0], status: 'replied', reply: 'Done', mirrorStatus: 'uncertain' }];
    await h.find('Close chat').click(); await h.find('Chat').click(); await flush();
    assert.equal(h.find('Retry reply'), undefined, 'uncertain mirrors cannot be retried');
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('Chat polls a replied message until its queued original-thread mirror settles without blocking composition', async () => {
  const h = fakeHost(), previous = new Map(), timers = [];
  let messages = [{ id, text: 'Question', status: 'replied', reply: 'Answer', mirrorStatus: 'queued' }];
  const fetchStub = async path => ({ ok: true, status: 200, json: async () => path.endsWith('/chat') ? { enabled: true, messages } : { enabled: true, chatEnabled: true, batches: [] } });
  for (const [key, value] of Object.entries({ ...h.env, fetch: fetchStub, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {} })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    ui.initializeFeedback(h.root, h.frame); await flush(); await h.find('Chat').click(); await flush();
    assert.ok(timers.length, 'queued mirror must keep status polling alive');
    assert.equal(h.all().find(n => n.className === 'af-chat-compose').disabled, false);
    messages = [{ ...messages[0], mirrorStatus: 'delivered' }];
    await timers.at(-1)(); await flush();
    assert.ok(h.all().some(n => n.textContent === 'Reply shared with the original thread.'));
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('region image is generated silently and uploads only on explicit Send', async () => {
  const h=fakeHost(),previous=new Map(),posts=[];
  const fetchStub=async(path,options)=>{if(options.method==='POST'){const body=JSON.parse(options.body);posts.push({path,body});return {status:202,json:async()=>path.endsWith('/images')?{id:body.id,mimeType:'image/jpeg'}:{batchId:body.id,status:'queued'}};}return{ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})};};
  for(const [k,v]of Object.entries({...h.env,fetch:fetchStub})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try{
    const controller=ui.initializeFeedback(h.root,h.frame);await flush();
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);await h.find('Done selecting').click();
    const request=h.childMessages.find(x=>x.type==='clawtifact:render-region');assert.ok(request,'confirming a region automatically requests its current rendered pixels');
    const textarea=h.all().find(n=>n.tagName==='textarea');textarea.value='This app list is unclear';await textarea.emit('input');assert.equal(h.find('Add').disabled,true);
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:request.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    assert.equal(h.all().some(n=>n.className==='af-crop-dialog'&&!n.hidden),false,'auto-render does not open a mandatory preview');
    assert.equal(h.all().find(n=>n.className==='af-image-status').textContent,'','successful captures are silent');
    assert.equal(h.find('Attach screenshot'),undefined,'manual capture options are removed');
    await h.find('Add').click();assert.equal(controller.getState().drafts[0].image.source,'rendered');assert.equal(posts.length,0);
    await h.find('Submit feedback').click();await flush();assert.equal(posts.length,2);assert.match(posts[0].path,/\/images$/);assert.match(posts[1].path,/\/feedback$/);assert.equal(posts[1].body.comments[0].imageId,posts[0].body.id);
    assert.ok(![...h.storage.values()].some(v=>v.includes('/9j/2Q==')));
  }finally{h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('failed rendering is explicit and does not prevent a deliberate geometry-only comment',async()=>{
 const h=fakeHost(),previous=new Map();for(const[k,v]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})})})){previous.set(k,globalThis[k]);globalThis[k]=v;}
 try{const controller=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});await beginSelection(h);await h.find('Done selecting').click();const req=h.childMessages.find(x=>x.type==='clawtifact:render-region');assert.ok(req);h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:false}});await flush();assert.match(h.all().find(n=>n.className==='af-image-status').textContent,/Image unavailable/);const textarea=h.all().find(n=>n.tagName==='textarea');textarea.value='No image; context still useful';await textarea.emit('input');await h.find('Add').click();assert.equal(controller.getState().drafts[0].image,undefined);assert.equal(controller.getState().drafts[0].imageUnavailable,true);assert.equal(h.find('Submit feedback').disabled,false);}finally{h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('deleting current selection clears its generated image and cancels any pending result',async()=>{
 const h=fakeHost(),previous=new Map();for(const[k,v]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})})})){previous.set(k,globalThis[k]);globalThis[k]=v;}
 try{const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});await beginSelection(h);await h.find('Done selecting').click();const req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();await h.find('Delete current selection').click();const text=h.all().find(n=>n.tagName==='textarea');text.value='Whole document';await text.emit('input');await h.find('Add').click();assert.equal(ctl.getState().drafts[0].anchor.type,'general');assert.equal(ctl.getState().drafts[0].image,undefined);}finally{h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});
test('a parent initialized after child load recovers viewport and requests an automatic image', async () => {
  const h = fakeHost(), previous = new Map(), childListeners = new Map();
  const origin = 'https://review.example.com';
  const parent = { postMessage(data) { h.emit('message', { source: h.frame.contentWindow, data }); } };
  const child = {
    window: { parent, scrollX: 0, scrollY: 320, innerWidth: 800, innerHeight: 600, addEventListener: (type, fn) => childListeners.set(type, fn) },
    document: { ...h.env.document, documentElement: h.env.document.createElement('html'), currentScript: { src: `${origin}/artifacts/assets/bridge.js` }, addEventListener() {} },
    URL, clearTimeout, setTimeout, requestAnimationFrame: fn => fn(),
  };
  // Both real child reports happen before any parent listener is installed.
  runInNewContext(await readFile(new URL('../web/bridge.js', import.meta.url), 'utf8'), child);
  childListeners.get('load')();
  h.frame.contentWindow.postMessage = data => {
    h.childMessages.push(data);
    childListeners.get('message')({ source: parent, origin, data });
  };
  for (const [k, v] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, imagesEnabled: true, batches: [] }) }) })) { previous.set(k, globalThis[k]); globalThis[k] = v; }
  try {
    ui.initializeFeedback(h.root, h.frame); await flush();
    await beginSelection(h); await h.find('Done selecting').click();
    const request = h.childMessages.find(m => m.type === 'clawtifact:render-region');
    assert.ok(request, 'late parent must recover child viewport before automatic rendering');
    assert.equal(request.anchor.scrollKnown, true);
    assert.equal(request.anchor.scrollY, 320);
    h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:region-image', requestId: request.requestId, ok: true, dataUrl: 'data:image/jpeg;base64,/9j/2Q==' } });
    await flush();
    const textarea = h.all().find(n => n.tagName === 'textarea');
    textarea.value = 'Keep this box on the document'; await textarea.emit('input');
    await h.find('Add').click();
    const childLayer=child.document.documentElement.children[0];
    assert.ok(childLayer, 'decorations render inside the scrolling child');
    const originalTop=childLayer.shadow.children[0].style.top;
    assert.equal(originalTop, '470px');
    const before=h.childMessages.filter(m=>m.type==='clawtifact:draft-markers').length;
    child.window.scrollY = 420; childListeners.get('scroll')();
    assert.equal(childLayer.shadow.children[0].style.top,originalTop,'browser scroll moves the document rectangle; JS does not reposition it');
    assert.equal(h.childMessages.filter(m=>m.type==='clawtifact:draft-markers').length,before,'no scroll-message roundtrip drives rectangle position');
  } finally { h.emit('pagehide'); for (const [k,v] of previous) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; } }
});

test('viewport replay only responds to the exact parent and host origin', async () => {
  const sent = [], listeners = new Map(), parent = { postMessage: (...args) => sent.push(args) };
  runInNewContext(await readFile(new URL('../web/bridge.js', import.meta.url), 'utf8'), {
    window: { parent, scrollX: 10, scrollY: 20, innerWidth: 800, innerHeight: 600, addEventListener: (type, fn) => listeners.set(type, fn) },
    document: { currentScript: { src: 'https://review.example.com/artifacts/assets/bridge.js' }, addEventListener() {} },
    URL, clearTimeout, setTimeout, requestAnimationFrame: fn => fn(),
  });
  sent.length = 0;
  const data = { type: 'clawtifact:request-viewport' };
  listeners.get('message')({ source: {}, origin: 'https://review.example.com', data });
  listeners.get('message')({ source: parent, origin: 'https://other.example.com', data });
  assert.equal(sent.length, 0);
  listeners.get('message')({ source: parent, origin: 'https://review.example.com', data });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].scrollY, 20);
  assert.equal(sent[0][1], 'https://review.example.com');
});

test('selection visibly refuses unknown viewport until a validated child report arrives', async () => {
  const h = fakeHost(), previous = new Map();
  for (const [k,v] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(k,globalThis[k]); globalThis[k]=v; }
  try {
    const controller = ui.initializeFeedback(h.root,h.frame); await flush();
    await beginSelection(h);
    assert.equal(h.all().some(n => n.className === 'af-region-selector'), false);
    assert.ok(h.all().some(n => /Scroll position unavailable.*try selecting again/.test(n.textContent || '')));
    assert.equal(h.childMessages.filter(m => m.type === 'clawtifact:request-viewport').length, 2);
    assert.equal(controller.getState().drafts.length, 0);
    h.emit('message', { source:h.frame.contentWindow, data:{ type:'clawtifact:viewport',scrollX:0,scrollY:200,viewportWidth:800,viewportHeight:600 } });
    await beginSelection(h);
    assert.equal(h.all().some(n => n.className === 'af-region-selector'), true);
  } finally { h.emit('pagehide'); for (const [k,v] of previous) { if (v===undefined) delete globalThis[k]; else globalThis[k]=v; } }
});

test('smart selector clicks snap to correlated element hints without modes or a visible toolbar', async () => {
  const h=fakeHost(),previous=new Map();
  for(const[key,value]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,batches:[]})})})){previous.set(key,globalThis[key]);globalThis[key]=value;}
  try{
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await h.find('Selector').click();const layer=h.all().find(n=>n.className==='af-region-selector');
    assert.equal(h.all().some(n=>n.className==='af-region-hint'),false,'no top overlay');
    await layer.emit('pointerdown',{button:0,clientX:120,clientY:90,pointerId:1});await layer.emit('pointerup',{clientX:120,clientY:90,pointerId:1});
    const req=h.childMessages.find(n=>n.type==='clawtifact:hit-test');assert.ok(req,'click requests the exact element under the pointer');
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:hit-result',requestId:req.requestId,anchor:{type:'region',x:.1,y:.1,width:.2,height:.2,scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600,scrollKnown:true}}});await flush();
    assert.equal(h.all().includes(layer),false,'pointer selection opens the real comment composer without Done');
    const textarea=h.all().find(n=>n.tagName==='textarea');textarea.value='Real selected element';await textarea.emit('input');await h.find('Add').click();
    assert.equal(ctl.getState().drafts[0].anchor.x,.1);
  }finally{h.emit('pagehide');for(const[key,value]of previous){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('exiting or changing viewport invalidates in-flight element replies without adding a comment', async () => {
  const h=fakeHost(),previous=new Map();
  for(const[key,value]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,batches:[]})})})){previous.set(key,globalThis[key]);globalThis[key]=value;}
  try{
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();
    const report=y=>h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:y,viewportWidth:800,viewportHeight:600}});
    report(0);await h.find('Selector').click();const layer=h.all().find(n=>n.className==='af-region-selector');
    await layer.emit('pointerdown',{button:0,clientX:120,clientY:90,pointerId:1});await layer.emit('pointerup',{clientX:120,clientY:90,pointerId:1});
    const req=h.childMessages.find(n=>n.type==='clawtifact:hit-test');report(200);
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:hit-result',requestId:req.requestId,anchor:{type:'region',x:.1,y:.1,width:.2,height:.2,scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600,scrollKnown:true}}});await flush();
    assert.equal(h.all().includes(layer),false);const textarea=h.all().find(n=>n.tagName==='textarea');textarea.value='General after cancelled selection';await textarea.emit('input');await h.find('Add').click();assert.equal(ctl.getState().drafts[0].anchor.type,'general');
    await h.find('Feedback').click();assert.equal(h.find('Feedback').dataset.open,'false');
    await h.find('Feedback').click();const menu=h.all().find(n=>n.className==='af-menu');assert.equal(menu.inert,false);await h.find('Feedback').click();assert.equal(menu.inert,true);assert.equal(menu.attributes['aria-hidden'],'true');
  }finally{h.emit('pagehide');for(const[key,value]of previous){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('pointer motion cannot supersede a pending click hit-test', async () => {
  const h=fakeHost(),previous=new Map();
  for(const[key,value]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,batches:[]})})})){previous.set(key,globalThis[key]);globalThis[key]=value;}
  try{
    ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await h.find('Selector').click();const layer=h.all().find(n=>n.className==='af-region-selector');
    await layer.emit('pointerdown',{button:0,clientX:120,clientY:90,pointerId:1});await layer.emit('pointerup',{clientX:120,clientY:90,pointerId:1});
    const req=h.childMessages.find(n=>n.type==='clawtifact:hit-test');await layer.emit('pointermove',{clientX:121,clientY:91,pointerId:1});
    assert.equal(h.childMessages.filter(n=>n.type==='clawtifact:hit-test').length,1,'hover must not cancel a click request');
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:hit-result',requestId:req.requestId,anchor:{type:'region',x:.1,y:.1,width:.2,height:.2,scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600,scrollKnown:true}}});await flush();
    assert.equal(h.all().includes(layer),false);
  }finally{h.emit('pagehide');for(const[key,value]of previous){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('floating exit remains above the selection surface but below image crop dialogs', async () => {
  const css=await readFile(new URL('../web/feedback.css',import.meta.url),'utf8');
  const zIndex=selector=>[...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(m=>m[1].split(',').some(s=>s.trim()===selector)&&/z-index\s*:\s*\d+/.test(m[2])).map(m=>Number(m[2].match(/z-index\s*:\s*(\d+)/)[1])).at(-1);
  const fab=zIndex('#artifact-feedback .af-fab[data-selecting=true]'), surface=zIndex('#artifact-feedback .af-region-selector'), modal=zIndex('#artifact-feedback .af-crop-dialog');
  assert.ok(zIndex('#artifact-feedback .af-fab')<zIndex('#artifact-feedback .af-panel'),'normal FAB must not cover mobile panel send buttons');
  assert.ok(fab>surface,'selection surface must not intercept clicks on the exit FAB');assert.ok(fab<modal,'a modal crop still blocks background actions');
});

test('compact feedback switches from a bottom-left composer to a pre-send draft tray without sending', async () => {
  const h=fakeHost(),previous=new Map(),posts=[];
  for(const[key,value]of Object.entries({...h.env,fetch:async(_p,options)=>{if(options.method==='POST'){posts.push(JSON.parse(options.body));return {status:202,json:async()=>({batchId:posts[0].id,status:'queued'})};}return {ok:true,status:200,json:async()=>({enabled:true,batches:[]})};}})){previous.set(key,globalThis[key]);globalThis[key]=value;}
  try{
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);await h.find('Done selecting').click();
    const panel=h.all().find(n=>n.className==='af-panel'),editor=h.all().find(n=>n.className==='af-comment-editor'),tray=h.all().find(n=>n.className==='af-draft-tray');
    assert.equal(panel.dataset.kind,'feedback');assert.ok(editor);assert.ok(tray);assert.equal(panel.dataset.mode,'compose');assert.equal(editor.hidden,false);assert.equal(tray.hidden,true);
    const more=h.all().find(n=>n.tagName==='details'&&n.className==='af-feedback-more');assert.equal(more,undefined,'the compact card has no extra-options menu');
    const text=h.all().find(n=>n.tagName==='textarea');text.value='First compact draft';await text.emit('input');await h.find('Add').click();
    assert.equal(posts.length,0);assert.equal(panel.dataset.mode,'drafts');assert.equal(editor.hidden,true);assert.equal(tray.hidden,false);assert.equal(ctl.getState().drafts.length,1);
    await h.find('Close').click();await h.find('Feedback').click();await h.find('Selector').click();
    assert.equal(panel.hidden,false,'reopening feedback must show retained drafts');assert.equal(h.all().some(n=>n.className==='af-region-selector'),false);
    await h.find('Add another').click();await h.find('Done selecting').click();await h.find('Close').click();await h.find('Feedback').click();await h.find('Selector').click();assert.equal(panel.dataset.mode,'compose','unsaved selection survives closing and reopening');assert.equal(h.all().some(n=>n.className==='af-region-selector'),false);await h.find('Delete current selection').click();assert.equal(ctl.getState().drafts.length,1);
    assert.equal(h.find('Edit'),undefined);assert.equal(h.find('Save changes'),undefined);
    assert.equal(ctl.getState().drafts.length,1);assert.equal(panel.dataset.mode,'drafts');assert.equal(posts.length,0);
    await h.find('Submit feedback').click();await flush();assert.equal(posts.length,1);assert.equal(ctl.getState().batch.status,'queued');assert.equal(ctl.getState().drafts.length,1);assert.equal(tray.hidden,false);assert.equal(h.find('Submit feedback').disabled,true);
  }finally{h.emit('pagehide');for(const[key,value]of previous){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});

test('minimal composer uses Add and silently retains automatic images; list actions are Delete only', async () => {
  const h=fakeHost(),previous=new Map(),posts=[];
  const fetchStub=async(path,options)=>{
    if(options.method==='POST'){const body=JSON.parse(options.body);posts.push({path,body});return {status:202,json:async()=>path.endsWith('/images')?{id:body.id,mimeType:'image/jpeg'}:{batchId:body.id,status:'queued'}};}
    return {ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})};
  };
  for(const[k,v]of Object.entries({...h.env,fetch:fetchStub})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try {
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);await h.find('Done selecting').click();
    assert.equal(h.all().some(n=>n.className==='af-location'),false,'no selection metadata in the composer');
    assert.ok(h.find('Add'),'the primary action is Add');assert.equal(h.find('Save draft'),undefined);
    const req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');assert.ok(req);
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    const imageStatus=h.all().find(n=>n.className==='af-image-status');assert.equal(imageStatus.textContent,'');assert.equal(imageStatus.hidden,true);
    const text=h.all().find(n=>n.tagName==='textarea');text.value='Keep this simple';await text.emit('input');await h.find('Add').click();
    assert.equal(ctl.getState().drafts[0].image.source,'rendered','removing metadata must not remove automatic image capture');
    assert.equal(h.all().some(n=>n.className==='af-draft-note'),false);
    const list=h.all().find(n=>n.className==='af-drafts');const buttons=node=>[...(node.tagName==='button'?[node]:[]),...node.children.filter(n=>n.children).flatMap(buttons)];
    assert.deepEqual(buttons(list).map(n=>n.textContent),['Delete']);
    assert.equal(h.find('Edit'),undefined);assert.equal(h.find('Adjust rectangle'),undefined);assert.equal(posts.length,0);
    await h.find('Submit feedback').click();await flush();assert.equal(posts.length,2);assert.equal(posts[1].body.comments[0].text,'Keep this simple');
    assert.equal(posts[1].body.comments[0].imageId,posts[0].body.id);assert.equal(h.find('Delete').disabled,true,'queued feedback is immutable and never blindly resent');
  } finally {h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('missing restored image blocks Send and deleting the comment allows a fresh replacement', async () => {
  const h=fakeHost(),previous=new Map();
  const oldAnchor={type:'region',x:.1,y:.1,width:.2,height:.2,scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600,scrollKnown:true};
  h.storage.set('clawtifact:feedback:artifact-test',JSON.stringify({drafts:[{text:'Old comment',anchor:oldAnchor,imageMissing:true}],batch:null}));
  for(const[k,v]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})})})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try {
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await h.find('Feedback').click();await h.find('Selector').click();assert.equal(h.find('Submit feedback').disabled,true);
    await h.find('Delete comment 1').click();assert.equal(ctl.getState().drafts.length,0);
    await h.find('Add another').click();await h.find('Done selecting').click();const req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');
    h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    const text=h.all().find(n=>n.tagName==='textarea');text.value='Replacement';await text.emit('input');await h.find('Add').click();
    assert.equal(ctl.getState().drafts.length,1);assert.equal(ctl.getState().drafts[0].imageMissing,undefined);assert.equal(ctl.getState().drafts[0].image.source,'rendered');assert.equal(h.find('Submit feedback').disabled,false);
  } finally {h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('current drag outline stays visible while composing and previous outlines remain during Add another', async () => {
  const h=fakeHost(),previous=new Map();
  for(const[k,v]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})})})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  const lastMarkers=()=>h.childMessages.findLast(m=>m.type==='clawtifact:draft-markers');
  try {
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);let layer=h.all().find(n=>n.className==='af-region-selector');
    await layer.emit('pointerdown',{button:0,clientX:80,clientY:60,pointerId:1});await layer.emit('pointerup',{clientX:240,clientY:180,pointerId:1});
    const text=h.all().find(n=>n.tagName==='textarea');assert.equal(text.focused,true);
    assert.equal(lastMarkers().visible,true);assert.equal(lastMarkers().markers.length,1,'the outline must not disappear until Add');
    assert.equal(lastMarkers().markers[0].anchor.x,.1);assert.equal(ctl.getState().drafts.length,0,'a visible outline is not an added comment');
    let req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    text.value='First';await text.emit('input');await h.find('Add').click();assert.equal(lastMarkers().markers.length,1,'adding must not duplicate the current outline');
    const start=h.childMessages.length;await h.find('Add another').click();
    assert.equal(lastMarkers().visible,true,'previous outlines remain while drawing the next region');
    assert.equal(h.childMessages.slice(start).some(m=>m.type==='clawtifact:draft-markers'&&m.visible===false),false,'do not briefly hide and restore earlier outlines');
    layer=h.all().find(n=>n.className==='af-region-selector');await layer.emit('pointerdown',{button:0,clientX:400,clientY:300,pointerId:2});await layer.emit('pointerup',{clientX:640,clientY:480,pointerId:2});
    assert.deepEqual(lastMarkers().markers.map(m=>m.number),[1,2]);assert.equal(ctl.getState().drafts.length,1);
    req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    await h.find('Delete current selection').click();assert.deepEqual(lastMarkers().markers.map(m=>m.number),[1],'deleting only the in-progress selection preserves previous comments');
    await h.find('Add another').click();await h.find('Cancel selection').click();assert.equal(lastMarkers().visible,true);assert.equal(lastMarkers().markers.length,1);
    await h.find('Close').click();assert.equal(lastMarkers().visible,false,'explicit close still hides feedback decorations');
  } finally {h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('Shift+Enter adds without sending, respects image readiness, and leaves normal Enter and IME alone', async () => {
  const h=fakeHost(),previous=new Map(),posts=[];
  for(const[k,v]of Object.entries({...h.env,fetch:async(_p,opts)=>{if(opts.method==='POST')posts.push(JSON.parse(opts.body));return {ok:true,status:200,json:async()=>({enabled:true,imagesEnabled:true,batches:[]})};}})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try {
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);await h.find('Done selecting').click();const text=h.all().find(n=>n.tagName==='textarea');text.value='Shortcut comment';await text.emit('input');
    let prevented=0;await text.emit('keydown',{key:'Enter',shiftKey:true,preventDefault(){prevented++;}});assert.equal(ctl.getState().drafts.length,0,'shortcut must not bypass pending image generation');
    const req=h.childMessages.findLast(m=>m.type==='clawtifact:render-region');h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:region-image',requestId:req.requestId,ok:true,dataUrl:'data:image/jpeg;base64,/9j/2Q=='}});await flush();
    prevented=0;for(const event of [{key:'Enter'},{key:'Enter',shiftKey:true,isComposing:true},{key:'Enter',shiftKey:true,repeat:true}])await text.emit('keydown',{...event,preventDefault(){prevented++;}});
    assert.equal(prevented,0);assert.equal(ctl.getState().drafts.length,0);
    await text.emit('keydown',{key:'Enter',shiftKey:true,preventDefault(){prevented++;}});assert.equal(prevented,1);assert.equal(ctl.getState().drafts.length,1);assert.equal(ctl.getState().drafts[0].text,'Shortcut comment');assert.equal(ctl.getState().drafts[0].image.source,'rendered');assert.equal(text.value,'');assert.equal(posts.length,0,'Shift+Enter is Add, not Submit');
  } finally {h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('selection capacity keeps current and saved decorations within the twenty-comment batch limit', async () => {
  const h=fakeHost(),previous=new Map();
  const anchor={type:'region',x:.1,y:.1,width:.2,height:.2,scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600,scrollKnown:true};
  h.storage.set('clawtifact:feedback:artifact-test',JSON.stringify({drafts:Array.from({length:19},(_,i)=>({text:`Comment ${i+1}`,anchor})),batch:null}));
  for(const[k,v]of Object.entries({...h.env,fetch:async()=>({ok:true,status:200,json:async()=>({enabled:true,batches:[]})})})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try {
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);await h.find('Done selecting').click();const text=h.all().find(n=>n.tagName==='textarea');text.value='Last comment';await text.emit('input');await h.find('Add').click();
    assert.equal(ctl.getState().drafts.length,20);assert.equal(h.find('Add another').disabled,true,'a full batch cannot start an invisible twenty-first outline');
    await h.find('Add another').click();assert.equal(h.all().some(n=>n.className==='af-region-selector'),false);
    assert.ok(h.childMessages.filter(m=>m.type==='clawtifact:draft-markers').every(m=>m.markers.length<=20));
  } finally {h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('agent-received status clears the submitted list without claiming Telegram delivery and permits a new batch',async()=>{
  const h=fakeHost(),previous=new Map(),posts=[];let received=false;
  const fetchStub=async(_p,options)=>{
    if(options.method==='POST'){const body=JSON.parse(options.body);posts.push(body);return{status:202,json:async()=>({batchId:body.id,status:'queued'})};}
    return{ok:true,status:200,json:async()=>({enabled:true,batches:received?[{batchId:posts[0].id,status:'received',deliveryStatus:'uncertain'}]:[]})};
  };
  for(const[k,v]of Object.entries({...h.env,fetch:fetchStub})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try{
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:viewport',scrollX:0,scrollY:0,viewportWidth:800,viewportHeight:600}});
    await beginSelection(h);await h.find('Done selecting').click();const text=h.all().find(n=>n.tagName==='textarea');text.value='First';await text.emit('input');await h.find('Add').click();await h.find('Submit feedback').click();await flush();
    received=true;await h.find('Close').click();await h.find('Feedback').click();await flush();
    assert.equal(ctl.getState().batch.status,'received');assert.equal(ctl.getState().drafts.length,0);assert.match(h.all().find(n=>n.className==='af-status').textContent,/Received by the agent/);assert.doesNotMatch(h.all().find(n=>n.className==='af-status').textContent,/delivered|failed/i);
    await h.find('Selector').click();
    assert.equal(ctl.getState().batch,null,'starting a selection retires the first batch receipt before Add');
    assert.equal(JSON.parse(h.storage.get('clawtifact:feedback:artifact-test')).batch,null,'the retired receipt cannot return after a reload');
    await h.find('Done selecting').click();
    assert.equal(h.all().find(n=>n.className==='af-status').textContent,'','new composer must not show the first acknowledgement');
    text.value='Second';await text.emit('input');await h.find('Add').click();assert.equal(ctl.getState().batch,null);assert.equal(ctl.getState().drafts.length,1);assert.equal(h.find('Submit feedback').disabled,false);assert.equal(posts.length,1);
    await h.find('Close').click();await h.find('Feedback').click();await h.find('Selector').click();await flush();
    assert.equal(ctl.getState().drafts[0].text,'Second','polling the old receipt cannot clear new drafts');
    assert.equal(ctl.getState().batch,null);
    await h.find('Submit feedback').click();await flush();
    assert.equal(posts.length,2);assert.notEqual(posts[1].id,posts[0].id);assert.deepEqual(posts[1].comments.map(c=>c.text),['Second']);
    assert.equal(ctl.getState().batch.id,posts[1].id);assert.equal(ctl.getState().batch.status,'queued');
    const afterRead={drafts:[],batch:{id,status:'received'}};assert.equal(ui.applyBatchStatus(afterRead,id,'failed'),afterRead,'late receipt failure cannot revoke a proven read');
  }finally{h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

for (const status of ['received','delivered']) for (const mode of ['text selection','general comment']) test(`starting ${mode} retires a restored ${status} receipt`,async()=>{
  const h=fakeHost(),previous=new Map(),posts=[];
  h.storage.set('clawtifact:feedback:artifact-test',JSON.stringify({drafts:[],batch:{id,status}}));
  for(const[k,v]of Object.entries({...h.env,fetch:async(_p,options)=>{if(options.method==='POST')posts.push(JSON.parse(options.body));return{ok:true,status:200,json:async()=>({enabled:true,batches:[{batchId:id,status}]})};}})){previous.set(k,globalThis[k]);globalThis[k]=v;}
  try{
    const ctl=ui.initializeFeedback(h.root,h.frame);await flush();
    if(mode==='text selection') h.emit('message',{source:h.frame.contentWindow,data:{type:'clawtifact:selection',anchor:{type:'text',quote:'New text',prefix:'',suffix:''}}});
    await h.find('Feedback').click();await h.find('Selector').click();await flush();
    if(mode==='text selection') {
      assert.equal(ctl.getState().batch,null,'selecting new text is a new review, not a receipt inspection');
      assert.equal(h.all().find(n=>n.className==='af-status').textContent,'');
    }
    const text=h.all().find(n=>n.tagName==='textarea');text.value='New comment';await text.emit('input');
    assert.equal(ctl.getState().batch,null);assert.equal(posts.length,0);
    assert.equal(JSON.parse(h.storage.get('clawtifact:feedback:artifact-test')).batch,null);
    assert.doesNotMatch(h.all().find(n=>n.className==='af-status').textContent,/Received|Thank you|Batch/);
  }finally{h.emit('pagehide');for(const[k,v]of previous){if(v===undefined)delete globalThis[k];else globalThis[k]=v;}}
});

test('live feedback pins unsaved composer, selections, drafts and submissions to its exact revision', async () => {
  const h = fakeHost(), previous = new Map(), posts = [];
  h.root.dataset.revisionId = 'a'.repeat(32); h.root.dataset.sequence = '1'; h.root.dataset.format = 'markdown';
  for (const [key, value] of Object.entries({ ...h.env, fetch: async (_p, options) => { if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push(body); return { status: 202, json: async () => ({ batchId: body.id, status: 'queued' }) }; } return { ok: true, status: 200, json: async () => ({ enabled: true, chatEnabled: true, batches: [] }) }; } })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame); await flush(); assert.equal(typeof ctl.isBusy, 'function'); assert.equal(ctl.isBusy(), false);
    const text = h.all().find(n => n.tagName === 'textarea'); text.value = 'Unsaved'; await text.emit('input'); assert.equal(ctl.isBusy(), true);
    assert.equal(JSON.parse(h.storage.get('clawtifact:feedback:artifact-test:' + 'a'.repeat(32))).composer, 'Unsaved');
    assert.equal(JSON.parse(h.storage.get('clawtifact:pin:feedback:artifact-test')).revisionId, 'a'.repeat(32));
    await h.find('Add').click(); assert.equal(ctl.getState().drafts.length, 1); assert.equal(ctl.isBusy(), true);
    await h.find('Submit feedback').click(); await flush(); assert.equal(posts[0].revisionId, 'a'.repeat(32));
    ctl.applySnapshot({ feedback: { enabled: true, batches: [{ batchId: posts[0].id, status: 'received' }] }, chat: { enabled: true, messages: [] } });
    assert.equal(ctl.getState().drafts.length, 0); assert.equal(ctl.isBusy(), false); assert.equal(h.storage.has('clawtifact:pin:feedback:artifact-test'), false);
    ctl.dispose(); const oldState = ctl.getState(); h.emit('message', { source: h.frame.contentWindow, data: { type: 'clawtifact:selection', anchor: { type: 'text', quote: 'stale', prefix: '', suffix: '' } } }); assert.equal(ctl.getState(), oldState); assert.equal(ctl.isBusy(), false);
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('live Chat receives canonical agent messages through snapshots and pins its composer without sending', async () => {
  const h = fakeHost(), previous = new Map(), posts = [];
  h.root.dataset.revisionId = 'b'.repeat(32); h.root.dataset.sequence = '2'; h.root.dataset.format = 'html';
  for (const [key, value] of Object.entries({ ...h.env, fetch: async (_p, options) => { if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push(body); return { status: 202, json: async () => ({ id: body.id, status: 'queued' }) }; } return { ok: true, status: 200, json: async () => ({ enabled: true, chatEnabled: true, batches: [], messages: [] }) }; } })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame); await flush(); assert.equal(typeof ctl.applySnapshot, 'function');
    ctl.applySnapshot({ feedback: { enabled: true, chatEnabled: true, batches: [] }, chat: { enabled: true, messages: [{ id, role: 'agent', text: 'Here is the pushed explanation.', status: 'replied', revisionId: 'a'.repeat(32) }] } });
    assert.ok(h.all().some(n => n.textContent === 'Here is the pushed explanation.')); assert.equal(posts.length, 0);
    assert.ok(h.find('View version'), 'old message carries compact version navigation');
    const composer = h.all().find(n => n.className === 'af-chat-compose'); composer.value = 'A version-specific question'; await composer.emit('input'); assert.equal(ctl.isBusy(), true);
    assert.equal(JSON.parse(h.storage.get('clawtifact:pin:chat:artifact-test')).revisionId, 'b'.repeat(32));
    await h.find('Send message').click(); await flush(); assert.equal(posts[0].revisionId, 'b'.repeat(32)); assert.equal(ctl.isBusy(), true);
    ctl.applySnapshot({ chat: { enabled: true, messages: [{ id: posts[0].id, text: posts[0].text, status: 'replied', reply: 'Answer', revisionId: 'b'.repeat(32) }] } }); assert.equal(ctl.isBusy(), false); ctl.dispose();
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('bridge activity proof distinguishes selection and editing and authenticates replay requests', async () => {
  const sent = [], listeners = new Map(), docListeners = new Map(), parent = { postMessage: (...args) => sent.push(args) }; let selected = false;
  const document = { activeElement: null, currentScript: { src: 'https://review.example.com/artifacts/assets/bridge.js' }, addEventListener: (type, fn) => docListeners.set(type, fn) };
  runInNewContext(await readFile(new URL('../web/bridge.js', import.meta.url), 'utf8'), {
    window: { parent, getSelection: () => ({ isCollapsed: !selected, rangeCount: selected ? 1 : 0 }), scrollX: 0, scrollY: 0, innerWidth: 800, innerHeight: 600, addEventListener: (type, fn) => listeners.set(type, fn) }, document, URL, clearTimeout, setTimeout, requestAnimationFrame: fn => fn(),
  });
  sent.length = 0; const data = { type: 'clawtifact:request-activity' }; listeners.get('message')({ source: {}, origin: 'https://review.example.com', data }); listeners.get('message')({ source: parent, origin: 'https://other.example.com', data }); assert.equal(sent.length, 0);
  listeners.get('message')({ source: parent, origin: 'https://review.example.com', data }); assert.equal(sent.at(-1)?.[0].idle, true);
  selected = true; listeners.get('message')({ source: parent, origin: 'https://review.example.com', data }); assert.equal(sent.at(-1)?.[0].idle, false);
  selected = false; document.activeElement = { matches: () => true }; listeners.get('message')({ source: parent, origin: 'https://review.example.com', data }); assert.equal(sent.at(-1)?.[0].idle, false);
});

test('disposing a feedback generation unregisters every window and frame listener', async () => {
  const h = fakeHost(), previous = new Map(), listeners = new Map();
  h.env.window.addEventListener = (type, fn) => listeners.set(type, [...listeners.get(type) || [], fn]);
  h.env.window.removeEventListener = (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
  h.frame.removeEventListener = (type, fn) => h.frame.listeners.set(type, (h.frame.listeners.get(type) || []).filter(item => item !== fn));
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try { const ctl = ui.initializeFeedback(h.root, h.frame); await flush(); ctl.dispose(); assert.equal([...listeners.values()].flat().length, 0); assert.equal([...h.frame.listeners.values()].flat().length, 0); } finally { for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('a late status read cannot overwrite newer SSE feedback and Chat state', async () => {
  const h = fakeHost(), previous = new Map(); let resolveRead;
  const read = new Promise(resolve => { resolveRead = resolve; });
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => read })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame);
    ctl.applySnapshot({ feedback: { enabled: true, chatEnabled: true, batches: [] }, chat: { enabled: true, messages: [{ id, role: 'agent', text: 'New authoritative note', status: 'replied' }] } });
    resolveRead({ ok: true, status: 200, json: async () => ({ enabled: false, chatEnabled: false, batches: [], messages: [] }) }); await flush();
    assert.equal(h.find('Chat').disabled, false); assert.ok(h.all().some(n => n.textContent === 'New authoritative note')); ctl.dispose();
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('reload restores current unsaved review under its original revision only', async () => {
  const h = fakeHost(), previous = new Map(); h.root.dataset.revisionId = 'd'.repeat(32); h.root.dataset.sequence = '4'; h.root.dataset.format = 'markdown';
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame); await flush(); const text = h.all().find(n => n.tagName === 'textarea'); text.value = 'Keep this unsaved comment'; await text.emit('input'); ctl.dispose();
    h.root.replaceChildren(); const restored = ui.initializeFeedback(h.root, h.frame); await flush(); assert.equal(h.all().find(n => n.tagName === 'textarea').value, 'Keep this unsaved comment'); assert.equal(restored.isBusy(), true); restored.dispose();
    h.root.dataset.revisionId = 'e'.repeat(32); h.root.replaceChildren(); const newer = ui.initializeFeedback(h.root, h.frame); await flush(); assert.equal(h.all().find(n => n.tagName === 'textarea').value, ''); assert.equal(newer.isBusy(), false); newer.dispose();
  } finally { h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

test('SSE reply before HTTP202 clears only the sent Chat composer and unpins the version', async () => {
  const h = fakeHost(), previous = new Map(); let resolvePost, posted, messages = [];
  const response = new Promise(resolve => { resolvePost = resolve; });
  h.root.dataset.revisionId = 'f'.repeat(32); h.root.dataset.sequence = '1'; h.root.dataset.format = 'markdown';
  for (const [key, value] of Object.entries({ ...h.env, fetch: async (path, options) => { if (options.method === 'POST') { posted = JSON.parse(options.body); return response; } return { ok: true, status: 200, json: async () => path.endsWith('/chat') ? { enabled: true, messages } : { enabled: true, chatEnabled: true, batches: [] } }; } })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try {
    const ctl = ui.initializeFeedback(h.root, h.frame); await flush(); const composer = h.all().find(n => n.className === 'af-chat-compose'); composer.value = 'Question sent once'; await composer.emit('input'); const sending = h.find('Send message').click(); await flush();
    messages = [{ id: posted.id, text: posted.text, status: 'replied', reply: 'Fast pushed answer', revisionId: h.root.dataset.revisionId }]; ctl.applySnapshot({ chat: { enabled: true, messages } });
    resolvePost({ status: 202, json: async () => ({ id: posted.id, status: 'queued' }) }); await sending; await flush(); assert.equal(composer.value, ''); assert.equal(ctl.isBusy(), false); assert.equal(h.find('Send message').disabled, true); ctl.dispose();
  } finally { resolvePost?.({ status: 202, json: async () => ({ id: posted?.id, status: 'queued' }) }); h.emit('pagehide'); for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});

for (const mode of ['discuss', 'revise']) test(`Chat explains ${mode} authority without granting external actions`, async () => {
  const h = fakeHost(), previous = new Map(); h.root.dataset.feedbackMode = mode;
  for (const [key, value] of Object.entries({ ...h.env, fetch: async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, batches: [] }) }) })) { previous.set(key, globalThis[key]); globalThis[key] = value; }
  try { const ctl = ui.initializeFeedback(h.root, h.frame); const help = h.all().find(n => n.className === 'af-help').textContent; if (mode === 'revise') { assert.match(help, /submitted suggestions.*document-only edits.*original agent/i); assert.match(help, /no external actions/i); } else assert.match(help, /cannot make changes or take actions/i); ctl.dispose(); } finally { for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});
