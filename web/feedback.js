const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['sending', 'queued', 'delivered', 'failed', 'uncertain']);
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export function normalizeAnchor(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'general') return { type: 'general' };
  if (value.type === 'text') {
    const { quote, prefix, suffix } = value;
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 2000 || typeof prefix !== 'string' || prefix.length > 200 || typeof suffix !== 'string' || suffix.length > 200) return null;
    return { type: 'text', quote, prefix, suffix };
  }
  if (value.type !== 'region') return null;
  const { x, y, width, height, scrollX, scrollY, viewportWidth, viewportHeight, scrollKnown = false } = value;
  if (typeof scrollKnown !== 'boolean') return null;
  if (!finite(x, 0, 1) || !finite(y, 0, 1) || !finite(width, Number.MIN_VALUE, 1) || !finite(height, Number.MIN_VALUE, 1) || x + width > 1 + 1e-6 || y + height > 1 + 1e-6 || !finite(scrollX, 0, 1e7) || !finite(scrollY, 0, 1e7) || !finite(viewportWidth, 1, 1e5) || !finite(viewportHeight, 1, 1e5)) return null;
  return { type: 'region', x, y, width, height, scrollX, scrollY, viewportWidth, viewportHeight, scrollKnown };
}
export function parseBridgeMessage(event, childWindow) {
  if (!childWindow || event.source !== childWindow || !event.data || typeof event.data !== 'object') return null;
  const data = event.data;
  if (data.type === 'clawtifact:selection') {
    const anchor = normalizeAnchor(data.anchor);
    return anchor?.type === 'text' ? { type: 'selection', anchor } : null;
  }
  if (data.type === 'clawtifact:viewport') {
    const { scrollX, scrollY, viewportWidth, viewportHeight } = data;
    if (finite(scrollX, 0, 1e7) && finite(scrollY, 0, 1e7) && finite(viewportWidth, 1, 1e5) && finite(viewportHeight, 1, 1e5)) return { type: 'viewport', scrollX, scrollY, viewportWidth, viewportHeight };
  }
  return null;
}
export function regionFromPoints(start, end, rect, viewport) {
  const clamp = (n, max) => Math.min(max, Math.max(0, n));
  const x1 = clamp(start.x, rect.width), x2 = clamp(end.x, rect.width);
  const y1 = clamp(start.y, rect.height), y2 = clamp(end.y, rect.height);
  return normalizeAnchor({ type: 'region', x: Math.min(x1, x2) / rect.width, y: Math.min(y1, y2) / rect.height, width: Math.abs(x2 - x1) / rect.width, height: Math.abs(y2 - y1) / rect.height, ...viewport });
}
export function createBatch(id, csrf, comments) {
  if (!UUID.test(id) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !Array.isArray(comments) || !comments.length || comments.length > 20) throw new Error('Add 1–20 comments before sending.');
  const clean = comments.map(c => {
    const anchor = normalizeAnchor(c?.anchor);
    if (typeof c?.text !== 'string' || !c.text.trim() || c.text.length > 1000 || !anchor) throw new Error('Each comment needs text (up to 1,000 characters) and a valid location.');
    return { text: c.text, anchor };
  });
  const batch = { id, csrf, comments: clean };
  if (new TextEncoder().encode(JSON.stringify(batch)).byteLength > 32768) throw new Error('Feedback is too large. Shorten the comments or selected quotes.');
  return batch;
}
export function applyBatchStatus(state, id, status) {
  if (state.batch?.id !== id || !STATUSES.has(status)) return state;
  return { ...state, drafts: status === 'delivered' ? [] : state.drafts, batch: { id, status } };
}
export function restoreDrafts(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.drafts) || parsed.drafts.length > 20) throw new Error();
    const drafts = parsed.drafts.map(c => {
      const anchor = normalizeAnchor(c?.anchor);
      if (!anchor || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 1000) throw new Error();
      return { text: c.text, anchor };
    });
    let batch = null;
    if (parsed.batch && UUID.test(parsed.batch.id) && STATUSES.has(parsed.batch.status)) batch = { id: parsed.batch.id, status: parsed.batch.status === 'sending' ? 'uncertain' : parsed.batch.status };
    return { drafts: batch?.status === 'delivered' ? [] : drafts, batch };
  } catch { return { drafts: [], batch: null }; }
}

