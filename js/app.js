import {
  FONT, LINE_HEIGHT, bbox, boxHandles, clone, contrastColor, dragBox, handlesOf, hitObject,
  normBox, renderDoc, resize, snapAngle, textMetrics, textPad, translate, visualBox,
} from './objects.js';

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const mainCv = $('#main');
const mainCtx = mainCv.getContext('2d');
const overlayCv = $('#overlay');
const overlayCtx = overlayCv.getContext('2d');
const editor = $('#textEditor');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl';
const ACCENT = '#4c8dff';
const MAX_HISTORY = 100;
const MAX_CANVAS_SIDE = 16000;
// Annotations reaching past the image grow the output to fit them, plus this margin (UI units).
const MARGIN = 32;
// Overhang smaller than this (UI units) is clipped as before, so a box hugging the edge
// does not suddenly add a border.
const OVERFLOW_TOL = 6;
const AUTO_COPY_DELAY = 300;

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* storage unavailable */ }
}

const RED = '#ef4444';
const PALETTE = [RED, '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#111111', '#ffffff'];

// `size` values here are UI units; objects store real pixels (UI value x doc.unit).
const TOOLS = {
  select: { label: '選取', key: 'V', icon: 'select', hint: '點選物件來移動、縮放或改樣式，Shift 拖曳控制點鎖定比例，雙擊文字可編輯' },
  crop: { label: '裁切', key: 'C', icon: 'crop', hint: '拖曳框選範圍，Enter 套用，Esc 取消' },
  sep1: null,
  arrow: { label: '箭頭', key: 'A', icon: 'arrow', color: RED, size: 4, sizeRange: [1, 30], sizeLabel: '粗細', hint: 'Shift 鎖定 45° 角' },
  line: { label: '直線', key: 'L', icon: 'line', color: RED, size: 4, sizeRange: [1, 30], sizeLabel: '粗細', hint: 'Shift 鎖定 45° 角' },
  rect: { label: '方框', key: 'R', icon: 'rect', color: RED, size: 4, sizeRange: [1, 30], sizeLabel: '粗細', fill: false, hint: 'Shift 畫正方形' },
  ellipse: { label: '橢圓', key: 'O', icon: 'ellipse', color: RED, size: 4, sizeRange: [1, 30], sizeLabel: '粗細', fill: false, hint: 'Shift 畫正圓' },
  pen: { label: '畫筆', key: 'P', icon: 'pen', color: RED, size: 4, sizeRange: [1, 30], sizeLabel: '粗細', hint: 'Shift 畫直線' },
  highlight: { label: '螢光筆', key: 'H', icon: 'highlight', color: '#facc15', size: 20, sizeRange: [4, 80], sizeLabel: '粗細', hint: 'Shift 畫直線' },
  text: { label: '文字', key: 'T', icon: 'text', color: RED, size: 24, sizeRange: [8, 120], sizeLabel: '大小', fill: false, fillLabel: '標籤底色', hint: `點一下輸入，${MOD} Enter 或 Esc 完成` },
  step: { label: '步驟編號', key: 'N', icon: 'step', color: RED, size: 16, sizeRange: [8, 60], sizeLabel: '大小', hint: '點一下放置，編號自動遞增' },
  sep2: null,
  redact: { label: '塗黑', key: 'X', icon: 'redact', color: '#111111', hint: '遮密碼、金鑰等敏感資料請用這個，無法還原' },
  mosaic: { label: '馬賽克', key: 'M', icon: 'mosaic', size: 12, sizeRange: [4, 60], sizeLabel: '格子', hint: '格子太小可能被辨識，機密資料請改用塗黑' },
  blur: { label: '模糊', key: 'B', icon: 'blur', size: 14, sizeRange: [3, 60], sizeLabel: '強度', hint: '機密資料請改用塗黑' },
  spotlight: { label: '聚光', key: 'S', icon: 'spotlight', hint: '框出重點，其他區域會變暗' },
};
const DRAW_LINE = new Set(['arrow', 'line']);
const DRAW_STROKE = new Set(['pen', 'highlight']);
const DRAW_BOX = new Set(['rect', 'ellipse', 'redact', 'mosaic', 'blur', 'spotlight']);

const styles = Object.fromEntries(
  Object.entries(TOOLS)
    .filter(([id, t]) => t && id !== 'select' && id !== 'crop')
    .map(([k, t]) => [k, { color: t.color, size: t.size, fill: t.fill }]),
);

const S = {
  doc: null,
  tool: 'arrow',
  toolBeforeCrop: 'arrow',
  selected: null,
  draft: null,
  drag: null,
  crop: null,
  cropAspect: null,
  editing: null,
  editingIsNew: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  autoFit: true,
  history: [],
  hIndex: -1,
  loadEntry: null,
  exportEntry: null,
  space: false,
  pinch: null,
  autoCopy: loadPref('autoCopy', true),
  bounds: null,
};
const pointers = new Map();

/* ---------- helpers ---------- */

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('匯出失敗'))), type, quality);
  });
}

async function blobToCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('empty image');
    if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE) throw new Error('too large');
    const c = newCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

