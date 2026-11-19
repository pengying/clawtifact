import { createElementPicker } from './element-picker.js';
import { initializeChat } from './chat.js';
import { createLiveViewer } from './live.js';
import { createRegionRenderer } from './region-renderer.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_ID = /^[a-f0-9]{32}$/;
const STATUSES = new Set(['sending', 'queued', 'received', 'delivered', 'failed', 'uncertain']);
const acknowledged = status => status === 'received' || status === 'delivered';
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
  if (!UUID.test(id) || typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !Array.isArray(comments) || !comments.length || comments.length > 20) throw new Error('Add 1–20 comments before submitting.');
  const clean = comments.map(c => {
    const anchor = normalizeAnchor(c?.anchor);
    if (typeof c?.text !== 'string' || !c.text.trim() || c.text.length > 1000 || !anchor) throw new Error('Each comment needs text (up to 1,000 characters) and a valid location.');
    if (c.imageMissing) throw new Error('Delete the comment with a missing image and select again before submitting.');
    if (c.imageId !== undefined && (typeof c.imageId !== 'string' || !IMAGE_ID.test(c.imageId))) throw new Error('Invalid screenshot reference.');
    return { text: c.text, anchor, ...(c.imageId ? { imageId: c.imageId } : {}) };
  });
  const batch = { id, csrf, comments: clean };
  if (new TextEncoder().encode(JSON.stringify(batch)).byteLength > 32768) throw new Error('Feedback is too large. Shorten the comments or selected quotes.');
  return batch;
}
export function applyBatchStatus(state, id, status) {
  if (state.batch?.id !== id || !STATUSES.has(status)) return state;
  if (state.batch.status === 'delivered' || (state.batch.status === 'received' && status !== 'delivered')) return state;
  return { ...state, drafts: acknowledged(status) ? [] : state.drafts, batch: { id, status } };
}
export function restoreDrafts(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.drafts) || parsed.drafts.length > 20) throw new Error();
    const drafts = parsed.drafts.map(c => {
      const anchor = normalizeAnchor(c?.anchor);
      if (!anchor || typeof c.text !== 'string' || !c.text.trim() || c.text.length > 1000) throw new Error();
      if (c.imageId !== undefined && (typeof c.imageId !== 'string' || !IMAGE_ID.test(c.imageId))) throw new Error();
      if (c.imageMissing !== undefined && typeof c.imageMissing !== 'boolean') throw new Error();
      return { text: c.text, anchor, ...(c.imageId ? { imageId: c.imageId } : {}), ...(c.imageMissing ? { imageMissing: true } : {}), ...(c.imageUnavailable === true ? { imageUnavailable: true } : {}) };
    });
    let batch = null;
    if (parsed.batch && UUID.test(parsed.batch.id) && STATUSES.has(parsed.batch.status)) batch = { id: parsed.batch.id, status: parsed.batch.status === 'sending' ? 'uncertain' : parsed.batch.status };
    return { drafts: batch?.status === 'delivered' ? [] : drafts, batch };
  } catch { return { drafts: [], batch: null }; }
}

