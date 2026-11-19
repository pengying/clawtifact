export function cropPixels(region, sourceWidth, sourceHeight, maxSide = 1600) {
  if (![sourceWidth, sourceHeight, maxSide].every(n => Number.isFinite(n) && n >= 1) || sourceWidth > 16000 || sourceHeight > 16000 || sourceWidth * sourceHeight > 32000000) throw new Error('Screenshot dimensions are too large.');
  const { x, y, width, height } = region;
  if (![x,y,width,height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) throw new Error('Choose a crop inside the screenshot.');
  const sx = Math.floor(x * sourceWidth), sy = Math.floor(y * sourceHeight);
  const sw = Math.min(sourceWidth - sx, Math.max(1, Math.floor(width * sourceWidth))), sh = Math.min(sourceHeight - sy, Math.max(1, Math.floor(height * sourceHeight)));
  const scale = Math.min(1, maxSide / sw, maxSide / sh);
  return { sx, sy, sw, sh, width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
}
export function isOwnTab(track, handle) {
  try { return Boolean(handle) && track.getSettings().displaySurface === 'browser' && track.getCaptureHandle?.()?.handle === handle; }
  catch { return false; }
}

export function initializeScreenshots(root, { onApply, onRemove, report, regionForCapture = () => null, onClose = () => {} }) {
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const button = (text, action) => { const node = el('button', '', text); node.type = 'button'; node.addEventListener('click', action); return node; };
  let enabled = false, source = null, sourceWidth = 0, sourceHeight = 0, current = { x: 0, y: 0, width: 1, height: 1 }, disposed = false, activeStream = null, capturing = false;
  const attach = button('Attach screenshot', () => { if (enabled) file.click(); });
  const capture = button('Capture this tab', () => captureTab());
  const remove = button('Remove screenshot', () => { if (enabled) onRemove(); });
  const file = el('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg'; file.hidden = true;
  const view = button('View image', () => { thumbnail.hidden = !thumbnail.hidden; view.textContent = thumbnail.hidden ? 'View image' : 'Hide image'; }); view.hidden = true;
  const thumbnail = el('img', 'af-screenshot-preview'); thumbnail.hidden = true; thumbnail.alt = 'Screenshot crop attached to the current comment';
  const controls = el('div', 'af-screenshot-actions'); controls.append(attach, capture, remove, file, view, thumbnail);
  const dialog = el('section', 'af-crop-dialog'); dialog.hidden = true; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Review screenshot crop');
  const card = el('div', 'af-crop-card');
  const heading = el('h2', '', 'Choose the screenshot crop');
  const explanation = el('p', '', 'Match the crop to your comment. Nothing is uploaded until Send comments. Only the previewed crop is attached.');
  const full = el('canvas', 'af-crop-source'), preview = el('canvas', 'af-crop-preview');
  full.setAttribute('aria-label', 'Local screenshot and crop boundary'); preview.setAttribute('aria-label', 'Only this cropped image will be attached');
  const sliders = el('div', 'af-crop-sliders'), inputs = new Map();
  for (const [key, label] of [['x','Left'], ['y','Top'], ['width','Width'], ['height','Height']]) {
    const wrap = el('label', '', label), input = el('input'); input.type = 'range'; input.min = key === 'x' || key === 'y' ? '0' : '10'; input.max = key === 'x' || key === 'y' ? '990' : '1000'; input.step = '1';
    input.setAttribute('aria-label', label + ' of screenshot crop');
    input.addEventListener('input', () => { current[key] = Number(input.value) / 1000; current.width = Math.min(current.width, 1 - current.x); current.height = Math.min(current.height, 1 - current.y); paint(); });
    wrap.append(input); sliders.append(wrap); inputs.set(key, input);
  }
  const use = button('Use this crop', () => {
    if (!enabled || !source) return;
    try {
      const dataUrl = preview.toDataURL('image/jpeg', .78), data = dataUrl.split(',')[1];
      if (!data || data.length > 1400000) throw new Error('Crop is too large. Choose a smaller area.');
      onApply({ id: crypto.randomUUID().replaceAll('-', ''), data, preview: dataUrl }); close();
    } catch (error) { report(error.message || 'Screenshot crop unavailable.'); }
  });
  const cancel = button('Cancel crop', close);
  card.append(heading, explanation, full, sliders, el('p', '', 'Crop preview — check for private information before attaching:'), preview, use, cancel); dialog.append(card); root.append(dialog);
  function close() {
    dialog.hidden = true; source?.close?.(); source = null; sourceWidth = sourceHeight = 0;
    full.width = full.height = preview.width = preview.height = 1;
    onClose();
  }
  function paint() {
    if (!source) return;
    const crop = cropPixels(current, sourceWidth, sourceHeight);
    for (const [key, input] of inputs) { input.value = String(Math.round(current[key] * 1000)); input.setAttribute('aria-valuetext', Math.round(current[key] * 100) + '%'); }
    const scale = Math.min(1, 600 / sourceWidth, 260 / sourceHeight);
    full.width = Math.max(1, Math.round(sourceWidth * scale)); full.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = full.getContext('2d'); context.drawImage(source, 0, 0, full.width, full.height);
    context.strokeStyle = '#2563eb'; context.lineWidth = 3; context.strokeRect(crop.sx * scale, crop.sy * scale, crop.sw * scale, crop.sh * scale);
    preview.width = crop.width; preview.height = crop.height;
    preview.getContext('2d').drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height);
  }
  function open(image, width, height, initial) {
    if (!enabled || disposed) return;
    cropPixels({ x: 0, y: 0, width: 1, height: 1 }, width, height);
    source?.close?.(); source = image; sourceWidth = width; sourceHeight = height; current = initial ?? { x: 0, y: 0, width: 1, height: 1 };
    paint(); dialog.hidden = false; use.focus();
  }
  file.addEventListener('change', async () => {
    const selected = file.files?.[0]; file.value = '';
    if (!enabled || !selected) return;
    if (!['image/png', 'image/jpeg'].includes(selected.type) || selected.size > 12 * 1024 * 1024) { report('Choose a PNG or JPEG screenshot under 12 MB.'); return; }
    try {
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(selected); });
      const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = dataUrl; });
      open(image, image.naturalWidth, image.naturalHeight);
    } catch { report('This screenshot could not be opened. Choose a PNG or JPEG.'); }
  });
  let captureHandle = '';
  try {
    if (typeof globalThis.navigator?.mediaDevices?.getDisplayMedia === 'function' && typeof globalThis.navigator.mediaDevices.setCaptureHandleConfig === 'function' && typeof globalThis.ImageCapture === 'function') {
      captureHandle = crypto.randomUUID();
      globalThis.navigator.mediaDevices.setCaptureHandleConfig({ exposeOrigin: true, handle: captureHandle, permittedOrigins: [globalThis.location.origin] });
    }
  } catch { captureHandle = ''; }
  capture.hidden = !captureHandle;
  async function captureTab() {
    if (!enabled || !captureHandle || capturing) return;
    capturing = true;
    let bitmap, oldVisibility = root.style.visibility;
    try {
      activeStream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { displaySurface: 'browser' }, preferCurrentTab: true, selfBrowserSurface: 'include', monitorTypeSurfaces: 'exclude', surfaceSwitching: 'exclude' });
      const track = activeStream.getVideoTracks()[0];
      if (!enabled || disposed || !isOwnTab(track, captureHandle)) throw new Error('Select this artifact tab only. Other tabs, windows and screens are not accepted.');
      root.style.visibility = 'hidden';
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      bitmap = await new ImageCapture(track).grabFrame();
      root.style.visibility = oldVisibility;
      open(bitmap, bitmap.width, bitmap.height, regionForCapture());
      // Canvas now owns the preview pixels; retain bitmap only until crop closes.
    } catch (error) { bitmap?.close?.(); report(error.message || 'Capture unavailable. Attach a device screenshot instead.'); }
    finally { root.style.visibility = oldVisibility; activeStream?.getTracks().forEach(track => track.stop()); activeStream = null; capturing = false; }
  }
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll('button,input')].filter(node => !node.disabled);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('pagehide', () => { disposed = true; source?.close?.(); activeStream?.getTracks().forEach(track => track.stop()); activeStream = null; });
  return {
    controls, close,
    setEnabled(value) { enabled = value; attach.disabled = capture.disabled = remove.disabled = !enabled; if (!enabled && !dialog.hidden) close(); },
    show(dataUrl, attached = false) { thumbnail.hidden = true; view.hidden = !dataUrl; view.textContent = 'View image'; if (dataUrl) thumbnail.src = dataUrl; else thumbnail.removeAttribute?.('src'); remove.hidden = !dataUrl && !attached; },
  };
}