let toastTimer = 0;
function toast(msg, { action, label, error = false, ms = 3000 } = {}) {
  const el = $('#toast');
  el.textContent = '';
  el.className = error ? 'toast error' : 'toast';
  el.append(msg);
  if (action) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => { el.hidden = true; action(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}

/* ---------- history ---------- */

function snapshot() {
  const { w, h, base, unit, objects } = S.doc;
  return { w, h, base, unit, objects: objects.map(clone) };
}

function commit() {
  S.history.length = S.hIndex + 1;
  S.history.push(snapshot());
  if (S.history.length > MAX_HISTORY) S.history.shift();
  S.hIndex = S.history.length - 1;
  syncUI();
  invalidate();
}

/** Commit for an edit made with the left-hand tools; only these trigger auto copy. */
function edited() {
  commit();
  scheduleAutoCopy();
}

function restore(entry) {
  closeEditor();
  const prev = S.doc;
  S.doc = { ...entry, objects: entry.objects.map(clone) };
  S.selected = null;
  S.draft = null;
  S.crop = null;
  if (S.tool === 'crop') S.tool = S.toolBeforeCrop;
  if (!prev || prev.w !== S.doc.w || prev.h !== S.doc.h) fit();
  syncUI();
  invalidate();
}

function undo() {
  if (S.hIndex > 0) restore(S.history[--S.hIndex]);
}

function redo() {
  if (S.hIndex < S.history.length - 1) restore(S.history[++S.hIndex]);
}

function isClean() {
  const cur = S.history[S.hIndex];
  return cur === S.loadEntry || cur === S.exportEntry;
}

/* ---------- loading images ---------- */

function setBase(canvas) {
  closeEditor();
  S.doc = {
    w: canvas.width,
    h: canvas.height,
    base: canvas,
    unit: Math.max(1, Math.max(canvas.width, canvas.height) / 1600),
    objects: [],
  };
  S.selected = null;
  S.crop = null;
  if (S.tool === 'crop') S.tool = S.toolBeforeCrop;
  fit();
  commit();
  S.loadEntry = S.history[S.hIndex];
}

function addOverlayImage(canvas) {
  const { w, h } = S.doc;
  const s = Math.min(1, (w * 0.8) / canvas.width, (h * 0.8) / canvas.height);
  const iw = canvas.width * s;
  const ih = canvas.height * s;
  const o = { type: 'image', img: canvas, x: (w - iw) / 2, y: (h - ih) / 2, w: iw, h: ih };
  S.doc.objects.push(o);
  S.selected = o;
  setTool('select', true);
  commit();
}

function receiveImage(canvas, mode) {
  if (!S.doc || mode === 'replace') setBase(canvas);
  else addOverlayImage(canvas);
}

/**
 * Asks whether a pasted image starts a new document or joins the current one.
 * Resolves to 'replace', 'overlay', or '' when cancelled. The suggested choice is
 * focused so Enter takes it: a new image when nothing is unsaved, else a layer.
 */
function askPasteMode(canvas) {
  const dlg = $('#dlgPaste');
  const pv = $('#pastePreview');
  const s = Math.min(1, 360 / canvas.width, 160 / canvas.height);
  pv.width = Math.max(1, Math.round(canvas.width * s));
  pv.height = Math.max(1, Math.round(canvas.height * s));
  pv.getContext('2d').drawImage(canvas, 0, 0, pv.width, pv.height);

  const own = isOwnOutput(canvas);
  const note = $('#pasteNote');
  note.textContent = own ? '剪貼簿裡是目前的編輯結果，可能還沒截新圖。' : '要開新圖，還是疊在目前的圖上？';
  note.classList.toggle('warn', own);

  const suggested = isClean() ? 'replace' : 'overlay';
  dlg.querySelectorAll('.choice').forEach((b) => b.classList.toggle('suggested', !own && b.value === suggested));
  openDialog(dlg);
  (own ? dlg.querySelector('[data-close]') : dlg.querySelector(`.choice[value="${suggested}"]`)).focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
  });
}

/** True if `c` is pixel-identical to what we last put on the clipboard (auto copy makes this common). */
function isOwnOutput(c) {
  if (!S.doc || S.history[S.hIndex] !== S.exportEntry) return false;
  renderNow();
  if (c.width !== mainCv.width || c.height !== mainCv.height) return false;
  const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const b = mainCtx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < a.length; i += 4 * 61) {
    for (let k = 0; k < 4; k++) if (Math.abs(a[i + k] - b[i + k]) > 2) return false;
  }
  return true;
}

async function receiveBlobs(blobs, mode = 'ask') {
  let first = true;
  for (const blob of blobs) {
    try {
      const c = await blobToCanvas(blob);
      if (first && mode === 'ask' && S.doc) {
        mode = await askPasteMode(c);
        if (!mode) return;
      }
      receiveImage(c, first ? mode : 'overlay');
      first = false;
    } catch (err) {
      toast(err.message === 'too large' ? `影像超過 ${MAX_CANVAS_SIDE}px 上限` : '無法讀取這個影像', { error: true });
    }
  }
}

async function pasteFromButton() {
  if (!navigator.clipboard?.read) {
    toast(`這個瀏覽器不支援按鈕貼上，請按 ${MOD} V`);
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    const blobs = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) blobs.push(await item.getType(type));
    }
    if (!blobs.length) toast('剪貼簿裡沒有影像');
    else await receiveBlobs(blobs);
  } catch {
    toast(`無法讀取剪貼簿，請按 ${MOD} V 或允許權限`, { error: true });
  }
}

/* ---------- view ---------- */

function applyView() {
  mainCv.classList.toggle('pixelated', S.zoom >= 2);
  $('#zoomLabel').textContent = `${Math.round(S.zoom * 100)}%`;
  invalidate();
}

/**
 * The output area in document coordinates: the image, grown to cover any annotation that
 * reaches past it (plus a margin). The image always sits at (0, 0).
 */
function bounds() {
  const { w, h, unit, objects } = S.doc;
  const list = S.draft ? [...objects, S.draft] : objects;
  const tol = OVERFLOW_TOL * unit;
  const overflows = list.some((o) => {
    const b = bbox(o);
    return b.x < -tol || b.y < -tol || b.x + b.w > w + tol || b.y + b.h > h + tol;
  });
  if (!overflows) return { x: 0, y: 0, w, h };
  let x0 = 0, y0 = 0, x1 = w, y1 = h;
  for (const o of list) {
    const v = visualBox(o);
    x0 = Math.min(x0, v.x);
    y0 = Math.min(y0, v.y);
    x1 = Math.max(x1, v.x + v.w);
    y1 = Math.max(y1, v.y + v.h);
  }
  const m = MARGIN * unit;
  x0 = Math.floor(x0 - m);
  y0 = Math.floor(y0 - m);
  x1 = Math.min(Math.ceil(x1 + m), x0 + MAX_CANVAS_SIDE);
  y1 = Math.min(Math.ceil(y1 + m), y0 + MAX_CANVAS_SIDE);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The area outside the image is painted with the stage colour, so the output looks like the editor.
let stageColor = '';
function stageBg() {
  if (!stageColor) stageColor = getComputedStyle(stage).backgroundColor;
  return stageColor;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  stageColor = '';
  invalidate();
});

function fit() {
  if (!S.doc) return;
  const b = bounds();
  const m = 28;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  S.zoom = Math.min((sw - m * 2) / b.w, (sh - m * 2) / b.h, 1) || 1;
  S.panX = (sw - b.w * S.zoom) / 2 - b.x * S.zoom;
  S.panY = (sh - b.h * S.zoom) / 2 - b.y * S.zoom;
  S.autoFit = true;
  applyView();
}

function zoomAt(zoom, cx, cy) {
  const z = Math.min(16, Math.max(0.05, zoom));
  S.panX = cx - ((cx - S.panX) / S.zoom) * z;
  S.panY = cy - ((cy - S.panY) / S.zoom) * z;
  S.zoom = z;
  S.autoFit = false;
  applyView();
}

function zoomCenter(factor) {
  zoomAt(S.zoom * factor, stage.clientWidth / 2, stage.clientHeight / 2);
}

function toggleZoom() {
  if (Math.abs(S.zoom - 1) < 0.001) {
    fit();
  } else {
    zoomAt(1, stage.clientWidth / 2, stage.clientHeight / 2);
  }
}

function toDoc(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left - S.panX) / S.zoom, y: (e.clientY - r.top - S.panY) / S.zoom };
}

/* ---------- rendering ---------- */

let raf = 0;
function invalidate() {
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderNow(); });
}