export function initializeFeedback(root, frame, { onStateChange = () => {}, onViewRevision = () => {} } = {}) {
  const revisionId = root.dataset.revisionId;
  const revision = { revisionId, sequence: Number(root.dataset.sequence), format: root.dataset.format };
  const pinKey = `clawtifact:pin:feedback:${root.dataset.artifactId}`;
  let disposed = false, snapshotGeneration = 0; const removers = [];
  const listen = (target, type, fn) => { const safe = event => { if (!disposed) return fn(event); }; target.addEventListener(type, safe); removers.push(() => target.removeEventListener?.(type, safe)); };
  const endpoint = `${root.dataset.path}/feedback`;
  const storageKey = `clawtifact:feedback:${root.dataset.artifactId}${revisionId ? ':' + revisionId : ''}`;
  let state = { drafts: [], batch: null };
  let saved = {};
  try { const raw = sessionStorage.getItem(storageKey); state = restoreDrafts(raw); saved = JSON.parse(raw || '{}'); } catch { /* Storage is optional. */ }
  let enabled = root.dataset.enabled === 'true', imagesEnabled = false, chatEnabled = false, preparing = false, draftImage = null;
  let rendering = false, captureToken = 0, draftImageUnavailable = false, selectionUnavailable = false;
  const regionRenderer = createRegionRenderer(frame);
  const elementPicker = createElementPicker(frame);
  let menuOpen = false, chatOpen = false, composeMode = true;
  let candidate = normalizeAnchor(saved.candidate), anchor = normalizeAnchor(saved.anchor) || { type: 'general' }, viewport = null, pollCount = 0, pollTimer = null, checking = false, cancelRegion = null, markerSignature = '';
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text) n.textContent = text; return n; };
  const button = (text, action, className = '') => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', action); return b; };
  const persist = () => { try {
    const drafts = state.drafts.map(({ image, ...comment }) => ({ ...comment, ...(image && !comment.imageId ? { imageMissing: true } : {}) }));
    sessionStorage.setItem(storageKey, JSON.stringify({ ...state, drafts, composer: composer.value, anchor, candidate, currentImageMissing: Boolean(draftImage || draftImageUnavailable) }));
    if (revisionId) { if (feedbackBusy()) sessionStorage.setItem(pinKey, JSON.stringify(revision)); else if (JSON.parse(sessionStorage.getItem(pinKey) || 'null')?.revisionId === revisionId) sessionStorage.removeItem?.(pinKey); }
  } catch { /* Continue without persistence. */ } onStateChange(); };
  const locked = () => state.batch && !acknowledged(state.batch.status);
  function clearAcknowledgedBatch() {
    if (!acknowledged(state.batch?.status)) return;
    state.batch = null;
    stopPolling(); persist(); render();
  }
  const fab = button('', () => {
    if (cancelRegion) { cancelRegion(); closePanel(); return; }
    if (!panel.hidden) { closePanel(); return; }
    if (chatOpen) { chat.close(); syncFab(); return; }
    setMenu(!menuOpen); if (menuOpen) selectorAction.focus(); checkStatus();
  }); fab.className = 'af-fab'; fab.setAttribute('aria-label', 'Feedback'); fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-controls', 'af-menu af-panel');
  const badge = el('span', 'af-badge'); fab.append(badge);
  const menu = el('div', 'af-menu'); menu.id = 'af-menu'; menu.dataset.open = 'false'; menu.inert = true; menu.setAttribute('aria-hidden', 'true'); menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', 'Artifact discussion options');
  const selectorAction = button('', () => { const retained = state.drafts.length || composer.value.trim() || anchor.type !== 'general'; if (!retained && candidate) { clearAcknowledgedBatch(); anchor = candidate; } openPanel(); if (!retained && !candidate) selectRegion(); }, 'af-selector-action'); selectorAction.setAttribute('aria-label', 'Selector'); selectorAction.title = 'Selector';
  selectorAction.append(el('span', 'af-action-label', 'Selector'));
  const chatAction = button('', () => { closeMenu(); chat.open(); }, 'af-chat-action'); chatAction.setAttribute('aria-label', 'Chat unavailable'); chatAction.disabled = true;
  const chatLabel = el('span', 'af-action-label', 'Chat unavailable'); chatAction.append(chatLabel);
  menu.append(selectorAction, chatAction);
  const panel = el('section', 'af-panel'); panel.dataset.kind = 'feedback'; panel.id = 'af-panel'; panel.hidden = true; panel.setAttribute('aria-labelledby', 'af-title');
  const heading = el('div', 'af-heading'); const title = el('h2', '', 'Comment'); title.id = 'af-title';
  const closeFeedback = button('×', () => closePanel(), 'af-close'); closeFeedback.setAttribute('aria-label', 'Close'); heading.append(title, closeFeedback);
  const status = el('p', 'af-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const conversation = el('section', 'af-feedback-conversation'); conversation.setAttribute('aria-label', 'Feedback discussion'); conversation.hidden = true;
  const replies = el('div', 'af-feedback-replies'); replies.setAttribute('role', 'log'); replies.setAttribute('aria-live', 'polite');
  conversation.append(status, replies);
  const list = el('ol', 'af-drafts'); list.setAttribute('aria-label', 'Draft comments');
  const deleteCurrent = button('Delete', () => { resetComposer(); composeMode = false; if (!state.drafts.length) closePanel(); render(); }); deleteCurrent.setAttribute('aria-label', 'Delete current selection');
  const imageStatus = el('p', 'af-image-status'); imageStatus.setAttribute('role', 'status');
  const retryImage = button('Retry image', () => captureRegion(anchor)); retryImage.hidden = true;
  const label = el('label', 'af-compose-label', 'Your comment'); label.htmlFor = 'af-comment';
  const composer = el('textarea'); composer.id = 'af-comment'; composer.maxLength = 1000; composer.rows = 2; composer.placeholder = 'What would you like to discuss?';
  if (typeof saved.composer === 'string') composer.value = saved.composer.slice(0, 1000);
  draftImageUnavailable = saved.currentImageMissing === true;
  const count = el('span', 'af-count', '0 / 1,000');
  composer.addEventListener('input', () => { if (composer.value.trim()) clearAcknowledgedBatch(); count.textContent = `${composer.value.length} / 1,000`; updateControls(); persist(); });
  const add = button('Add', () => {
    const text = composer.value.trim();
    if (!enabled || locked() || preparing || rendering || !text || !normalizeAnchor(anchor)) return;
    if (state.drafts.length >= 20) { showStatus('You can submit up to 20 comments per batch.'); return; }
    if (acknowledged(state.batch?.status)) state.batch = null;
    const c = { text, anchor, ...(draftImage ? { image: draftImage } : {}), ...(draftImageUnavailable ? { imageUnavailable: true } : {}) };
    state.drafts.push(c);
    resetComposer(); composeMode = false; persist(); render();
  });
  add.className = 'af-save-draft';
  add.title = 'Add (Shift+Enter)'; add.setAttribute('aria-keyshortcuts', 'Shift+Enter');
  composer.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return;
    event.preventDefault(); event.stopPropagation();
    if (!add.disabled) add.click();
  });
  const composeActions = el('div', 'af-actions'); composeActions.append(deleteCurrent, add, count);
  const send = button('Submit feedback', () => sendFeedback(), 'af-send');
  const another = button('+', () => selectRegion(), 'af-new-selection'); another.setAttribute('aria-label', 'Add another'); another.title = 'Add another selection';
  heading.replaceChildren(title, another, closeFeedback);
  const actions = el('div', 'af-actions'); actions.append(send);
  const editor = el('div', 'af-comment-editor'); editor.append(label, composer, imageStatus, retryImage, composeActions);
  const tray = el('div', 'af-draft-tray');
  tray.append(list, actions);
  const card = el('div', 'af-feedback-card'); card.append(heading, editor, tray);
  panel.append(conversation, card);
  root.append(fab, menu, panel);
  const chat = initializeChat(root, { onStateChange, onViewRevision, onMessages: renderReplies, onOpen() { chatOpen = true; cancelRegion?.(); panel.hidden = true; renderMarkers(); closeMenu(); syncFab(); }, onClose() { chatOpen = false; syncFab(); fab.focus(); } });
  let replySignature = '';
  function showStatus(text) {
    status.textContent = text; status.hidden = !text;
    conversation.hidden = status.hidden && !replies.children.length;
  }
  function renderReplies(messages) {
    const notes = messages.filter(message => message.role === 'agent' || message.reply).slice(-3);
    const signature = JSON.stringify(notes);
    if (signature === replySignature) return;
    replySignature = signature; replies.replaceChildren();
    for (const message of notes) {
      replies.append(el('p', 'af-chat-model', message.role === 'agent' ? message.text : message.reply));
      if (message.revisionId && message.revisionId !== revisionId) replies.append(button('View version', () => onViewRevision(message.revisionId)));
    }
    conversation.hidden = !status.textContent && !replies.children.length;
  }
  function cancelCapture() { captureToken++; rendering = false; regionRenderer.cancel(); }
  function captureRegion(value) {
    cancelCapture();
    const token = captureToken;
    if (!imagesEnabled) { draftImageUnavailable = true; updateControls(); return; }
    rendering = true; draftImageUnavailable = false; render();
    regionRenderer.request(value).then(image => {
      if (token === captureToken && anchor === value) draftImage = image;
    }).catch(() => {
      if (token === captureToken && anchor === value) draftImageUnavailable = true;
    }).finally(() => {
      if (token !== captureToken) return;
      rendering = false; persist(); render();
    });
  }
  function resetComposer() { cancelCapture(); draftImageUnavailable = false; composer.value = ''; anchor = { type: 'general' }; candidate = null; draftImage = null; count.textContent = '0 / 1,000'; updateControls(); persist(); }
  function updateControls() {
    const blocked = disposed || !enabled || Boolean(locked()) || preparing;
    // Always permit read-only access to retained drafts and delivery status.
    selectorAction.disabled = false;
    chatAction.disabled = !enabled || !chatEnabled || preparing;
    chatAction.setAttribute('aria-label', chatEnabled ? 'Chat' : 'Chat unavailable'); chatLabel.textContent = chatEnabled ? 'Chat' : 'Chat unavailable'; chatAction.title = chatLabel.textContent;
    deleteCurrent.disabled = blocked || rendering; composer.disabled = blocked;
    add.disabled = blocked || rendering || !composer.value.trim() || (state.drafts.length >= 20);
    another.hidden = composeMode; another.disabled = blocked || rendering || state.drafts.length >= 20; send.setAttribute('aria-label', 'Submit feedback'); send.textContent = `Submit (${state.drafts.length})`;
    count.hidden = composer.value.length < 900;
    send.disabled = blocked || rendering || !state.drafts.length || Boolean(composer.value.trim()) || state.drafts.some(comment => comment.imageMissing);
    imageStatus.textContent = rendering ? 'Generating image…' : draftImageUnavailable ? 'Image unavailable — this comment will contain text/region context only.' : '';
    imageStatus.hidden = !imageStatus.textContent;
    retryImage.hidden = !imagesEnabled || !draftImageUnavailable || anchor.type !== 'region'; retryImage.disabled = blocked || rendering;
    send.title = composer.value.trim() ? 'Add or clear the current comment first.' : '';
  }
  function render() {
    if (disposed) return;
    panel.dataset.mode = composeMode ? 'compose' : 'drafts'; editor.hidden = !composeMode; tray.hidden = composeMode;
    title.textContent = composeMode ? 'Comment' : `Feedback (${state.drafts.length})`;
    send.hidden = !state.drafts.length;
    badge.textContent = String(state.drafts.length); badge.hidden = !state.drafts.length;
    list.replaceChildren();
    state.drafts.forEach((c, index) => {
      const item = el('li'), text = el('p', 'af-comment-text', c.text);
      const remove = button('Delete', () => { state.drafts.splice(index, 1); persist(); render(); });
      remove.setAttribute('aria-label', `Delete comment ${index + 1}`);
      remove.disabled = !enabled || Boolean(locked()) || preparing;
      const number = el('span', 'af-comment-number', `#${index + 1}`);
      const row = el('div', 'af-actions'); row.append(remove); item.append(number, text, row);
      if (c.imageUnavailable) item.append(el('small', 'af-reference', 'Image unavailable — text/region context only.'));
      if (c.imageMissing) item.append(el('small', 'af-reference', 'Image missing — delete this comment and select again.'));
      list.append(item);
    });
    const messages = { sending: 'Submitting…', queued: 'Submitted — awaiting the agent’s acknowledgement. Comments are retained.', received: 'Received by the agent.', delivered: 'Submitted. Thank you.', failed: 'Feedback could not be processed. Comments are retained; this batch will not be submitted again automatically.', uncertain: 'Agent acknowledgement is unconfirmed. Comments are retained. Do not submit a duplicate batch.' };
    showStatus(!enabled ? 'Feedback is unavailable or this artifact has expired. Ask for a fresh artifact to restore feedback. Your saved drafts remain here.' : preparing ? 'Submitting…' : messages[state.batch?.status] || (selectionUnavailable ? 'Scroll position unavailable. Wait for the artifact to load, then try selecting again.' : '') || '');
    updateControls(); renderMarkers(); onStateChange();
  }
  function syncFab() { fab.dataset.selecting = String(Boolean(cancelRegion)); const open = menuOpen || Boolean(cancelRegion) || !panel.hidden || chatOpen; fab.dataset.open = String(open); fab.setAttribute('aria-expanded', String(open)); fab.title = cancelRegion ? 'Exit selector' : open ? 'Close feedback' : 'Feedback — annotate or chat'; onStateChange(); }
  function setMenu(open) { menuOpen = open; menu.dataset.open = String(open); menu.inert = !open; menu.setAttribute('aria-hidden', String(!open)); syncFab(); }
  function closeMenu() { setMenu(false); }
  function openPanel() { chat.close(); closeMenu(); panel.hidden = false; composeMode = anchor.type !== 'general' || Boolean(composer.value.trim()) || !state.drafts.length; render(); if (composeMode) composer.focus(); checkStatus(); syncFab(); }
  function closePanel() { panel.hidden = true; renderMarkers(); closeMenu(); syncFab(); fab.focus(); }
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(); syncFab(); fab.focus(); }
  });
  listen(window, 'pointerdown', event => { if (event.target !== fab && !root.contains?.(event.target)) closeMenu(); });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closePanel(); } });
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function schedulePoll() {
    stopPolling();
    if (!disposed && enabled && state.batch?.status === 'queued' && pollCount < 12) pollTimer = setTimeout(() => { pollCount++; checkStatus(); }, 2500);
  }
  function reconcileFeedback(data) {
    if (disposed || !data) return;
    if (typeof data.enabled !== 'boolean' || !Array.isArray(data.batches)) return;
    enabled = data.enabled; imagesEnabled = data.imagesEnabled === true; chatEnabled = data.chatEnabled === true; chat.setEnabled(enabled && chatEnabled);
    const batch = data.batches.find(b => b?.batchId === state.batch?.id);
    if (batch && STATUSES.has(batch.status) && batch.status !== 'sending') state = applyBatchStatus(state, batch.batchId, batch.status);
    if (!enabled) stopPolling(); persist(); render();
  }
  function applySnapshot(snapshot) {
    if (disposed) return; snapshotGeneration++;
    if (snapshot.feedback) reconcileFeedback({ ...snapshot.feedback, chatEnabled: snapshot.chat?.enabled ?? snapshot.feedback.chatEnabled });
    if (snapshot.chat) { chatEnabled = snapshot.chat.enabled === true; chat.applySnapshot(snapshot.chat); updateControls(); }
  }
  async function checkStatus() {
    if (checking || disposed) return;
    const generation = snapshotGeneration; checking = true;
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (disposed || generation !== snapshotGeneration) return;
      if (response.status === 404 || response.status === 503) { enabled = false; stopPolling(); render(); return; }
      if (!response.ok) return;
      const data = await response.json();
      if (disposed || generation !== snapshotGeneration) return;
      reconcileFeedback(data);
    } catch { /* A read failure does not imply delivery or justify another send. */ }
    finally { checking = false; if (!disposed) schedulePoll(); }
  }
  async function sendFeedback() {
    if (disposed || !enabled || locked() || preparing || rendering || !state.drafts.length || composer.value.trim()) return;
    let body;
    try { body = createBatch(crypto.randomUUID(), root.dataset.csrf, state.drafts); }
    catch (error) { showStatus(error.message); return; }
    preparing = true; render();
    try {
      for (const comment of state.drafts) if (comment.image && !comment.imageId) {
        if (!imagesEnabled) throw new Error('Screenshot support is unavailable. Your local drafts remain saved.');
        const response = await fetch(`${root.dataset.path}/images`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf: root.dataset.csrf, id: comment.image.id, data: comment.image.data, ...(revisionId ? { revisionId } : {}) }), signal: AbortSignal.timeout(15000) });
        if (response.status !== 202) throw new Error('Screenshot upload was not confirmed. No comments were sent; retry uploads only with the same screenshot IDs.');
        const image = await response.json();
        if (disposed) return;
        if (image.id !== comment.image.id || image.mimeType !== 'image/jpeg') throw new Error('Screenshot upload returned an invalid reference. No comments were sent.');
        comment.imageId = image.id; persist();
      }
      body = createBatch(body.id, root.dataset.csrf, state.drafts);
    } catch (error) { preparing = false; render(); showStatus(error.message); return; }
    if (disposed) return;
    preparing = false; if (revisionId) body.revisionId = revisionId;
    state.batch = { id: body.id, status: 'sending' }; persist(); render(); pollCount = 0;
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      if (disposed) return;
      if (response.status === 404 || response.status === 503) enabled = false;
      if (response.status !== 202) { state = applyBatchStatus(state, body.id, response.status >= 400 && response.status < 500 ? 'failed' : 'uncertain'); }
      else {
        const data = await response.json();
        if (disposed) return;
        state = applyBatchStatus(state, body.id, data.batchId === body.id && ['queued', 'received', 'delivered', 'failed', 'uncertain'].includes(data.status) ? data.status : 'uncertain');
      }
    } catch { state = applyBatchStatus(state, body.id, 'uncertain'); }
    if (!disposed) { persist(); render(); schedulePoll(); }
  }
  listen(window, 'message', event => {
    if (event.source === frame.contentWindow && event.data?.type === 'clawtifact:selection-clear') { candidate = null; persist(); return; }
    const message = parseBridgeMessage(event, frame.contentWindow);
    if (message?.type === 'selection') { candidate = message.anchor; updateControls(); persist(); }
    else if (message?.type === 'viewport') {
      const changed = !viewport || ['scrollX', 'scrollY', 'viewportWidth', 'viewportHeight'].some(k => viewport[k] !== message[k]);
      viewport = message;
      if (changed && cancelRegion) cancelRegion();
      if (changed && rendering) regionRenderer.cancel();
      renderMarkers();
    }
  });
  // The child can finish loading before this module installs its listener.
  // Replay its current viewport; never infer scroll offsets from frame bounds.
  frame.contentWindow?.postMessage({ type: 'clawtifact:request-viewport' }, '*');
  function renderMarkers() {
    // Send only geometry and ordinal numbers, never text/credentials/actions.
    // The child paints inert document decorations; the trusted tray owns edits.
    const markers = state.drafts.flatMap((comment, index) => comment.anchor.type === 'region' && comment.anchor.scrollKnown ? [{ number: index + 1, anchor: comment.anchor }] : []);
    if (composeMode && !cancelRegion && anchor.type === 'region' && anchor.scrollKnown && state.drafts.length < 20) markers.push({ number: state.drafts.length + 1, anchor });
    const message = { type: 'clawtifact:draft-markers', visible: (!panel.hidden || Boolean(cancelRegion)) && !chatOpen, markers };
    const signature = JSON.stringify(message);
    if (signature === markerSignature) return;
    markerSignature = signature;
    frame.contentWindow?.postMessage(message, '*');
  }
  function selectRegion() {
    if (!enabled || locked() || preparing || rendering || cancelRegion || state.drafts.length >= 20) return;
    if (!viewport) {
      selectionUnavailable = true;
      frame.contentWindow?.postMessage({ type: 'clawtifact:request-viewport' }, '*');
      openPanel(); render();
      return;
    }
    selectionUnavailable = false;
    if (composer.value.trim()) { openPanel(); showStatus('Add or delete the current comment before selecting another region.'); return; }
    const rect = frame.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return;
    clearAcknowledgedBatch();
    closeMenu(); panel.hidden = true;
    const layer = el('div', 'af-region-selector'); layer.tabIndex = 0; layer.setAttribute('role', 'group'); layer.setAttribute('aria-label', 'Select region. Drag, or use arrow keys to move, Shift plus arrows to resize. Enter confirms. Escape cancels.');
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const instruction = el('span', 'af-selector-status'); instruction.hidden = true; instruction.setAttribute('role', 'status');
    const box = el('div', 'af-region-box'); layer.append(box, instruction); root.append(layer);
    let start = { x: rect.width * .25, y: rect.height * .25 }, end = { x: rect.width * .75, y: rect.height * .75 }, drag = null, finished = false;
    const capturedViewport = { scrollX: viewport.scrollX, scrollY: viewport.scrollY, viewportWidth: viewport.viewportWidth, viewportHeight: viewport.viewportHeight, scrollKnown: true };
    let lookupVersion = 0, lastHoverAt = 0, clickPending = false;
    const paint = () => Object.assign(box.style, { left: `${Math.min(start.x, end.x)}px`, top: `${Math.min(start.y, end.y)}px`, width: `${Math.abs(start.x - end.x)}px`, height: `${Math.abs(start.y - end.y)}px` });
    const finish = accept => {
      if (finished) return;
      const region = regionFromPoints(start, end, rect, capturedViewport);
      if (accept && !region) return;
      composeMode = accept || !state.drafts.length || Boolean(composer.value.trim());
      finished = true; clickPending = false; lookupVersion++; elementPicker.cancel(); cancelRegion = null; layer.remove(); panel.hidden = false; syncFab();
      if (accept && region) { cancelCapture(); draftImageUnavailable = false; anchor = region; draftImage = null; captureRegion(region); persist(); }
      render();
      if (composeMode) composer.focus();
    };
    cancelRegion = () => finish(false);
    const controls = el('div', 'af-region-controls af-keyboard-controls');
    const done = button('Done selecting', () => finish(true));
    const remove = button('Delete selection', () => {
      resetComposer();
      finish(false); render();
    });
    const cancel = button('Cancel selection', () => finish(false));
    controls.append(done, remove, cancel); layer.append(controls);
    const point = event => ({ x: Math.min(rect.width, Math.max(0, event.clientX - rect.left)), y: Math.min(rect.height, Math.max(0, event.clientY - rect.top)) });
    const begin = event => {
      if (event.button !== 0 || event.isPrimary === false || drag) return; event.preventDefault(); event.stopPropagation();
      lookupVersion++; clickPending = false; elementPicker.cancel();
      drag = { mode: 'pick', pointerId: event.pointerId, origin: point(event) };
      start = end = point(event); box.hidden = true;
      try { layer.setPointerCapture(event.pointerId); } catch { /* Pointer events remain usable without capture. */ }
    };
    const move = event => {
      if (!drag) {
        if (finished || clickPending || Date.now() - lastHoverAt < 40) return; lastHoverAt = Date.now();
        const version = ++lookupVersion, p = point(event);
        elementPicker.request(p, capturedViewport).then(region => {
          if (!region || finished || drag || version !== lookupVersion) return;
          start = { x: region.x * rect.width, y: region.y * rect.height }; end = { x: start.x + region.width * rect.width, y: start.y + region.height * rect.height }; box.hidden = false; paint();
        }); return;
      }
      if (event.pointerId !== undefined && drag.pointerId !== event.pointerId) return;
      const p = point(event), dx = p.x - drag.origin.x, dy = p.y - drag.origin.y;
      if (drag.mode === 'pick') { if (Math.hypot(dx, dy) < 7) return; drag.mode = 'draw'; box.hidden = false; }
      if (drag.mode === 'draw') end = p;
      paint();
    };
    layer.addEventListener('pointerdown', event => { if (event.target === layer) begin(event); });
    box.addEventListener('pointerdown', event => { if (event.target === box) begin(event); });
    layer.addEventListener('pointermove', move);
    const normalize = () => {
      const lo = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) }, hi = { x: Math.max(start.x, end.x), y: Math.max(start.y, end.y) };
      start = lo; end = hi;
    };
    layer.addEventListener('pointerup', event => {
      if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
      move(event); const gesture = drag; drag = null;
      if (gesture.mode !== 'pick') { normalize(); paint(); finish(true); return; }
      const version = ++lookupVersion; clickPending = true;
      elementPicker.request(point(event), capturedViewport).then(region => {
        if (finished || version !== lookupVersion) return;
        clickPending = false;
        if (!region) { instruction.hidden = false; instruction.textContent = 'Element selection is unavailable here. Drag to draw a rectangle, or press Escape to exit.'; box.hidden = true; return; }
        start = { x: region.x * rect.width, y: region.y * rect.height }; end = { x: start.x + region.width * rect.width, y: start.y + region.height * rect.height }; finish(true);
      });
    });
    layer.addEventListener('pointercancel', () => finish(false));
    const adjust = (delta, resize) => {
      normalize();
      if (resize) { end = { x: Math.min(rect.width, Math.max(start.x + Math.min(4, rect.width - start.x), end.x + delta[0])), y: Math.min(rect.height, Math.max(start.y + Math.min(4, rect.height - start.y), end.y + delta[1])) }; }
      else { const dx = Math.min(rect.width - end.x, Math.max(-start.x, delta[0])); const dy = Math.min(rect.height - end.y, Math.max(-start.y, delta[1])); start = { x: start.x + dx, y: start.y + dy }; end = { x: end.x + dx, y: end.y + dy }; }
      box.hidden = false; paint();
    };
    const nudges = el('div', 'af-region-nudges');
    for (const [label, delta, resize] of [
      ['Move left', [-8, 0], false], ['Move right', [8, 0], false], ['Move up', [0, -8], false], ['Move down', [0, 8], false],
      ['Narrower', [-8, 0], true], ['Wider', [8, 0], true], ['Shorter', [0, -8], true], ['Taller', [0, 8], true],
    ]) nudges.append(button(label, () => adjust(delta, resize)));
    controls.append(nudges);
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); return; }
      if (event.target !== layer) return;
      if (event.key === 'Enter') { event.preventDefault(); finish(true); return; }
      const delta = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[event.key];
      if (!delta) return; event.preventDefault();
      adjust(delta, event.shiftKey);
    });
    paint(); box.hidden = true; syncFab(); renderMarkers(); layer.focus();
  }
  listen(frame, 'load', () => { cancelRegion?.(); elementPicker.cancel(); viewport = null; markerSignature = ''; frame.contentWindow?.postMessage({ type: 'clawtifact:request-viewport' }, '*'); renderMarkers(); });
  render(); checkStatus(); syncFab();
  listen(window, 'resize', () => { cancelRegion?.(); renderMarkers(); });
  function feedbackBusy() { return !disposed && Boolean(state.drafts.length || composer.value.trim() || anchor.type !== 'general' || candidate || cancelRegion || rendering || preparing || locked()); }
  function isBusy() { return feedbackBusy() || chat.isBusy(); }
  function dispose() { if (disposed) return; persist(); disposed = true; stopPolling(); cancelRegion?.(); cancelCapture(); regionRenderer.dispose(); elementPicker.dispose(); chat.dispose(); for (const remove of removers) remove(); }
  listen(window, 'pagehide', dispose);
  return { getState: () => state, isBusy, applySnapshot, dispose };
}
if (typeof document !== 'undefined') {
  const root = document.getElementById('artifact-feedback'), frame = document.getElementById('artifact-content');
  if (root && frame) { if (root.dataset.live === 'true' && revisionIdValid(root.dataset.revisionId)) createLiveViewer({ root, frame, mountFeedback: initializeFeedback }); else initializeFeedback(root, frame); }
}

function revisionIdValid(value) { return /^[a-f0-9]{32}$/.test(value || ''); }
