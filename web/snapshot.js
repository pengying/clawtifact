import { toCanvas } from 'html-to-image';
import { cropPixels } from './images.js';
import { renderAnchor } from './region-renderer.js';
const SAME_KEYS = ['scrollX', 'scrollY', 'viewportWidth', 'viewportHeight'];
const viewport = win => ({ scrollX: Math.max(0, win.scrollX), scrollY: Math.max(0, win.scrollY), viewportWidth: win.innerWidth, viewportHeight: win.innerHeight });
const same = (a, b) => SAME_KEYS.every(k => Math.abs(a[k] - b[k]) < .5);
export function snapshotOptions(value, win, documentHeight) {
  const a = renderAnchor(value);
  if (!a || !same(a, viewport(win)) || !Number.isFinite(documentHeight) || documentHeight < 1 || documentHeight > 1e6) throw new Error('Image unavailable');
  const crop = cropPixels(a, a.viewportWidth, a.viewportHeight);
  return {
    width: crop.sw, height: crop.sh, canvasWidth: crop.width, canvasHeight: crop.height,
    pixelRatio: 1, skipFonts: true, skipAutoScale: true, backgroundColor: '#ffffff',
    style: { width: `${a.viewportWidth}px`, height: `${documentHeight}px`, transform: `translate(-${a.scrollX + crop.sx}px, -${a.scrollY + crop.sy}px)`, transformOrigin: 'top left', margin: '0' },
    filter: node => !['SCRIPT', 'STYLE', 'LINK', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'NOSCRIPT'].includes(node.tagName) && !node.hasAttribute?.('data-clawtifact-marker') && !(node.tagName === 'IMG' && !node.getAttribute('src')),
  };
}
export function assertSnapshotLayout(doc, win) {
  const walker = doc.createTreeWalker(doc.documentElement, 1); let node, count = 0;
  while ((node = walker.nextNode())) {
    if (++count > 20000) throw new Error('Image unavailable: document too large');
    if (node === doc.scrollingElement) continue;
    if (node.scrollTop || node.scrollLeft) throw new Error('Image unavailable: nested scrolling');
    if (win.scrollX || win.scrollY) {
      const position = win.getComputedStyle(node).position;
      if (position === 'fixed' || position === 'sticky') throw new Error('Image unavailable: viewport-dependent layout');
    }
  }
}
export async function renderRegion(anchor, { document: doc = document, window: win = window, render = toCanvas } = {}) {
  const root = doc.documentElement;
  const options = snapshotOptions(anchor, win, Math.max(root.scrollHeight, win.innerHeight));
  assertSnapshotLayout(doc, win);
  if ((root.textContent?.length ?? 0) > 2e6) throw new Error('Image unavailable');
  let changed = false;
  const observer = new MutationObserver(() => { changed = true; });
  const markChanged = () => { changed = true; };
  doc.addEventListener('scroll', markChanged, true);
  observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  try {
    const canvas = await render(root, options);
    assertSnapshotLayout(doc, win);
    if (changed) throw new Error('Image unavailable: content changed during rendering');
    if (!same(anchor, viewport(win))) throw new Error('Image unavailable: viewport changed during rendering');
    const dataUrl = canvas.toDataURL('image/jpeg', .78);
    if (dataUrl.length - 'data:image/jpeg;base64,'.length > 1400000 || !dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Image unavailable');
    return dataUrl;
  } finally { observer.disconnect(); doc.removeEventListener('scroll', markChanged, true); }
}
export function initializeSnapshotBridge({ window: win = window, origin, render = renderRegion } = {}) {
  if (win.parent === win || !origin) return;
  let busy = false, disposed = false;
  const receive = async event => {
    const data = event.data;
    if (disposed || event.source !== win.parent || event.origin !== origin || !data || data.type !== 'clawtifact:render-region' || typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId) || !renderAnchor(data.anchor)) return;
    const requestId = data.requestId;
    const reply = result => { if (!disposed) win.parent.postMessage({ type: 'clawtifact:region-image', requestId, ...result }, origin); };
    if (busy) { reply({ ok: false }); return; }
    busy = true;
    try { reply({ ok: true, dataUrl: await render(data.anchor) }); }
    catch { reply({ ok: false }); }
    finally { busy = false; }
  };
  win.addEventListener('message', receive);
  win.addEventListener('pagehide', () => { disposed = true; win.removeEventListener?.('message', receive); });
}