function renderNow() {
  if (S.doc) {
    const b = bounds();
    S.bounds = b;
    if (mainCv.width !== b.w || mainCv.height !== b.h) {
      mainCv.width = b.w;
      mainCv.height = b.h;
      $('#dims').textContent = `${b.w} × ${b.h}`;
    }
    mainCv.style.transform = `translate(${S.panX + b.x * S.zoom}px, ${S.panY + b.y * S.zoom}px) scale(${S.zoom})`;
    mainCv.dataset.x = b.x;
    mainCv.dataset.y = b.y;
    renderDoc(mainCtx, S.doc, S.draft ? [S.draft] : [], S.editing, { ...b, bg: stageBg() });
  }
  drawOverlay();
  positionEditor();
}

function drawHandle(c, x, y) {
  c.fillStyle = '#ffffff';
  c.strokeStyle = ACCENT;
  c.lineWidth = 1.5;
  c.beginPath();
  c.rect(x - 4.5, y - 4.5, 9, 9);
  c.fill();
  c.stroke();
}

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (overlayCv.width !== Math.round(W * dpr) || overlayCv.height !== Math.round(H * dpr)) {
    overlayCv.width = Math.round(W * dpr);
    overlayCv.height = Math.round(H * dpr);
  }
  const c = overlayCtx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  if (!S.doc) return;
  const sx = (x) => S.panX + x * S.zoom;
  const sy = (y) => S.panY + y * S.zoom;

  if (S.tool === 'crop' && S.crop) {
    const b = S.crop;
    const B = S.bounds;
    const x = sx(b.x), y = sy(b.y), w = b.w * S.zoom, h = b.h * S.zoom;
    c.fillStyle = 'rgba(0, 0, 0, .6)';
    c.beginPath();
    c.rect(sx(B.x), sy(B.y), B.w * S.zoom, B.h * S.zoom);
    c.rect(x, y, w, h);
    c.fill('evenodd');
    c.strokeStyle = 'rgba(255, 255, 255, .35)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < 3; i++) {
      c.moveTo(x + (w * i) / 3, y);
      c.lineTo(x + (w * i) / 3, y + h);
      c.moveTo(x, y + (h * i) / 3);
      c.lineTo(x + w, y + (h * i) / 3);
    }
    c.stroke();
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1.5;
    c.strokeRect(x, y, w, h);
    for (const hd of boxHandles(b, !!S.cropAspect)) drawHandle(c, sx(hd.x), sy(hd.y));
  }

  const o = S.selected;
  if (o && o !== S.editing) {
    const lineLike = o.type === 'arrow' || o.type === 'line';
    if (!lineLike) {
      const b = bbox(o);
      c.strokeStyle = ACCENT;
      c.lineWidth = 1.5;
      c.setLineDash([5, 4]);
      c.strokeRect(sx(b.x), sy(b.y), b.w * S.zoom, b.h * S.zoom);
      c.setLineDash([]);
    }
    for (const hd of handlesOf(o)) drawHandle(c, sx(hd.x), sy(hd.y));
  }
}

/* ---------- objects ---------- */

function hitTop(x, y, tol) {
  const list = S.doc.objects;
  for (let i = list.length - 1; i >= 0; i--) {
    if (hitObject(list[i], x, y, tol)) return list[i];
  }
  return null;
}

function hitHandle(handles, x, y, tol) {
  return handles.find((h) => Math.abs(h.x - x) <= tol && Math.abs(h.y - y) <= tol) || null;
}

function nextStep() {
  return S.doc.objects.reduce((n, o) => (o.type === 'step' ? Math.max(n, o.n) : n), 0) + 1;
}

function renumberSteps() {
  S.doc.objects
    .filter((o) => o.type === 'step')
    .sort((a, b) => a.n - b.n)
    .forEach((o, i) => { o.n = i + 1; });
}

function deleteSelected() {
  const o = S.selected;
  if (!o) return;
  S.doc.objects.splice(S.doc.objects.indexOf(o), 1);
  if (o.type === 'step') renumberSteps();
  S.selected = null;
  edited();
}

function duplicateSelected() {
  const o = S.selected;
  if (!o) return;
  const d = clone(o);
  const off = 16 * S.doc.unit;
  translate(d, clone(o), off, off);
  if (d.type === 'step') d.n = nextStep();
  S.doc.objects.push(d);
  S.selected = d;
  edited();
}

function reorderSelected(toFront) {
  const o = S.selected;
  if (!o) return;
  const list = S.doc.objects;
  list.splice(list.indexOf(o), 1);
  if (toFront) list.push(o);
  else list.unshift(o);
  edited();
}

function newObject(tool, x, y) {
  const st = styles[tool];
  const o = { type: tool, color: st.color, size: (st.size || 0) * S.doc.unit };
  if (st.fill !== undefined) o.fill = st.fill;
  if (DRAW_LINE.has(tool)) Object.assign(o, { x1: x, y1: y, x2: x, y2: y });
  else if (DRAW_STROKE.has(tool)) o.points = [[x, y]];
  else Object.assign(o, { x, y, w: 0, h: 0 });
  return o;
}

function finishDraft() {
  const o = S.draft;
  S.draft = null;
  if (!o) return;
  if (DRAW_BOX.has(o.type)) Object.assign(o, normBox(o));
  S.doc.objects.push(o);
  S.selected = o;
  edited();
}

function updateDraft(pos, shift) {
  const o = S.draft;
  if (DRAW_LINE.has(o.type)) {
    const [x, y] = shift ? snapAngle(o.x1, o.y1, pos.x, pos.y) : [pos.x, pos.y];
    o.x2 = x;
    o.y2 = y;
  } else if (DRAW_STROKE.has(o.type)) {
    if (shift) {
      const [x, y] = snapAngle(o.points[0][0], o.points[0][1], pos.x, pos.y);
      o.points = [o.points[0], [x, y]];
    } else {
      o.points.push([pos.x, pos.y]);
    }
  } else {
    let w = pos.x - o.x;
    let h = pos.y - o.y;
    if (shift) {
      const side = Math.max(Math.abs(w), Math.abs(h));
      w = side * Math.sign(w || 1);
      h = side * Math.sign(h || 1);
    }
    o.w = w;
    o.h = h;
  }
}

/* ---------- text editor ---------- */

function openEditor(o, isNew) {
  S.editing = o;
  S.editingIsNew = isNew;
  S.selected = o;
  editor.value = o.text;
  editor.hidden = false;
  syncOptions();
  renderNow();
  editor.focus();
  editor.select();
}

function positionEditor() {
  const o = S.editing;
  if (!o) return;
  const z = S.zoom;
  const m = textMetrics(editor.value || ' ', o.size);
  const pad = textPad(o) * z;
  Object.assign(editor.style, {
    left: `${S.panX + o.x * z - pad}px`,
    top: `${S.panY + o.y * z - pad}px`,
    padding: `${pad}px`,
    width: `${m.w * z + o.size * z}px`,
    height: `${m.h * z}px`,
    fontSize: `${o.size * z}px`,
    fontFamily: FONT,
    lineHeight: String(LINE_HEIGHT),
    color: o.fill ? contrastColor(o.color) : o.color,
    background: o.fill ? o.color : 'transparent',
    borderRadius: `${o.size * 0.22 * z}px`,
  });
}

