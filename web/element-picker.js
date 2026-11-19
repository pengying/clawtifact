import { renderAnchor } from './region-renderer.js';
// Hit-test hints are untrusted geometry, never commands or identity. Only a
// matching parent-initiated query may yield a selection candidate.
export function createElementPicker(frame, { window: host = globalThis.window, randomUUID = () => crypto.randomUUID(), timeoutMs = 700 } = {}) {
  let pending = null, disposed = false;
  const cancel = () => { if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.resolve(null); } };
  const receive = event => {
    const data = event.data;
    if (!pending || event.source !== frame.contentWindow || data?.type !== 'clawtifact:hit-result' || data.requestId !== pending.id) return;
    const anchor = renderAnchor(data.anchor), p = pending;
    if (!anchor || ['scrollX', 'scrollY', 'viewportWidth', 'viewportHeight'].some(key => anchor[key] !== p.viewport[key])) return;
    const x = p.point.x / anchor.viewportWidth, y = p.point.y / anchor.viewportHeight;
    if (x < anchor.x - 1e-6 || y < anchor.y - 1e-6 || x > anchor.x + anchor.width + 1e-6 || y > anchor.y + anchor.height + 1e-6) return;
    pending = null; clearTimeout(p.timer); p.resolve(anchor);
  };
  host.addEventListener('message', receive); frame.addEventListener('load', cancel);
  return {
    request(point, viewport) {
      cancel();
      const full = renderAnchor({ type: 'region', x: 0, y: 0, width: 1, height: 1, ...viewport, scrollKnown: true });
      if (disposed || !frame.contentWindow || !full || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= full.viewportWidth || point.y >= full.viewportHeight) return Promise.resolve(null);
      return new Promise(resolve => {
        const id = randomUUID(); pending = { id, resolve, point: { ...point }, viewport: full, timer: setTimeout(cancel, timeoutMs) };
        try { frame.contentWindow.postMessage({ type: 'clawtifact:hit-test', requestId: id, x: point.x, y: point.y, viewport: { scrollX: full.scrollX, scrollY: full.scrollY, viewportWidth: full.viewportWidth, viewportHeight: full.viewportHeight } }, '*'); } catch { cancel(); }
      });
    },
    cancel,
    dispose() { disposed = true; cancel(); host.removeEventListener?.('message', receive); frame.removeEventListener?.('load', cancel); },
  };
}
