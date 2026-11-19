// This module runs only in the trusted shell. Authored frames can report activity,
// never revisions, routing, credentials, submissions, or permission to update.
const REVISION = /^[a-f0-9]{32}$/;
const READONLY = new Set(['markdown', 'code', 'svg', 'mermaid']);
const metadata = value => value && REVISION.test(value.revisionId) && Number.isSafeInteger(value.sequence) && value.sequence > 0 && typeof value.format === 'string';
export function createLiveViewer({ root, frame, mountFeedback, document: doc = globalThis.document, window: host = globalThis.window, EventSource: Source = globalThis.EventSource, fetch: request = globalThis.fetch, sessionStorage: storage, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout }) {
  let currentFrame = frame, controls, source, latest = null, epoch = null, cursor = -1, staged = null, stagedHistorical = false, stagedRevision = null, stagedCommit = null, stageReadyId = null, currentReadyId = null, currentAcknowledged = false, loadError = '', generation = 0, idleProof = false, selectionActive = false, historical = false, disposed = false, expired = false, reconnecting = false, updated = '', recoveryTimer = null, stageTimer = null, noticeTimer = null;
  const retiredEpochs = new Set(), listeners = [];
  const listen = (target, type, fn, options) => { target.addEventListener(type, fn, options); listeners.push(() => target.removeEventListener?.(type, fn, options)); };
  const bar = doc.createElement('aside'); bar.className = 'af-live-bar'; bar.hidden = true; bar.setAttribute('aria-label', 'Artifact updates');
  const note = doc.createElement('span'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  const apply = doc.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply'; apply.addEventListener('click', () => applyLatest()); bar.append(note, apply); root.append(bar);
  const busy = () => selectionActive || !controls || typeof controls.isBusy !== 'function' || controls.isBusy();
  const current = () => ({ revisionId: root.dataset.revisionId, sequence: Number(root.dataset.sequence), format: root.dataset.format });
  const pending = () => Boolean(latest && latest.head.revisionId !== root.dataset.revisionId);
  function render() {
    bar.hidden = disposed || (!expired && !reconnecting && !historical && !pending() && !updated && !loadError);
    note.textContent = expired ? 'This artifact is no longer available.' : reconnecting ? 'Reconnecting… Updates will resume automatically.' : loadError ? loadError : historical ? `Viewing v${root.dataset.sequence}` : pending() ? 'Update ready' : updated;
    root.dataset.liveNotice = String(!bar.hidden);
    apply.textContent = historical ? 'View latest' : 'Apply';
    apply.hidden = expired || !latest || (!historical && !pending());
    apply.disabled = expired || busy() || Boolean(staged);
    apply.title = busy() ? 'Finish or delete your current feedback or Chat draft before changing versions.' : '';
  }
  function cancelStage() { stagedCommit = null; stageReadyId = null; stagedRevision = null; generation++; cancel(stageTimer); stageTimer = null; if (staged) { staged.remove(); staged = null; } }
  function acknowledge(revisionId) {
    // An applied receipt is a browser fact, never evidence the person read it.
    void request(root.dataset.path + '/applied', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf: root.dataset.csrf, revisionId }), signal: AbortSignal.timeout(12000) }).then(response => { if (response.status === 404 || response.status === 410) expire(); }).catch(() => {});
  }
  function mount() { controls = mountFeedback(root, currentFrame, { onViewRevision: viewRevision, onStateChange: interactionChanged }); if (latest) controls.applySnapshot?.(latest); }
  function switchTo(target, explicit = false, old = false) {
    if (disposed || expired || !metadata(target) || busy()) { render(); return false; }
    if (target.revisionId === root.dataset.revisionId) { historical = old; render(); return true; }
    if (!explicit && (historical || !READONLY.has(root.dataset.format) || !idleProof)) { render(); return false; }
    cancelStage(); const token = generation;
    const next = doc.createElement('iframe'); staged = next; stagedHistorical = old; stagedRevision = target.revisionId; loadError = ''; next.hidden = true;
    for (const name of ['sandbox', 'referrerpolicy', 'title']) { const value = currentFrame.getAttribute?.(name); if (value !== null && value !== undefined) next.setAttribute(name, value); }
    next.setAttribute('sandbox', 'allow-scripts'); next.setAttribute('referrerpolicy', 'no-referrer');
    next.className = 'af-live-candidate'; next.src = root.dataset.path + '/content?revision=' + target.revisionId;
    stagedCommit = () => {
      if (disposed || expired || token !== generation || staged !== next) return;
      if (busy() || (!explicit && !idleProof)) { cancelStage(); render(); return; }
      cancel(stageTimer); stageTimer = null;
      // Dispose every old message receiver/capture/timer BEFORE admitting a new
      // WindowProxy. Navigating the old iframe would not provide this isolation.
      frame.removeEventListener?.('load', requestInitialReady);
      controls.dispose?.();
      for (const node of [...root.children]) if (node !== bar) node.remove();
      // Reveal in place: reparenting an already-loaded iframe can create a new
      // browsing context and reload it in browsers. Only remove the old frame.
      const previous = currentFrame; next.id = previous.id || 'artifact-content'; next.className = previous.className || ''; next.hidden = false; previous.remove();
      currentFrame = next; staged = null; stagedCommit = null; stageReadyId = null; currentReadyId = null; currentAcknowledged = true; generation++; idleProof = false; selectionActive = false; historical = old; updated = `Updated to v${target.sequence}`;
      cancel(noticeTimer); noticeTimer = schedule(() => { updated = ''; noticeTimer = null; render(); }, 3500);
      Object.assign(root.dataset, { revisionId: target.revisionId, sequence: String(target.sequence), format: target.format });
      mount(); render(); acknowledge(target.revisionId);
      currentFrame.contentWindow?.postMessage({ type: 'clawtifact:request-activity' }, '*');
    };
    next.addEventListener('load', () => {
      if (disposed || expired || token !== generation || staged !== next) return;
      if (busy() || (!explicit && !idleProof)) { cancelStage(); render(); return; }
      // HTTP error pages also fire load. A fresh nonce returned by this exact
      // candidate's bridge is required before content can be shown or acked.
      stageReadyId = crypto.randomUUID();
      next.contentWindow?.postMessage({ type: 'clawtifact:request-ready', requestId: stageReadyId }, '*');
    });
    next.addEventListener('error', () => { if (staged === next) { cancelStage(); loadError = 'Update could not load. Apply to retry.'; render(); } });
    currentFrame.parentNode.append(next);
    stageTimer = schedule(() => { if (staged === next) { cancelStage(); loadError = 'Update could not load. Apply to retry.'; render(); } }, 20000);
    render(); return true;
  }
  function applyLatest() { if (!latest || expired || disposed) return false; return switchTo(latest.head, true, false); }
  function viewRevision(revisionId) { const target = latest?.revisions?.find(revision => revision.revisionId === revisionId); return target ? switchTo(target, true, revisionId !== latest.head.revisionId) : false; }
  function interactionChanged() { if (disposed || expired) return; if (busy() && staged) cancelStage(); render(); }
  function applySnapshot(value) {
    if (disposed || expired || !value || !metadata(value.head) || typeof value.epoch !== 'string' || !Number.isSafeInteger(value.snapshotSequence) || value.snapshotSequence < 0 || !Array.isArray(value.revisions)) return false;
    if (retiredEpochs.has(value.epoch)) return false;
    if (epoch !== value.epoch) { if (epoch !== null) { retiredEpochs.add(epoch); cancelStage(); } epoch = value.epoch; cursor = -1; }
    if (value.snapshotSequence <= cursor) { if (value.snapshotSequence === cursor) { reconnecting = false; render(); } return false; }
    cursor = value.snapshotSequence; latest = value; reconnecting = false;
    controls.applySnapshot?.(value);
    if (staged && stagedRevision !== value.head.revisionId && !stagedHistorical) cancelStage();
    render(); if (pending() && !staged) switchTo(value.head); return true;
  }
  function expire() {
    if (disposed || expired) return;
    expired = true; source?.close(); cancel(recoveryTimer); cancel(noticeTimer); cancelStage(); controls.dispose?.(); currentFrame.remove();
    // Remove content access and stale controls on a terminal auth/expiry signal.
    for (const node of [...root.children]) if (node !== bar) node.remove(); render();
  }
  async function recover() {
    if (disposed || expired) return;
    try {
      const response = await request(root.dataset.path + '/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (response.status === 404 || response.status === 410) { expire(); return; }
      if (response.ok) applySnapshot(await response.json());
    } catch { /* EventSource reconnects; a failed read never permits a resend. */ }
    if (!disposed && !expired && (!source || reconnecting)) recoveryTimer = schedule(recover, 15000);
  }
  function requestInitialReady() {
    if (disposed || expired || currentFrame !== frame || currentAcknowledged) return;
    currentReadyId = crypto.randomUUID();
    frame.contentWindow?.postMessage({ type: 'clawtifact:request-ready', requestId: currentReadyId }, '*');
  }
  listen(frame, 'load', requestInitialReady);
  listen(host, 'message', event => {
    if (disposed || expired) return;
    if (event.data?.type === 'clawtifact:ready') {
      if (staged && stageReadyId && event.source === staged.contentWindow && event.data.requestId === stageReadyId) stagedCommit?.();
      else if (!currentAcknowledged && currentReadyId && event.source === currentFrame.contentWindow && event.data.requestId === currentReadyId) { currentAcknowledged = true; acknowledge(root.dataset.revisionId); currentFrame.contentWindow?.postMessage({ type: 'clawtifact:request-activity' }, '*'); }
      return;
    }
    if (expired || disposed || event.source !== currentFrame.contentWindow || event.data?.type !== 'clawtifact:activity' || typeof event.data.idle !== 'boolean') return;
    idleProof = event.data.idle;
    if (typeof event.data.selection === 'boolean') selectionActive = event.data.selection;
    if (!idleProof && staged) cancelStage(); render();
    if (idleProof && pending() && !staged) switchTo(latest.head);
  });
  for (const type of ['input', 'pointerdown', 'keydown']) listen(root, type, interactionChanged, true);
  listen(host, 'pagehide', () => dispose());
  mount();
  // A reload may have landed on a newer head. Restore the explicitly pinned
  // reviewed revision before offering any update; never transplant its drafts.
  try {
    const optionalStorage = storage === undefined ? globalThis.sessionStorage : storage;
    for (const kind of ['feedback', 'chat']) {
      const pin = JSON.parse(optionalStorage?.getItem(`clawtifact:pin:${kind}:${root.dataset.artifactId}`) || 'null');
      if (metadata(pin) && pin.revisionId !== root.dataset.revisionId) { switchTo(pin, true, true); break; }
    }
  } catch { /* Optional storage. */ }
  if (typeof Source === 'function') {
    source = new Source(root.dataset.path + '/events');
    source.addEventListener('snapshot', event => { try { applySnapshot(JSON.parse(event.data)); } catch {} });
    source.addEventListener('expired', expire);
    source.addEventListener('error', () => { if (disposed || expired) return; reconnecting = true; render(); cancel(recoveryTimer); recoveryTimer = schedule(recover, 3000); });
  } else { reconnecting = true; recoveryTimer = schedule(recover, 0); }
  function dispose() { if (disposed) return; disposed = true; source?.close(); cancel(recoveryTimer); cancel(noticeTimer); cancelStage(); controls.dispose?.(); for (const remove of listeners) remove(); bar.remove(); }
  render(); if (metadata(current())) requestInitialReady();
  currentFrame.contentWindow?.postMessage({ type: 'clawtifact:request-activity' }, '*');
  return { applySnapshot, applyLatest, viewRevision, dispose, getState: () => ({ head: latest?.head, revisionId: root.dataset.revisionId, epoch, snapshotSequence: cursor, historical, expired }) };
}