/** Commits the open text editor. Returns true if an editor was open. */
function finishText() {
  const o = S.editing;
  if (!o) return false;
  const text = editor.value.replace(/\s+$/, '');
  const changed = text !== o.text;
  o.text = text;
  const wasNew = S.editingIsNew;
  closeEditor();
  if (!text) {
    S.doc.objects.splice(S.doc.objects.indexOf(o), 1);
    S.selected = null;
    if (!wasNew) edited();
  } else if (changed || wasNew) {
    edited();
  }
  syncOptions();
  invalidate();
  return true;
}

function closeEditor() {
  S.editing = null;
  editor.hidden = true;
}

editor.addEventListener('blur', () => finishText());
editor.addEventListener('input', positionEditor);
editor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.isComposing) return;
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    editor.blur();
  }
});

/* ---------- crop ---------- */

// Crop works on the whole output area, which may be larger than the image.
function clampToBounds(x, y) {
  const B = bounds();
  return [Math.min(B.x + B.w, Math.max(B.x, x)), Math.min(B.y + B.h, Math.max(B.y, y))];
}

function clampCropMove(b) {
  const B = bounds();
  return {
    ...b,
    x: Math.min(Math.max(B.x, b.x), B.x + B.w - b.w),
    y: Math.min(Math.max(B.y, b.y), B.y + B.h - b.h),
  };
}

function cropFromDrag(ax, ay, px, py, aspect = S.cropAspect) {
  const B = bounds();
  let dx = px - ax;
  let dy = py - ay;
  const maxX = dx >= 0 ? B.x + B.w - ax : ax - B.x;
  const maxY = dy >= 0 ? B.y + B.h - ay : ay - B.y;
  if (aspect) {
    let w = Math.max(Math.abs(dx), Math.abs(dy) * aspect);
    w = Math.min(w, maxX, maxY * aspect);
    dx = Math.sign(dx || 1) * w;
    dy = Math.sign(dy || 1) * (w / aspect);
  } else {
    dx = Math.sign(dx) * Math.min(Math.abs(dx), maxX);
    dy = Math.sign(dy) * Math.min(Math.abs(dy), maxY);
  }
  return normBox({ x: ax, y: ay, w: dx, h: dy });
}

function setCropAspect(aspect) {
  S.cropAspect = aspect;
  document.querySelectorAll('#cropAspects button').forEach((b) => {
    b.classList.toggle('on', (Number(b.dataset.aspect) || null) === aspect);
  });
  if (aspect && S.crop) {
    const b = S.crop;
    const w = Math.min(b.w, b.h * aspect);
    const h = w / aspect;
    S.crop = { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
  }
  syncOptions();
  invalidate();
}

function applyCrop() {
  const c = S.crop;
  if (!c) return false;
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  const w = Math.round(c.w);
  const h = Math.round(c.h);
  if (w < 1 || h < 1) return false;
  const tol = OVERFLOW_TOL * S.doc.unit;
  const fits = (b) => b.x >= x - tol && b.y >= y - tol && b.x + b.w <= x + w + tol && b.y + b.h <= y + h + tol;
  const misses = (b) => b.x >= x + w || b.y >= y + h || b.x + b.w <= x || b.y + b.h <= y;
  // An annotation cut by the crop edge would grow the output again, so it is baked into the
  // image, together with everything beneath it to keep the stacking order. The rest stay editable.
  const all = S.doc.objects;
  let cut = -1;
  all.forEach((o, i) => {
    if (!fits(bbox(o)) && !misses(visualBox(o))) cut = i;
  });
  const base = newCanvas(w, h);
  renderDoc(base.getContext('2d'), { ...S.doc, objects: all.slice(0, cut + 1) }, [], null, { x, y, w, h, bg: stageBg() });
  const objects = all.slice(cut + 1).filter((o) => !misses(visualBox(o)));
  objects.forEach((o) => translate(o, clone(o), -x, -y));
  S.doc = { ...S.doc, w, h, base, objects };
  S.crop = null;
  S.selected = null;
  S.tool = S.toolBeforeCrop;
  fit();
  edited();
  return true;
}

function cancelCrop() {
  S.crop = null;
  setTool(S.toolBeforeCrop);
}

/* ---------- image operations (these flatten annotations into the base) ---------- */

function flattened() {
  renderNow();
  const c = newCanvas(mainCv.width, mainCv.height);
  c.getContext('2d').drawImage(mainCv, 0, 0);
  return c;
}

function replaceBase(canvas) {
  S.doc = { ...S.doc, w: canvas.width, h: canvas.height, base: canvas, objects: [] };
  S.selected = null;
  S.crop = null;
  fit();
  commit();
}

function transformImage(op) {
  finishPending();
  const src = flattened();
  const { width: w, height: h } = src;
  const swap = op.startsWith('rotate');
  const c = newCanvas(swap ? h : w, swap ? w : h);
  const x = c.getContext('2d');
  if (op === 'rotate-cw') { x.translate(h, 0); x.rotate(Math.PI / 2); }
  if (op === 'rotate-ccw') { x.translate(0, w); x.rotate(-Math.PI / 2); }
  if (op === 'flip-h') { x.translate(w, 0); x.scale(-1, 1); }
  if (op === 'flip-v') { x.translate(0, h); x.scale(1, -1); }
  x.drawImage(src, 0, 0);
  replaceBase(c);
}

function resizeImage(w, h) {
  const src = flattened();
  const c = newCanvas(w, h);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, w, h);
  replaceBase(c);
}

function frameImage({ pad, radius, color, transparent, shadow }) {
  const src = flattened();
  const c = newCanvas(src.width + pad * 2, src.height + pad * 2);
  const x = c.getContext('2d');
  if (!transparent) {
    x.fillStyle = color;
    x.fillRect(0, 0, c.width, c.height);
  }
  const path = new Path2D();
  path.roundRect(pad, pad, src.width, src.height, radius);
  if (shadow && pad > 0) {
    x.save();
    x.shadowColor = 'rgba(0, 0, 0, .35)';
    x.shadowBlur = pad * 0.6;
    x.shadowOffsetY = pad * 0.15;
    x.fillStyle = '#000';
    x.fill(path);
    x.restore();
  }
  x.save();
  x.clip(path);
  // Clear under the clip so transparent source pixels are not tinted by the shadow fill.
  x.clearRect(pad, pad, src.width, src.height);
  if (!transparent) {
    x.fillStyle = color;
    x.fillRect(pad, pad, src.width, src.height);
  }
  x.drawImage(src, pad, pad);
  x.restore();
  replaceBase(c);
}

/* ---------- export ---------- */

function finishPending() {
  finishText();
  if (S.tool === 'crop') {
    if (!applyCrop()) cancelCrop();
  }
}

/** The copy button reads "已複製" while the clipboard holds the current result. */
function syncCopyState() {
  const copied = !!S.doc && S.history[S.hIndex] === S.exportEntry;
  $('#btnCopy').classList.toggle('done', copied);
  $('#copyIcon use').setAttribute('href', copied ? '#i-check' : '#i-copy');
  $('#copyLabel').textContent = copied ? '已複製' : '複製';
}

