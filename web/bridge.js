(() => {
  'use strict';
  if (window.parent === window) return;
  // The classic script URL is server-owned even inside an opaque-origin frame.
  let hostOrigin;
  try { hostOrigin = new URL(document.currentScript.src).origin; } catch { return; }
  let activityRequested = false, interacting = false;
  const reportActivity = () => {
    if (!activityRequested) return;
    const selected = window.getSelection?.();
    const hasSelection = Boolean(selected && !selected.isCollapsed && selected.rangeCount);
    const editing = Boolean(document.activeElement?.matches?.('input,textarea,select,[contenteditable]:not([contenteditable=false])'));
    window.parent.postMessage({ type: 'clawtifact:activity', idle: !interacting && !hasSelection && !editing, selection: hasSelection }, hostOrigin);
  };
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { interacting = true; reportActivity(); }, true);
  for (const type of ['pointerup', 'pointercancel', 'keyup']) document.addEventListener(type, () => { interacting = false; reportActivity(); }, true);
  for (const type of ['focusin', 'focusout', 'input']) document.addEventListener(type, reportActivity, true);
  let queued = false;
  const reportViewport = () => {
    queued = false;
    window.parent.postMessage({ type: 'clawtifact:viewport', scrollX: Math.max(0, window.scrollX), scrollY: Math.max(0, window.scrollY), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }, hostOrigin);
  };
  const queueViewport = () => { if (!queued) { queued = true; requestAnimationFrame(reportViewport); } };
  window.addEventListener('scroll', queueViewport, { passive: true });
  window.addEventListener('resize', queueViewport, { passive: true });
  window.addEventListener('load', reportViewport);
  reportViewport();
  let selectionTimer;
  document.addEventListener('selectionchange', () => {
    reportActivity();
    const current = window.getSelection?.();
    if (activityRequested && (!current || current.isCollapsed)) window.parent.postMessage({ type: 'clawtifact:selection-clear' }, hostOrigin);
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
      const quote = selected.toString();
      if (!quote.trim() || quote.length > 2000) return;
      const range = selected.getRangeAt(0);
      let prefix = '', suffix = '';
      try {
        const before = document.createRange(); before.selectNodeContents(range.startContainer.parentElement || document.body); before.setEnd(range.startContainer, range.startOffset); prefix = before.toString().slice(-200);
        const after = document.createRange(); after.selectNodeContents(range.endContainer.parentElement || document.body); after.setStart(range.endContainer, range.endOffset); suffix = after.toString().slice(0, 200);
      } catch { /* Quote alone remains useful. */ }
      window.parent.postMessage({ type: 'clawtifact:selection', anchor: { type: 'text', quote, prefix, suffix } }, hostOrigin);
    }, 120);
  });
  let marker = null;
  const clear = () => { marker?.remove(); marker = null; window.CSS?.highlights?.delete('clawtifact-feedback'); };
  // Draft decorations belong to the SAME scrolling document as the content.
  // A host-fixed rectangle updated via rAF/postMessage trails compositor scroll
  // on mobile. These inert boxes have constant document-pixel coordinates instead.
  let draftLayer = null, draftRoot = null, draftBoxes = [];
  const sizeDraftMarkers = () => {
    for (const { box, width } of draftBoxes) box.hidden = Math.abs(width - window.innerWidth) > 1;
  };
  window.addEventListener('resize', sizeDraftMarkers, { passive: true });
  const draftMarkers = data => {
    if (typeof data.visible !== 'boolean' || !Array.isArray(data.markers) || data.markers.length > 20) return;
    const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    for (const entry of data.markers) {
      const a = entry?.anchor;
      if (!Number.isInteger(entry?.number) || entry.number < 1 || entry.number > 20 || a?.type !== 'region' || a.scrollKnown !== true || !finite(a.x, 0, 1) || !finite(a.y, 0, 1) || !finite(a.width, Number.MIN_VALUE, 1) || !finite(a.height, Number.MIN_VALUE, 1) || a.x + a.width > 1.000001 || a.y + a.height > 1.000001 || !finite(a.scrollX, 0, 1e7) || !finite(a.scrollY, 0, 1e7) || !finite(a.viewportWidth, 1, 1e5) || !finite(a.viewportHeight, 1, 1e5)) return;
    }
    if (!draftLayer && !data.markers.length) return;
    if (!draftLayer) {
      draftLayer = document.createElement('div'); draftLayer.setAttribute('data-clawtifact-marker', ''); draftLayer.setAttribute('aria-hidden', 'true');
      Object.assign(draftLayer.style, { all: 'initial', position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'visible', pointerEvents: 'none', zIndex: '2147483646' });
      // Keep authored body positioning/styles out of the coordinate plane and
      // decoration styles. This is NOT trusted UI: edits stay in the host tray.
      draftRoot = draftLayer.attachShadow({ mode: 'closed' });
      document.documentElement.append(draftLayer);
    }
    draftLayer.hidden = !data.visible; draftLayer.style.display = data.visible ? 'block' : 'none'; draftRoot.replaceChildren(); draftBoxes = [];
    for (const { number, anchor: a } of data.markers) {
      const box = document.createElement('div'), badge = document.createElement('span'); badge.textContent = `#${number}`;
      Object.assign(box.style, { position: 'absolute', left: `${a.scrollX + a.x * a.viewportWidth}px`, top: `${a.scrollY + a.y * a.viewportHeight}px`, width: `${a.width * a.viewportWidth}px`, height: `${a.height * a.viewportHeight}px`, boxSizing: 'border-box', border: '2px solid #2563eb', background: '#60a5fa18', pointerEvents: 'none' });
      Object.assign(badge.style, { position: 'absolute', left: '0', top: '0', padding: '3px 6px', background: '#1d4ed8', color: '#fff', font: '700 11px system-ui', borderRadius: '0 0 4px 0' });
      box.append(badge); draftRoot.append(box); draftBoxes.push({ box, width: a.viewportWidth });
    }
    sizeDraftMarkers();
  };
  const highlightText = anchor => {
    if (typeof anchor.quote !== 'string' || !anchor.quote || anchor.quote.length > 2000 || typeof anchor.prefix !== 'string' || anchor.prefix.length > 200 || typeof anchor.suffix !== 'string' || anchor.suffix.length > 200) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('script,style,noscript,textarea,input') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = []; let text = '', node;
    while ((node = walker.nextNode()) && text.length < 500000) { nodes.push({ node, offset: text.length }); text += node.textContent; }
    let index = text.indexOf(anchor.quote), fallback = index;
    while (index !== -1) {
      if ((!anchor.prefix || text.slice(Math.max(0, index - anchor.prefix.length), index).endsWith(anchor.prefix)) && (!anchor.suffix || text.slice(index + anchor.quote.length, index + anchor.quote.length + anchor.suffix.length).startsWith(anchor.suffix))) break;
      index = text.indexOf(anchor.quote, index + 1);
    }
    if (index === -1) index = fallback;
    if (index === -1) return;
    const first = nodes.findLast(n => n.offset <= index), last = nodes.findLast(n => n.offset < index + anchor.quote.length);
    if (!first || !last) return;
    const range = document.createRange(); range.setStart(first.node, index - first.offset); range.setEnd(last.node, index + anchor.quote.length - last.offset);
    if (window.CSS?.highlights && typeof Highlight !== 'undefined') {
      const style = document.createElement('style'); style.textContent = '::highlight(clawtifact-feedback){background:#ffe082;color:#111827}'; document.head.append(style);
      window.CSS.highlights.set('clawtifact-feedback', new Highlight(range));
    } else { const selected = window.getSelection(); selected.removeAllRanges(); selected.addRange(range); }
    first.node.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'clawtifact:request-ready') {
      if (event.origin === hostOrigin && typeof event.data.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(event.data.requestId)) window.parent.postMessage({ type: 'clawtifact:ready', requestId: event.data.requestId }, hostOrigin);
      return;
    }
    if (event.data.type === 'clawtifact:request-activity') {
      if (event.origin === hostOrigin) { activityRequested = true; reportActivity(); }
      return;
    }
    if (event.data.type === 'clawtifact:draft-markers') {
      if (event.origin === hostOrigin) draftMarkers(event.data);
      return;
    }
    if (event.data.type === 'clawtifact:hit-test') {
      const { requestId, x, y, viewport } = event.data;
      if (event.origin !== hostOrigin || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId) || !viewport || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return;
      if (viewport.scrollX !== Math.max(0, window.scrollX) || viewport.scrollY !== Math.max(0, window.scrollY) || viewport.viewportWidth !== window.innerWidth || viewport.viewportHeight !== window.innerHeight) return;
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit.closest('[data-clawtifact-marker]')) return;
      const node = hit.closest('button,a,input,textarea,select,label,h1,h2,h3,h4,h5,h6,p,li,figure,svg,canvas,img,video,table,section,article') || hit;
      if (['HTML', 'BODY', 'SCRIPT', 'STYLE'].includes(node.tagName)) return;
      const r = node.getBoundingClientRect();
      if (![r.left, r.top, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return;
      const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(window.innerWidth, r.left + r.width), bottom = Math.min(window.innerHeight, r.top + r.height);
      if (right <= left || bottom <= top) return;
      window.parent.postMessage({ type: 'clawtifact:hit-result', requestId, anchor: { type: 'region', x: left / window.innerWidth, y: top / window.innerHeight, width: (right - left) / window.innerWidth, height: (bottom - top) / window.innerHeight, scrollX: Math.max(0, window.scrollX), scrollY: Math.max(0, window.scrollY), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, scrollKnown: true } }, hostOrigin);
      return;
    }
    if (event.data.type === 'clawtifact:request-viewport') {
      if (event.origin === hostOrigin) reportViewport();
      return;
    }
    if (event.data.type === 'clawtifact:clear') { clear(); return; }
    if (event.data.type !== 'clawtifact:highlight') return;
    clear();
    const anchor = event.data.anchor;
    if (anchor?.type === 'text') { highlightText(anchor); return; }
    if (anchor?.type !== 'region') return;
    const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    if (!finite(anchor.x, 0, 1) || !finite(anchor.y, 0, 1) || !finite(anchor.width, Number.MIN_VALUE, 1) || !finite(anchor.height, Number.MIN_VALUE, 1) || anchor.x + anchor.width > 1.000001 || anchor.y + anchor.height > 1.000001 || !finite(anchor.scrollX, 0, 1e7) || !finite(anchor.scrollY, 0, 1e7) || !finite(anchor.viewportWidth, 1, 1e5) || !finite(anchor.viewportHeight, 1, 1e5)) return;
    marker = document.createElement('div'); marker.setAttribute('aria-hidden', 'true'); marker.setAttribute('data-clawtifact-marker', '');
    if (anchor.scrollKnown !== undefined && typeof anchor.scrollKnown !== 'boolean') return;
    const scrollKnown = anchor.scrollKnown === true;
    const viewportWidth = scrollKnown ? anchor.viewportWidth : window.innerWidth, viewportHeight = scrollKnown ? anchor.viewportHeight : window.innerHeight;
    const left = (scrollKnown ? anchor.scrollX : 0) + anchor.x * viewportWidth, top = (scrollKnown ? anchor.scrollY : 0) + anchor.y * viewportHeight;
    Object.assign(marker.style, { position: scrollKnown ? 'absolute' : 'fixed', pointerEvents: 'none', zIndex: '2147483647', boxSizing: 'border-box', left: `${left}px`, top: `${top}px`, width: `${anchor.width * viewportWidth}px`, height: `${anchor.height * viewportHeight}px`, border: '3px solid #2563eb', background: '#60a5fa33' });
    document.body.append(marker); if (scrollKnown) marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
})();