export function initializeFeedback(root, frame) {
  const endpoint = `${root.dataset.path}/feedback`;
  const storageKey = `clawtifact:feedback:${root.dataset.artifactId}`;
  let state = { drafts: [], batch: null };
  try { state = restoreDrafts(sessionStorage.getItem(storageKey)); } catch { /* Storage is optional. */ }
  let enabled = root.dataset.enabled === 'true';
  let candidate = null, anchor = { type: 'general' }, editing = -1, viewport = null, pollCount = 0, pollTimer = null, checking = false;
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; };
  const button = (text, action, className = '') => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', action); return b; };
  const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Continue without persistence. */ } };
  const locked = () => state.batch && state.batch.status !== 'delivered';
  const fab = button('Feedback', () => openPanel()); fab.className = 'af-fab'; fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-controls', 'af-panel');
  const badge = el('span', 'af-badge'); fab.append(badge);
  const panel = el('section', 'af-panel'); panel.id = 'af-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'af-title');
  const heading = el('div', 'af-heading'); const title = el('h2', '', 'Artifact feedback'); title.id = 'af-title';
  heading.append(title, button('Close', () => closePanel(), 'af-close'));
  const help = el('p', 'af-help', 'Discuss this artifact with its author. Sending feedback does not automatically revise it.');
  const status = el('p', 'af-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const list = el('ol', 'af-drafts'); list.setAttribute('aria-label', 'Draft comments');
  const tools = el('div', 'af-tools');
  const generalButton = button('General comment', () => { anchor = { type: 'general' }; updateAnchor(); composer.focus(); });
  const selectionButton = button('Use selected text', () => { if (candidate) { anchor = candidate; updateAnchor(); composer.focus(); } });
  const regionButton = button('Select region', () => selectRegion()); tools.append(generalButton, selectionButton, regionButton);
  const location = el('p', 'af-location');
  const label = el('label', '', 'Your comment'); label.htmlFor = 'af-comment';
  const composer = el('textarea'); composer.id = 'af-comment'; composer.maxLength = 1000; composer.rows = 3; composer.placeholder = 'What would you like to discuss?';
  const count = el('span', 'af-count', '0 / 1,000');
  composer.addEventListener('input', () => { count.textContent = `${composer.value.length} / 1,000`; updateControls(); });
  const add = button('Add comment', () => {
    const text = composer.value.trim();
    if (!enabled || locked() || !text || !normalizeAnchor(anchor)) return;
    if (editing < 0 && state.drafts.length >= 20) { status.textContent = 'You can send up to 20 comments per batch.'; return; }
    if (state.batch?.status === 'delivered') state.batch = null;
    const c = { text, anchor };
    if (editing >= 0) state.drafts[editing] = c; else state.drafts.push(c);
    resetComposer(); persist(); render();
  });
  const cancelEdit = button('Cancel edit', () => { resetComposer(); render(); }); cancelEdit.hidden = true;
  const composeActions = el('div', 'af-actions'); composeActions.append(add, cancelEdit, count);
  const send = button('Send feedback', () => sendFeedback(), 'af-send');
  const actions = el('div', 'af-actions'); actions.append(send);
  panel.append(heading, help, status, list, tools, location, label, composer, composeActions, actions);
  root.append(fab, panel);
  function updateAnchor() {
    location.textContent = anchor.type === 'text' ? `Selected text: “${anchor.quote}”` : anchor.type === 'region' ? (anchor.scrollKnown ? 'Selected region' : 'Viewport region (scroll position unavailable)') : 'Whole artifact';
    updateControls();
  }
  function resetComposer() { composer.value = ''; editing = -1; anchor = { type: 'general' }; count.textContent = '0 / 1,000'; updateAnchor(); }
  function updateControls() {
    const blocked = !enabled || Boolean(locked());
    for (const control of [composer, generalButton, regionButton]) control.disabled = blocked;
    selectionButton.disabled = blocked || !candidate;
    add.disabled = blocked || !composer.value.trim() || (editing < 0 && state.drafts.length >= 20);
    add.textContent = editing < 0 ? 'Add comment' : 'Save comment'; cancelEdit.hidden = editing < 0;
    send.disabled = blocked || !state.drafts.length || Boolean(composer.value.trim());
    send.title = composer.value.trim() ? 'Add or clear the current comment first.' : '';
  }
  function render() {
    badge.textContent = String(state.drafts.length); badge.hidden = !state.drafts.length;
    list.replaceChildren();
    state.drafts.forEach((c, index) => {
      // '*' is required for this exact opaque-origin child. No credentials or comment text are sent.
      const item = el('li'); const focus = button(c.anchor.type === 'text' ? `“${c.anchor.quote}”` : c.anchor.type === 'region' ? (c.anchor.scrollKnown ? 'Selected region' : 'Viewport region (scroll position unavailable)') : 'Whole artifact', () => frame.contentWindow?.postMessage({ type: 'clawtifact:highlight', anchor: c.anchor }, '*'), 'af-anchor');
      focus.title = 'Focus annotation location'; const text = el('p', 'af-comment-text', c.text);
      const edit = button('Edit', () => { editing = index; composer.value = c.text; anchor = c.anchor; count.textContent = `${c.text.length} / 1,000`; updateAnchor(); composer.focus(); });
      const remove = button('Delete', () => { state.drafts.splice(index, 1); resetComposer(); persist(); render(); });
      edit.disabled = remove.disabled = !enabled || Boolean(locked());
      const row = el('div', 'af-actions'); row.append(edit, remove); item.append(focus, text, row); list.append(item);
    });
    const messages = { sending: 'Sending… Drafts are retained until delivery is confirmed.', queued: 'Queued — delivery is not yet confirmed. Drafts are retained.', delivered: 'Feedback delivered. Thank you.', failed: 'Delivery failed. Drafts and the batch ID are retained; this batch will not be sent again automatically.', uncertain: 'Delivery is unconfirmed. Drafts and the batch ID are retained. Do not send a duplicate batch.' };
    status.textContent = !enabled ? 'Feedback is unavailable or this artifact has expired. Ask for a fresh artifact to restore feedback. Your saved drafts remain here.' : messages[state.batch?.status] || 'Select text in the artifact, choose a region, or add a general comment.';
    if (state.batch) { const reference = el('small', 'af-reference', `Batch ${state.batch.id}`); status.append(document.createTextNode(' '), reference); }
    updateAnchor();
  }
  function openPanel() { panel.hidden = false; fab.setAttribute('aria-expanded', 'true'); composer.focus(); checkStatus(); }
  function closePanel() { panel.hidden = true; fab.setAttribute('aria-expanded', 'false'); fab.focus(); }
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closePanel(); } });
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function schedulePoll() {
    stopPolling();
    if (enabled && state.batch?.status === 'queued' && pollCount < 12) pollTimer = setTimeout(() => { pollCount++; checkStatus(); }, 2500);
  }
  async function checkStatus() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (response.status === 404 || response.status === 503) { enabled = false; stopPolling(); render(); return; }
      if (!response.ok) return;
      const data = await response.json();
      if (typeof data.enabled !== 'boolean' || !Array.isArray(data.batches)) return;
      enabled = data.enabled;
      const batch = data.batches.find(b => b?.batchId === state.batch?.id);
      if (batch && STATUSES.has(batch.status) && batch.status !== 'sending') state = applyBatchStatus(state, batch.batchId, batch.status);
      if (!enabled) stopPolling(); persist(); render();
    } catch { /* A read failure does not imply delivery or justify another send. */ }
    finally { checking = false; schedulePoll(); }
  }
  async function sendFeedback() {
    if (!enabled || locked() || !state.drafts.length || composer.value.trim()) return;
    let body;
    try { body = createBatch(crypto.randomUUID(), root.dataset.csrf, state.drafts); }
    catch (error) { status.textContent = error.message; return; }
    state.batch = { id: body.id, status: 'sending' }; persist(); render(); pollCount = 0;
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (response.status === 404 || response.status === 503) enabled = false;
      if (response.status !== 202) { state = applyBatchStatus(state, body.id, response.status >= 400 && response.status < 500 ? 'failed' : 'uncertain'); }
      else {
        const data = await response.json();
        state = applyBatchStatus(state, body.id, data.batchId === body.id && ['queued', 'delivered', 'failed', 'uncertain'].includes(data.status) ? data.status : 'uncertain');
      }
    } catch { state = applyBatchStatus(state, body.id, 'uncertain'); }
    persist(); render(); schedulePoll();
  }
  window.addEventListener('message', event => {
    const message = parseBridgeMessage(event, frame.contentWindow);
    if (message?.type === 'selection') { candidate = message.anchor; updateControls(); }
    else if (message?.type === 'viewport') viewport = message;
  });
  function selectRegion() {
    if (!enabled || locked()) return;
    const rect = frame.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return;
    panel.hidden = true;
    const layer = el('div', 'af-region-selector'); layer.tabIndex = 0; layer.setAttribute('role', 'group'); layer.setAttribute('aria-label', 'Select region. Drag, or use arrow keys to move, Shift plus arrows to resize. Enter confirms. Escape cancels.');
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const instruction = el('span', 'af-region-hint', 'Drag a region · Arrow keys move · Shift + arrows resize · Enter confirms · Esc cancels');
    const box = el('div', 'af-region-box'); layer.append(box, instruction); root.append(layer);
    let start = { x: rect.width * .25, y: rect.height * .25 }, end = { x: rect.width * .75, y: rect.height * .75 }, dragging = false;
    const capturedViewport = viewport ? { scrollX: viewport.scrollX, scrollY: viewport.scrollY, viewportWidth: viewport.viewportWidth, viewportHeight: viewport.viewportHeight, scrollKnown: true } : { scrollX: 0, scrollY: 0, viewportWidth: rect.width, viewportHeight: rect.height, scrollKnown: false };
    const paint = () => Object.assign(box.style, { left: `${Math.min(start.x, end.x)}px`, top: `${Math.min(start.y, end.y)}px`, width: `${Math.abs(start.x - end.x)}px`, height: `${Math.abs(start.y - end.y)}px` });
    const finish = accept => {
      const region = regionFromPoints(start, end, rect, capturedViewport);
      layer.remove(); panel.hidden = false;
      if (accept && region) { anchor = region; updateAnchor(); }
      composer.focus();
    };
    layer.addEventListener('pointerdown', event => { if (event.button !== 0) return; event.preventDefault(); dragging = true; start = end = { x: event.clientX - rect.left, y: event.clientY - rect.top }; layer.setPointerCapture(event.pointerId); paint(); });
    layer.addEventListener('pointermove', event => { if (!dragging) return; end = { x: event.clientX - rect.left, y: event.clientY - rect.top }; paint(); });
    layer.addEventListener('pointerup', event => { if (!dragging) return; dragging = false; end = { x: event.clientX - rect.left, y: event.clientY - rect.top }; finish(true); });
    layer.addEventListener('pointercancel', () => finish(false));
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); finish(event.key === 'Enter'); return; }
      const delta = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[event.key];
      if (!delta) return; event.preventDefault();
      if (event.shiftKey) { end = { x: Math.min(rect.width, Math.max(start.x + 4, end.x + delta[0])), y: Math.min(rect.height, Math.max(start.y + 4, end.y + delta[1])) }; }
      else { const dx = Math.min(rect.width - Math.max(start.x, end.x), Math.max(-Math.min(start.x, end.x), delta[0])); const dy = Math.min(rect.height - Math.max(start.y, end.y), Math.max(-Math.min(start.y, end.y), delta[1])); start = { x: start.x + dx, y: start.y + dy }; end = { x: end.x + dx, y: end.y + dy }; }
      paint();
    });
    paint(); layer.focus();
  }
  render(); checkStatus();
  window.addEventListener('pagehide', stopPolling);
  return { getState: () => state };
}
if (typeof document !== 'undefined') {
  const root = document.getElementById('artifact-feedback'), frame = document.getElementById('artifact-content');
  if (root && frame) initializeFeedback(root, frame);
}