let autoCopyTimer = 0;
let autoCopyWarned = false;

function scheduleAutoCopy() {
  clearTimeout(autoCopyTimer);
  if (!S.autoCopy) return;
  autoCopyTimer = setTimeout(() => {
    const cur = S.history[S.hIndex];
    // A freshly loaded image is already on the clipboard; mid-gesture states are not final.
    if (!S.doc || S.drag || S.editing || cur === S.loadEntry || cur === S.exportEntry) return;
    if (!document.hasFocus()) return;
    copyImage(true);
  }, AUTO_COPY_DELAY);
}

function setAutoCopy(on) {
  S.autoCopy = on;
  savePref('autoCopy', on);
  $('#autoCopy').checked = on;
  if (on) scheduleAutoCopy();
}

async function copyImage(auto = false) {
  if (!S.doc) return;
  if (!auto) finishPending();
  renderNow();
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    if (auto) return;
    toast('這個瀏覽器不支援複製影像，已改為下載');
    download('image/png');
    return;
  }
  const entry = S.history[S.hIndex];
  try {
    // Safari only allows the write if the blob is passed as a promise inside the user gesture.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(mainCv) })]);
    S.exportEntry = entry;
    syncCopyState();
    if (!auto) {
      const btn = $('#btnCopy');
      btn.classList.remove('pulse');
      void btn.offsetWidth;
      btn.classList.add('pulse');
    }
  } catch (err) {
    if (!auto) {
      toast(`複製失敗：${err.message}`, { error: true });
    } else if (!autoCopyWarned) {
      autoCopyWarned = true;
      toast('瀏覽器擋下了自動複製，請手動按複製', { error: true });
    }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function download(type = 'image/png') {
  if (!S.doc) return;
  finishPending();
  renderNow();
  let source = mainCv;
  if (type === 'image/jpeg') {
    source = newCanvas(mainCv.width, mainCv.height);
    const x = source.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, source.width, source.height);
    x.drawImage(mainCv, 0, 0);
  }
  try {
    const blob = await canvasToBlob(source, type, 0.92);
    const ext = blob.type.split('/')[1].replace('jpeg', 'jpg');
    if (blob.type !== type) toast(`這個瀏覽器不支援 ${type}，已存成 ${ext.toUpperCase()}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `screenshot-${stamp()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    S.exportEntry = S.history[S.hIndex];
  } catch (err) {
    toast(`下載失敗：${err.message}`, { error: true });
  }
}

/* ---------- pointer interaction ---------- */

function touchTol(e) {
  return (e.pointerType === 'touch' ? 16 : 7) / S.zoom;
}

function startPinch() {
  // A second finger cancels whatever the first one started.
  if (S.drag?.orig && S.drag.obj) Object.assign(S.drag.obj, clone(S.drag.orig));
  S.draft = null;
  S.drag = null;
  const [a, b] = [...pointers.values()];
  S.pinch = {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    zoom: S.zoom,
  };
}

function updatePinch() {
  const [a, b] = [...pointers.values()];
  const r = stage.getBoundingClientRect();
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  S.panX += cx - S.pinch.cx;
  S.panY += cy - S.pinch.cy;
  S.pinch.cx = cx;
  S.pinch.cy = cy;
  zoomAt(S.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / S.pinch.dist), cx - r.left, cy - r.top);
}

stage.addEventListener('pointerdown', (e) => {
  if (e.target === editor || e.target.closest('.statusbar, .empty')) return;
  if (!S.doc) return;
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (e.pointerType === 'touch' && pointers.size === 2) {
    startPinch();
    return;
  }

  const pos = toDoc(e);
  const panning = e.button === 1 || S.space;
  if (panning) {
    S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: S.panX, py: S.panY };
    stage.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;
  if (finishText()) return;

  const tol = touchTol(e);

  if (S.tool === 'crop') {
    const c = S.crop;
    const handle = c && hitHandle(boxHandles(c, !!S.cropAspect), pos.x, pos.y, tol);
    if (handle) S.drag = { kind: 'crop-resize', id: handle.id, orig: { ...c } };
    else if (c && pos.x >= c.x && pos.x <= c.x + c.w && pos.y >= c.y && pos.y <= c.y + c.h) {
      S.drag = { kind: 'crop-move', start: pos, orig: { ...c } };
    } else {
      const [ax, ay] = clampToBounds(pos.x, pos.y);
      S.crop = null;
      S.drag = { kind: 'crop-new', ax, ay };
    }
    return;
  }

  const sel = S.selected;
  if (sel) {
    const handle = hitHandle(handlesOf(sel), pos.x, pos.y, tol);
    if (handle) {
      S.drag = { kind: 'resize', id: handle.id, obj: sel, orig: clone(sel), moved: false };
      return;
    }
    if (hitObject(sel, pos.x, pos.y, tol)) {
      S.drag = { kind: 'move', start: pos, obj: sel, orig: clone(sel), moved: false };
      return;
    }
  }

  if (S.tool === 'select') {
    const hit = hitTop(pos.x, pos.y, tol);
    S.selected = hit;
    if (hit) S.drag = { kind: 'move', start: pos, obj: hit, orig: clone(hit), moved: false };
    syncOptions();
    invalidate();
    return;
  }

  S.selected = null;

  if (S.tool === 'text') {
    const hit = hitTop(pos.x, pos.y, tol);
    S.drag = { kind: 'text-click', pos, hit: hit?.type === 'text' ? hit : null };
  } else if (S.tool === 'step') {
    S.drag = { kind: 'step-click', pos };
  } else {
    S.draft = newObject(S.tool, pos.x, pos.y);
    S.drag = { kind: 'draft', sx: e.clientX, sy: e.clientY };
  }
  syncOptions();
  invalidate();
});

stage.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (S.pinch) {
    if (pointers.size === 2) updatePinch();
    return;
  }
  if (!S.doc) return;
  const d = S.drag;
  if (!d) {
    updateCursor(e);
    return;
  }
  const pos = toDoc(e);
  switch (d.kind) {
    case 'pan':
      S.panX = d.px + e.clientX - d.sx;
      S.panY = d.py + e.clientY - d.sy;
      S.autoFit = false;
      applyView();
      break;
    case 'draft': {
      const events = DRAW_STROKE.has(S.draft.type) && !e.shiftKey && e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (events.length > 1) events.forEach((ev) => updateDraft(toDoc(ev), false));
      else updateDraft(pos, e.shiftKey);
      invalidate();
      break;
    }
    case 'move':
      if (d.moved || Math.hypot(pos.x - d.start.x, pos.y - d.start.y) * S.zoom > 2) {
        d.moved = true;
        translate(d.obj, d.orig, pos.x - d.start.x, pos.y - d.start.y);
        invalidate();
      }
      break;
    case 'resize':
      d.moved = true;
      resize(d.obj, d.orig, d.id, pos.x, pos.y, e.shiftKey);
      invalidate();
      break;
    case 'crop-new':
      S.crop = cropFromDrag(d.ax, d.ay, pos.x, pos.y);
      syncOptions();
      invalidate();
      break;
    case 'crop-move':
      S.crop = clampCropMove({ ...d.orig, x: d.orig.x + pos.x - d.start.x, y: d.orig.y + pos.y - d.start.y });
      invalidate();
      break;
    case 'crop-resize': {
      const [px, py] = clampToBounds(pos.x, pos.y);
      const corner = d.id.length === 2;
      const aspect = S.cropAspect || (e.shiftKey && corner && d.orig.h > 0 ? d.orig.w / d.orig.h : 0);
      if (aspect && corner) {
        const ax = d.id.includes('w') ? d.orig.x + d.orig.w : d.orig.x;
        const ay = d.id[0] === 'n' ? d.orig.y + d.orig.h : d.orig.y;
        S.crop = cropFromDrag(ax, ay, px, py, aspect);
      } else {
        S.crop = dragBox(d.orig, d.id, px, py, false);
      }
      syncOptions();
      invalidate();
      break;
    }
  }
});

