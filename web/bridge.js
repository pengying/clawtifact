(() => {
  'use strict';
  if (window.parent === window) return;
  // The classic script URL is server-owned even inside an opaque-origin frame.
  let hostOrigin;
  try { hostOrigin = new URL(document.currentScript.src).origin; } catch { return; }
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
    if (event.data.type === 'clawtifact:clear') { clear(); return; }
    if (event.data.type !== 'clawtifact:highlight') return;
    clear();
    const anchor = event.data.anchor;
    if (anchor?.type === 'text') { highlightText(anchor); return; }
    if (anchor?.type !== 'region') return;
    const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
    if (!finite(anchor.x, 0, 1) || !finite(anchor.y, 0, 1) || !finite(anchor.width, Number.MIN_VALUE, 1) || !finite(anchor.height, Number.MIN_VALUE, 1) || anchor.x + anchor.width > 1.000001 || anchor.y + anchor.height > 1.000001 || !finite(anchor.scrollX, 0, 1e7) || !finite(anchor.scrollY, 0, 1e7) || !finite(anchor.viewportWidth, 1, 1e5) || !finite(anchor.viewportHeight, 1, 1e5)) return;
    marker = document.createElement('div'); marker.setAttribute('aria-hidden', 'true');
    if (anchor.scrollKnown !== undefined && typeof anchor.scrollKnown !== 'boolean') return;
    const scrollKnown = anchor.scrollKnown === true;
    const viewportWidth = scrollKnown ? anchor.viewportWidth : window.innerWidth, viewportHeight = scrollKnown ? anchor.viewportHeight : window.innerHeight;
    const left = (scrollKnown ? anchor.scrollX : 0) + anchor.x * viewportWidth, top = (scrollKnown ? anchor.scrollY : 0) + anchor.y * viewportHeight;
    Object.assign(marker.style, { position: scrollKnown ? 'absolute' : 'fixed', pointerEvents: 'none', zIndex: '2147483647', boxSizing: 'border-box', left: `${left}px`, top: `${top}px`, width: `${anchor.width * viewportWidth}px`, height: `${anchor.height * viewportHeight}px`, border: '3px solid #2563eb', background: '#60a5fa33' });
    document.body.append(marker); if (scrollKnown) marker.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
})();
