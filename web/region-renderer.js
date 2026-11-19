// Credential-free request/response channel to the existing opaque-origin frame.
const UNAVAILABLE = 'Image unavailable. Attach a screenshot or continue with a region-only comment.';
export function renderAnchor(value) {
  if (!value || value.type !== 'region' || value.scrollKnown !== true) return null;
  const keys = ['x', 'y', 'width', 'height', 'scrollX', 'scrollY', 'viewportWidth', 'viewportHeight'];
  if (keys.some(k => !Number.isFinite(value[k]))) return null;
  const { x, y, width, height, scrollX, scrollY, viewportWidth, viewportHeight } = value;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001 || scrollX < 0 || scrollY < 0 || scrollX > 1e7 || scrollY > 1e7 || viewportWidth < 1 || viewportHeight < 1 || viewportWidth > 4096 || viewportHeight > 4096 || viewportWidth * viewportHeight > 8e6) return null;
  return { type: 'region', x, y, width, height, scrollX, scrollY, viewportWidth, viewportHeight, scrollKnown: true };
}
export function createRegionRenderer(frame, { window: host = globalThis.window, randomUUID = () => crypto.randomUUID(), timeoutMs = 8000 } = {}) {
  let pending = null, disposed = false;
  const cancel = () => { if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.reject(new Error(UNAVAILABLE)); } };
  const receive = event => {
    const data = event.data;
    if (!pending || event.source !== frame.contentWindow || !data || data.type !== 'clawtifact:region-image' || data.requestId !== pending.id) return;
    if (data.ok !== true || typeof data.dataUrl !== 'string' || data.dataUrl.length - 'data:image/jpeg;base64,'.length > 1400000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.dataUrl)) { cancel(); return; }
    const p = pending; pending = null; clearTimeout(p.timer);
    p.resolve({ id: randomUUID().replaceAll('-', ''), data: data.dataUrl.slice('data:image/jpeg;base64,'.length), preview: data.dataUrl, source: 'rendered' });
  };
  host.addEventListener('message', receive); frame.addEventListener('load', cancel);
  return {
    request(value) {
      cancel(); const anchor = renderAnchor(value);
      if (disposed || !anchor || !frame.contentWindow) return Promise.reject(new Error(UNAVAILABLE));
      return new Promise((resolve, reject) => {
        const id = randomUUID(); pending = { id, resolve, reject, timer: setTimeout(cancel, timeoutMs) };
        try { frame.contentWindow.postMessage({ type: 'clawtifact:render-region', requestId: id, anchor }, '*'); } catch { cancel(); }
      });
    },
    cancel,
    dispose() { disposed = true; cancel(); host.removeEventListener?.('message', receive); frame.removeEventListener?.('load', cancel); },
  };
}