function endPointer(e) {
  const wasTracked = pointers.delete(e.pointerId);
  if (S.pinch) {
    if (pointers.size < 2) S.pinch = null;
    return;
  }
  if (!wasTracked) return;
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (e.type === 'pointercancel') {
    S.draft = null;
    if (d.orig && d.obj) Object.assign(d.obj, clone(d.orig));
    invalidate();
    return;
  }
  switch (d.kind) {
    case 'pan':
      stage.style.cursor = '';
      break;
    case 'draft': {
      const moved = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
      // A plain click makes a dot for pens, and nothing for shapes.
      if (moved < 3 && !DRAW_STROKE.has(S.draft.type)) S.draft = null;
      finishDraft();
      break;
    }
    case 'move':
    case 'resize':
      if (d.moved) edited();
      break;
    case 'crop-new':
    case 'crop-resize':
    case 'crop-move':
      if (S.crop && (S.crop.w < 2 || S.crop.h < 2)) S.crop = null;
      syncOptions();
      break;
    case 'text-click':
      if (d.hit) {
        openEditor(d.hit, false);
      } else {
        const st = styles.text;
        const o = { type: 'text', color: st.color, size: st.size * S.doc.unit, fill: st.fill, text: '' };
        o.x = d.pos.x;
        o.y = d.pos.y - (o.size * LINE_HEIGHT) / 2;
        S.doc.objects.push(o);
        openEditor(o, true);
      }
      break;
    case 'step-click': {
      const st = styles.step;
      const o = { type: 'step', color: st.color, size: st.size * S.doc.unit, x: d.pos.x, y: d.pos.y, n: nextStep() };
      S.doc.objects.push(o);
      S.selected = o;
      edited();
      break;
    }
  }
  syncOptions();
  invalidate();
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

stage.addEventListener('dblclick', (e) => {
  if (!S.doc || e.target === editor) return;
  const pos = toDoc(e);
  if (S.tool === 'crop') {
    const c = S.crop;
    if (c && pos.x >= c.x && pos.x <= c.x + c.w && pos.y >= c.y && pos.y <= c.y + c.h) applyCrop();
    return;
  }
  const hit = hitTop(pos.x, pos.y, 7 / S.zoom);
  if (hit?.type === 'text') openEditor(hit, false);
});

function updateCursor(e) {
  if (S.space) {
    stage.style.cursor = 'grab';
    return;
  }
  const pos = toDoc(e);
  const tol = touchTol(e);
  const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'grab', p2: 'grab' };
  let cursor = S.tool === 'select' ? 'default' : S.tool === 'text' ? 'text' : 'crosshair';
  if (S.tool === 'crop') {
    const c = S.crop;
    const h = c && hitHandle(boxHandles(c, !!S.cropAspect), pos.x, pos.y, tol);
    if (h) cursor = CURSORS[h.id];
    else if (c && pos.x >= c.x && pos.x <= c.x + c.w && pos.y >= c.y && pos.y <= c.y + c.h) cursor = 'move';
  } else {
    const sel = S.selected;
    const h = sel && hitHandle(handlesOf(sel), pos.x, pos.y, tol);
    if (h) cursor = CURSORS[h.id];
    else if (sel && hitObject(sel, pos.x, pos.y, tol)) cursor = 'move';
    else if (S.tool === 'select' && hitTop(pos.x, pos.y, tol)) cursor = 'move';
  }
  stage.style.cursor = cursor;
}

stage.addEventListener('wheel', (e) => {
  if (!S.doc) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  // Wheel zooms. A sideways component means a trackpad two-finger swipe, which
  // still pans; trackpad pinch arrives as ctrl+wheel and zooms.
  const swipe = e.deltaX !== 0 && !e.ctrlKey && !e.metaKey;
  if (!swipe) {
    const dy = Math.max(-120, Math.min(120, e.deltaY * (e.deltaMode === 1 ? 16 : 1)));
    zoomAt(S.zoom * Math.exp(-dy * 0.0025), e.clientX - r.left, e.clientY - r.top);
  } else {
    S.panX -= e.deltaX;
    S.panY -= e.deltaY;
    S.autoFit = false;
    applyView();
  }
}, { passive: false });

// Middle button pans (handled in pointerdown); stop the browser's autoscroll
// and Linux's middle-click paste.
stage.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
stage.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

new ResizeObserver(() => {
  if (S.autoFit) fit();
  else invalidate();
}).observe(stage);

/* ---------- toolbar & options ---------- */

function setTool(tool, keepSelection = false) {
  if (!TOOLS[tool]) return;
  finishText();
  if (S.tool === 'crop' && tool !== 'crop') S.crop = null;
  if (tool === 'crop' && S.tool !== 'crop') S.toolBeforeCrop = S.tool;
  S.tool = tool;
  if (!keepSelection && tool !== 'select') S.selected = null;
  if (tool === 'crop') S.selected = null;
  syncUI();
  invalidate();
}

function styleTarget() {
  // Selected objects are styled directly; otherwise edit the tool's defaults.
  if (S.selected && S.selected.type !== 'image') return { tool: S.selected.type, obj: S.selected };
  return { tool: S.tool, obj: null };
}

function setStyle(key, value, shouldCommit = true) {
  const { tool, obj } = styleTarget();
  if (styles[tool]) styles[tool][key] = value;
  if (obj) {
    obj[key] = key === 'size' ? value * S.doc.unit : value;
    if (shouldCommit) edited();
  }
  syncOptions();
  invalidate();
}

