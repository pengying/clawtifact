const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES = new Set(['queued', 'responding', 'replied', 'failed', 'uncertain', 'blocked']);
export function initializeChat(root, { onOpen = () => {}, onClose = () => {}, onStateChange = () => {}, onViewRevision = () => {}, onMessages = () => {} } = {}) {
  const revisionId = root.dataset.revisionId;
  const endpoint = root.dataset.path + '/chat', key = 'clawtifact:chat:' + root.dataset.artifactId + (revisionId ? ':' + revisionId : '');
  const pinKey = 'clawtifact:pin:chat:' + root.dataset.artifactId;
  const revision = { revisionId, sequence: Number(root.dataset.sequence), format: root.dataset.format };
  const removers = []; let snapshotGeneration = 0;
  const listen = (target, type, fn) => { if (!target.addEventListener) return; const safe = event => { if (!disposed) return fn(event); }; target.addEventListener(type, safe); removers.push(() => target.removeEventListener?.(type, safe)); };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const button = (text, action) => { const node = el('button', '', text); node.type = 'button'; node.addEventListener('click', action); return node; };
  let enabled = false, messages = [], pendingId = null, pendingText = '', uncertain = false, checking = false, disposed = false, timer = null, pollCount = 0;
  const panel = el('section', 'af-panel af-chat-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Discuss this artifact');
  const heading = el('div', 'af-heading'); heading.append(el('h2', '', 'Discuss this artifact'), button('Close chat', () => close()));
  const help = el('p', 'af-help', 'Reviewer messages and model replies are shared with the original thread. This isolated Chat sees artifact-specific context, not private thread history. ' + (root.dataset.feedbackMode === 'revise' ? 'Submitted suggestions can drive document-only edits by the original agent, with no external actions.' : 'It cannot make changes or take actions.'));
  const status = el('p', 'af-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const log = el('div', 'af-chat-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
  const label = el('label', '', 'Ask about this artifact');
  const composer = el('textarea', 'af-chat-compose'); composer.maxLength = 2000; composer.rows = 3; composer.id = 'af-chat-compose'; label.htmlFor = composer.id;
  const send = button('Send message', () => submit());
  panel.append(heading, help, log, status, label, composer, send); root.append(panel);
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
    if (typeof saved.composer === 'string') composer.value = saved.composer.slice(0, 2000);
    if (UUID.test(saved.pendingId)) { pendingId = saved.pendingId; pendingText = typeof saved.pendingText === 'string' ? saved.pendingText.slice(0, 2000) : ''; uncertain = true; }
  } catch { /* Storage is optional, including private/mobile browser modes. */ }
  function persist() { try { sessionStorage.setItem(key, JSON.stringify({ composer: composer.value, pendingId, pendingText })); if (revisionId) { if (isBusy()) sessionStorage.setItem(pinKey, JSON.stringify(revision)); else if (JSON.parse(sessionStorage.getItem(pinKey) || 'null')?.revisionId === revisionId) sessionStorage.removeItem?.(pinKey); } } catch {} onStateChange(); }
  function isBusy() { return !disposed && Boolean(composer.value.trim() || pendingId || serverPending()); }
  function stop() { clearTimeout(timer); timer = null; }
  const serverPending = () => messages.some(message => (!revisionId || !message.revisionId || message.revisionId === revisionId) && ['queued', 'responding', 'uncertain'].includes(message.status));
  function schedule() {
    stop();
    if (!disposed && enabled && !panel.hidden && !document.hidden && (pendingId || serverPending() || messages.some(message => ['queued', 'sending'].includes(message.mirrorStatus)))) {
      const delay = Math.min(15000, Math.round(2500 * Math.pow(1.5, pollCount++)));
      timer = setTimeout(check, delay);
    }
  }
  function render() {
    if (disposed) return;
    const top = log.scrollTop, nearBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 100;
    log.replaceChildren();
    for (const message of messages) {
      const entry = el('article', 'af-chat-entry');
      entry.append(el('small', 'af-reference', message.role === 'agent' ? 'Model' : 'Artifact reviewer'), el('p', message.role === 'agent' ? 'af-chat-model' : 'af-chat-reviewer', message.text));
      if (message.revisionId && message.revisionId !== revisionId) entry.append(button('View version', () => onViewRevision(message.revisionId)));
      if (message.reply) entry.append(el('small', 'af-reference', 'Model'), el('p', 'af-chat-model', message.reply));
      const note = message.role === 'agent' ? 'Agent note' : message.status === 'blocked' ? (message.error || 'Reply blocked before inference. Retry or continue in the original thread.') : message.status === 'queued' ? 'Queued — waiting for the original session.' : message.status === 'responding' ? 'Preparing an artifact-only reply…' : message.status === 'failed' ? 'Reply unavailable. No automatic retry was made.' : message.status === 'uncertain' ? 'Request outcome unconfirmed. No automatic retry.' : message.mirrorStatus === 'delivered' ? 'Reply shared with the original thread.' : 'Reply ready; original-thread delivery is not confirmed.';
      entry.append(el('small', 'af-reference', note));
      if (message.status === 'blocked') {
        const retry = button('Retry reply', () => submit(message));
        retry.disabled = Boolean(revisionId && message.revisionId && message.revisionId !== revisionId) || !enabled || checking || Boolean(pendingId) || serverPending();
        entry.append(retry);
      }
      log.append(entry);
    }
    status.textContent = !enabled ? 'Chat is unavailable or this artifact has expired. Your unsent text is retained.' : uncertain ? 'Send outcome unconfirmed. Checking the same message ID; no automatic resend.' : pendingId ? 'Waiting for the queued discussion. You can close this panel and return.' : 'Ask a question. Replies and document updates appear here automatically.';
    composer.disabled = !enabled || Boolean(pendingId) || serverPending();
    send.disabled = !enabled || checking || Boolean(pendingId) || serverPending() || !composer.value.trim();
    log.scrollTop = nearBottom ? log.scrollHeight : top;
    onMessages(messages);
  }
  function reconcile(data) {
    if (disposed) return;
    if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.messages) || data.messages.length > 100) return;
    if (!data.messages.every(message => UUID.test(message?.id) && typeof message.text === 'string' && message.text.length <= (message.role === 'agent' ? 4000 : 2000) && STATES.has(message.status) && (message.error === undefined || (typeof message.error === 'string' && message.error.length <= 500)) && (message.reply === undefined || (typeof message.reply === 'string' && message.reply.length <= 4000)))) return;
    enabled = data.enabled; messages = data.messages;
    const pending = messages.find(message => message.id === pendingId);
    if (pending) {
      uncertain = false;
      if (pending.status === 'replied' || pending.status === 'failed' || pending.status === 'blocked') {
        if (pending.status === 'replied' && composer.value.trim() === pendingText) composer.value = '';
        if (pending.status === 'failed' && !composer.value.trim()) composer.value = pendingText;
        pendingId = null; pendingText = '';
      } else composer.value = '';
    }
    persist(); render();
  }
  function applySnapshot(data) { snapshotGeneration++; reconcile(data?.chat || data); }
  async function check() {
    if (!enabled || checking || disposed) return;
    const generation = snapshotGeneration; checking = true; render();
    try {
      const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (disposed || generation !== snapshotGeneration) return;
      if (response.status === 404 || response.status === 503) { enabled = false; stop(); render(); return; }
      if (!response.ok) return;
      const data = await response.json();
      if (disposed || generation !== snapshotGeneration) return;
      reconcile(data);
    } catch { /* A failed status read never justifies resending a message. */ }
    finally { checking = false; if (!disposed) { render(); schedule(); } }
  }
  async function submit(retryMessage) {
    if (disposed || !enabled || checking || pendingId || serverPending() || (retryMessage ? retryMessage.status !== 'blocked' : !composer.value.trim())) return;
    pendingText = retryMessage ? retryMessage.text : composer.value.trim(); pendingId = retryMessage ? retryMessage.id : crypto.randomUUID(); uncertain = false; pollCount = 0;
    const id = pendingId, text = pendingText, sendGeneration = snapshotGeneration; persist(); render();
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf: root.dataset.csrf, id, text, ...(revisionId ? { revisionId } : {}), ...(retryMessage ? { retry: true } : {}) }), signal: AbortSignal.timeout(15000) });
      if (disposed || snapshotGeneration !== sendGeneration) return;
      if (response.status === 404 || response.status === 503) enabled = false;
      if (response.status === 202) {
        const data = await response.json();
        if (disposed || snapshotGeneration !== sendGeneration) return;
        if (data.id !== id || !STATES.has(data.status)) { uncertain = true; }
        else { if (!retryMessage) composer.value = ''; messages = [...messages.filter(message => message.id !== id), { id, text, status: data.status, mirrorStatus: data.mirrorStatus, error: data.error }]; }
      } else if (response.status >= 400 && response.status < 500) { pendingId = null; pendingText = ''; }
      else uncertain = true;
    } catch { if (!disposed && pendingId === id) uncertain = true; }
    if (!disposed) { persist(); render(); await check(); }
  }
  composer.addEventListener('input', () => { persist(); render(); });
  composer.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); }
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
  function open() { if (!enabled) return; onOpen(); panel.hidden = false; composer.focus(); pollCount = 0; void check(); }
  function close() { panel.hidden = true; stop(); persist(); onClose(); }
  listen(document, 'visibilitychange', () => { if (document.hidden) stop(); else if (!panel.hidden) void check(); });
  listen(window, 'pagehide', dispose);
  function dispose() { if (disposed) return; persist(); disposed = true; stop(); for (const remove of removers) remove(); }
  return { open, close, isBusy, applySnapshot, dispose, setEnabled(value) { enabled = value; if (!value) stop(); render(); } };
}