function syncOptions() {
  const { tool, obj } = styleTarget();
  const cfg = TOOLS[tool] || {};
  const st = styles[tool] || {};
  const isCrop = S.tool === 'crop';
  const color = obj ? obj.color : st.color;
  const hasColor = !isCrop && !!cfg.color;
  const hasSize = !isCrop && !!cfg.sizeRange;
  const hasFill = !isCrop && cfg.fill !== undefined;

  $('#optColor').hidden = !hasColor;
  if (hasColor) {
    document.querySelectorAll('#swatches .swatch').forEach((b) => {
      const on = b.dataset.color === color;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
    });
    $('#colorInput').value = color;
  }
  $('#optSize').hidden = !hasSize;
  if (hasSize) {
    const [min, max] = cfg.sizeRange;
    const input = $('#sizeInput');
    input.min = min;
    input.max = max;
    const unit = S.doc?.unit || 1;
    const value = Math.round(obj ? obj.size / unit : st.size);
    input.value = value;
    $('#sizeValue').textContent = value;
    $('#sizeLabel').textContent = cfg.sizeLabel;
  }
  $('#optFill').hidden = !hasFill;
  if (hasFill) {
    $('#fillInput').checked = !!(obj ? obj.fill : st.fill);
    $('#fillLabel').textContent = cfg.fillLabel || '填滿';
  }
  $('#optCrop').hidden = !isCrop;
  if (isCrop) {
    const c = S.crop;
    $('#cropSize').textContent = c ? `${Math.round(c.w)} × ${Math.round(c.h)}` : '';
    $('#cropApply').disabled = !c;
  }
  const hasObj = !!S.selected && !S.editing;
  $('#optObject').hidden = !hasObj;
  $('#hint').textContent = (hasObj && S.tool !== 'select') ? '' : (TOOLS[S.tool]?.hint || '');
}

function syncUI() {
  const has = !!S.doc;
  $('#empty').hidden = has;
  $('#statusbar').hidden = !has;
  mainCv.hidden = !has;
  document.querySelectorAll('.needs-doc').forEach((b) => { b.disabled = !has; });
  $('#btnUndo').disabled = S.hIndex <= 0;
  $('#btnRedo').disabled = S.hIndex >= S.history.length - 1;
  $('#options').style.visibility = has ? '' : 'hidden';
  syncCopyState();
  document.querySelectorAll('.tool').forEach((b) => {
    const on = b.dataset.tool === S.tool;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
    b.disabled = !has;
  });
  syncOptions();
}

function buildTools() {
  const nav = $('#tools');
  for (const [id, t] of Object.entries(TOOLS)) {
    if (!t) {
      const s = document.createElement('div');
      s.className = 'sep';
      nav.append(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = id;
    b.dataset.tip = t.label;
    b.dataset.key = t.key;
    b.setAttribute('aria-label', t.label);
    b.innerHTML = `<svg><use href="#i-${t.icon}"/></svg>`;
    b.onclick = () => setTool(id);
    nav.append(b);
  }
}

function buildSwatches() {
  const wrap = $('#swatches');
  for (const color of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.backgroundColor = color;
    b.dataset.color = color;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', color);
    b.onclick = () => setStyle('color', color);
    wrap.append(b);
  }
}

function buildKeys() {
  const rows = [
    ...Object.values(TOOLS).filter(Boolean).map((t) => [t.label, t.key]),
    ['複製結果', `${MOD} C`],
    ['貼上影像', `${MOD} V`],
    ['下載 PNG', `${MOD} S`],
    ['開啟檔案', `${MOD} O`],
    ['復原', `${MOD} Z`],
    ['重做', `${MOD} Y`],
    ['再製物件', `${MOD} D`],
    ['刪除物件', 'Del'],
    ['微調位置', '方向鍵'],
    ['微調 10px', 'Shift 方向鍵'],
    ['等比例縮放', 'Shift 拖曳控制點'],
    ['置頂／置底', `${MOD} ] [`],
    ['調整粗細', '[ ]'],
    ['放大／縮小', '+ −'],
    ['符合視窗', `${MOD} 0`],
    ['100%', `${MOD} 1`],
    ['平移畫面', '中鍵拖曳或空白鍵拖曳'],
    ['縮放畫面', '滾輪'],
    ['取消／完成', 'Esc'],
  ];
  $('#keysTable').innerHTML = rows.map(([a, b]) => `<div><span>${a}</span><kbd>${b}</kbd></div>`).join('');
}

/* ---------- menus & dialogs ---------- */

function toggleMenu(btn, menu, force) {
  const open = force ?? menu.hidden;
  document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('[aria-haspopup]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open);
}

function setupMenus() {
  const pairs = [[$('#btnImage'), $('#menuImage')], [$('#btnDownload'), $('#menuDownload')]];
  for (const [btn, menu] of pairs) {
    btn.onclick = (e) => { e.stopPropagation(); toggleMenu(btn, menu); };
  }
  document.addEventListener('click', () => {
    pairs.forEach(([btn, menu]) => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
  });
  $('#menuImage').addEventListener('click', (e) => {
    const op = e.target.closest('[data-op]')?.dataset.op;
    if (!op) return;
    if (op === 'resize') openResize();
    else if (op === 'frame') { finishPending(); openDialog($('#dlgFrame')); }
    else transformImage(op);
  });
  $('#menuDownload').addEventListener('click', (e) => {
    const f = e.target.closest('[data-format]')?.dataset.format;
    if (f) download(f);
  });
}

// Esc closes a dialog without touching returnValue, so clear it or a stale "ok" would re-apply.
function openDialog(dlg) {
  dlg.returnValue = '';
  dlg.showModal();
}

function openResize() {
  finishPending();
  renderNow();
  const { width: w, height: h } = mainCv;
  const W = $('#rzW');
  const H = $('#rzH');
  W.value = w;
  H.value = h;
  W.oninput = () => { if ($('#rzLock').checked) H.value = Math.max(1, Math.round((W.value * h) / w)); };
  H.oninput = () => { if ($('#rzLock').checked) W.value = Math.max(1, Math.round((H.value * w) / h)); };
  openDialog($('#dlgResize'));
}

function setupDialogs() {
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => b.closest('dialog').close();
  });
  $('#dlgPaste').addEventListener('keydown', (e) => {
    const value = { 1: 'replace', 2: 'overlay' }[e.key];
    if (!value || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    $('#dlgPaste').close(value);
  });
  document.querySelectorAll('#rzPresets button').forEach((b) => {
    b.onclick = () => {
      const pct = Number(b.dataset.pct) / 100;
      $('#rzW').value = Math.max(1, Math.round(mainCv.width * pct));
      $('#rzH').value = Math.max(1, Math.round(mainCv.height * pct));
    };
  });
  $('#dlgResize').addEventListener('close', () => {
    if ($('#dlgResize').returnValue !== 'ok') return;
    const w = Math.round(Number($('#rzW').value));
    const h = Math.round(Number($('#rzH').value));
    if (w >= 1 && h >= 1 && w <= MAX_CANVAS_SIDE && h <= MAX_CANVAS_SIDE) resizeImage(w, h);
    else toast('尺寸不正確', { error: true });
  });
  $('#dlgFrame').addEventListener('close', () => {
    if ($('#dlgFrame').returnValue !== 'ok') return;
    frameImage({
      pad: Math.max(0, Math.round(Number($('#frPad').value) || 0)),
      radius: Math.max(0, Number($('#frRadius').value) || 0),
      color: $('#frColor').value,
      transparent: $('#frTransparent').checked,
      shadow: $('#frShadow').checked,
    });
  });
}

function setupTooltips() {
  const tip = $('#tip');
  let current = null;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tip]');
    if (el === current) return;
    current = el;
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    if (el.dataset.key) {
      const k = document.createElement('kbd');
      k.textContent = el.dataset.key.replace('Ctrl', MOD);
      tip.append(k);
    }
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const beside = el.classList.contains('tool') && innerWidth > 720;
    let x = beside ? r.right + 8 : r.left + r.width / 2 - t.width / 2;
    let y = beside ? r.top + r.height / 2 - t.height / 2 : r.bottom + 8;
    if (y + t.height > innerHeight - 4) y = r.top - t.height - 8;
    x = Math.min(innerWidth - t.width - 6, Math.max(6, x));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  document.addEventListener('pointerdown', () => { tip.hidden = true; current = null; }, true);
}

/* ---------- keyboard ---------- */

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  const typing = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['range', 'color', 'checkbox'].includes(t.type));
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod) {
    const has = !!S.doc;
    switch (key) {
      case 'z':
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      case 'y':
        e.preventDefault();
        redo();
        return;
      case 'c':
        if (has && !getSelection().toString()) {
          e.preventDefault();
          copyImage();
        }
        return;
      case 's':
        e.preventDefault();
        download('image/png');
        return;
      case 'o':
        e.preventDefault();
        $('#fileInput').click();
        return;
      case 'd':
        e.preventDefault();
        duplicateSelected();
        return;
      case ']':
        e.preventDefault();
        reorderSelected(true);
        return;
      case '[':
        e.preventDefault();
        reorderSelected(false);
        return;
      case '0':
        e.preventDefault();
        fit();
        return;
      case '1':
        e.preventDefault();
        if (has) zoomAt(1, stage.clientWidth / 2, stage.clientHeight / 2);
        return;
      default:
        return;
    }
  }

  if (e.key === '?') {
    openDialog($('#dlgHelp'));
    return;
  }
  if (!S.doc || e.altKey) return;

  if (e.code === 'Space' && t.tagName !== 'BUTTON') {
    e.preventDefault();
    S.space = true;
    stage.style.cursor = 'grab';
    return;
  }

  const sel = S.selected;
  if (e.key.startsWith('Arrow') && t.type !== 'range') {
    if (!sel) return;
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
    translate(sel, clone(sel), dx, dy);
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(commit, 400);
    invalidate();
    return;
  }

  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      deleteSelected();
      return;
    case 'Escape':
      if (S.tool === 'crop') cancelCrop();
      else if (sel) { S.selected = null; syncOptions(); invalidate(); }
      else setTool('select');
      return;
    case 'Enter':
      if (S.tool === 'crop') applyCrop();
      return;
    case '[':
    case ']': {
      const { tool, obj } = styleTarget();
      const cfg = TOOLS[tool];
      if (!cfg?.sizeRange) return;
      const cur = obj ? Math.round(obj.size / S.doc.unit) : styles[tool].size;
      const step = Math.max(1, Math.round(cur * 0.15));
      const next = Math.min(cfg.sizeRange[1], Math.max(cfg.sizeRange[0], cur + (e.key === ']' ? step : -step)));
      setStyle('size', next);
      return;
    }
    case '+':
    case '=':
      zoomCenter(1.25);
      return;
    case '-':
      zoomCenter(0.8);
      return;
  }

  const match = Object.entries(TOOLS).find(([, cfg]) => cfg && cfg.key.toLowerCase() === key);
  if (match) setTool(match[0]);
});

let nudgeTimer = 0;

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    S.space = false;
    stage.style.cursor = '';
  }
});

/* ---------- paste / drop / file ---------- */

document.addEventListener('paste', (e) => {
  const blobs = [];
  for (const item of e.clipboardData?.items || []) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) blobs.push(f);
    }
  }
  if (blobs.length) {
    e.preventDefault();
    if (document.querySelector('dialog[open]')) return;
    finishPending();
    receiveBlobs(blobs);
  } else if (!S.editing && !document.querySelector('dialog[open]')) {
    toast('剪貼簿裡沒有影像');
  }
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#dropmask').hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropmask').hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropmask').hidden = true;
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!files.length) {
    toast('只支援影像檔', { error: true });
    return;
  }
  finishPending();
  receiveBlobs(files);
});

$('#fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) {
    finishPending();
    await receiveBlobs(files, 'replace');
  }
});

/* ---------- wiring ---------- */

function pick() { $('#fileInput').click(); }

function init() {
  buildTools();
  buildSwatches();
  buildKeys();
  setupMenus();
  setupDialogs();
  setupTooltips();

  if (isMac) {
    $('#pasteKey').textContent = '⌘ V';
    $('#copyKey').textContent = '⌘ C';
  }

  $('#btnOpen').onclick = pick;
  $('#emptyOpen').onclick = pick;
  $('#btnPaste').onclick = pasteFromButton;
  $('#emptyPaste').onclick = pasteFromButton;
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnCopy').onclick = () => copyImage();
  $('#autoCopy').checked = S.autoCopy;
  $('#autoCopy').addEventListener('change', (e) => {
    setAutoCopy(e.target.checked);
    toast(e.target.checked ? '自動複製已開啟：每次編輯後自動複製' : '自動複製已關閉');
    e.target.blur();
  });
  $('#btnDownload').title = '';
  $('#btnHelp').onclick = () => openDialog($('#dlgHelp'));
  $('#zoomOut').onclick = () => zoomCenter(0.8);
  $('#zoomIn').onclick = () => zoomCenter(1.25);
  $('#zoomLabel').onclick = toggleZoom;
  $('#cropApply').onclick = applyCrop;
  $('#cropCancel').onclick = cancelCrop;
  $('#objDup').onclick = duplicateSelected;
  $('#objFront').onclick = () => reorderSelected(true);
  $('#objBack').onclick = () => reorderSelected(false);
  $('#objDelete').onclick = deleteSelected;

  $('#colorInput').addEventListener('input', (e) => setStyle('color', e.target.value, false));
  $('#colorInput').addEventListener('change', (e) => setStyle('color', e.target.value, true));
  $('#sizeInput').addEventListener('input', (e) => setStyle('size', Number(e.target.value), false));
  $('#sizeInput').addEventListener('change', (e) => {
    setStyle('size', Number(e.target.value), true);
    e.target.blur();
  });
  $('#fillInput').addEventListener('change', (e) => {
    setStyle('fill', e.target.checked);
    e.target.blur();
  });
  $('#cropAspects').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setCropAspect(Number(b.dataset.aspect) || null);
  });

  // Mouse clicks must not leave focus on a button, or Space would re-trigger it.
  document.addEventListener('click', (e) => {
    if (e.detail > 0) e.target.closest('button')?.blur();
  });

  syncUI();
  invalidate();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
