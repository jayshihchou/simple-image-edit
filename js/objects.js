// Annotation objects: geometry, hit testing and drawing. All coordinates are image pixels.

export const FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
export const LINE_HEIGHT = 1.25;

const BOX_TYPES = new Set(['rect', 'ellipse', 'mosaic', 'blur', 'redact', 'spotlight', 'image']);
const LINE_TYPES = new Set(['arrow', 'line']);
const STROKE_TYPES = new Set(['pen', 'highlight']);

const scratch = document.createElement('canvas');
const scratchCtx = scratch.getContext('2d');
const measureCtx = document.createElement('canvas').getContext('2d');

export function clone(o) {
  return { ...o, points: o.points?.map((p) => [p[0], p[1]]) };
}

export function normBox(b) {
  return {
    x: Math.min(b.x, b.x + b.w),
    y: Math.min(b.y, b.y + b.h),
    w: Math.abs(b.w),
    h: Math.abs(b.h),
  };
}

export function contrastColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? '#111111' : '#ffffff';
}

export function textMetrics(text, size) {
  measureCtx.font = `600 ${size}px ${FONT}`;
  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width), size * 0.3);
  return { lines, w, h: lines.length * size * LINE_HEIGHT };
}

export function textPad(o) {
  return o.fill ? o.size * 0.3 : 0;
}

export function bbox(o) {
  if (BOX_TYPES.has(o.type)) return normBox(o);
  if (LINE_TYPES.has(o.type)) {
    return { x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2), w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
  }
  if (STROKE_TYPES.has(o.type)) {
    const xs = o.points.map((p) => p[0]);
    const ys = o.points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (o.type === 'text') {
    const m = textMetrics(o.text, o.size);
    const pad = textPad(o);
    return { x: o.x - pad, y: o.y - pad, w: m.w + pad * 2, h: m.h + pad * 2 };
  }
  if (o.type === 'step') return { x: o.x - o.size, y: o.y - o.size, w: o.size * 2, h: o.size * 2 };
  return { x: 0, y: 0, w: 0, h: 0 };
}

export function boxHandles(b, cornersOnly = false) {
  const { x, y, w, h } = b;
  const corners = [
    { id: 'nw', x, y },
    { id: 'ne', x: x + w, y },
    { id: 'se', x: x + w, y: y + h },
    { id: 'sw', x, y: y + h },
  ];
  if (cornersOnly) return corners;
  return [
    ...corners,
    { id: 'n', x: x + w / 2, y },
    { id: 'e', x: x + w, y: y + h / 2 },
    { id: 's', x: x + w / 2, y: y + h },
    { id: 'w', x, y: y + h / 2 },
  ];
}

export function handlesOf(o) {
  if (LINE_TYPES.has(o.type)) {
    return [{ id: 'p1', x: o.x1, y: o.y1 }, { id: 'p2', x: o.x2, y: o.y2 }];
  }
  const cornersOnly = !BOX_TYPES.has(o.type);
  return boxHandles(bbox(o), cornersOnly);
}

export function translate(o, orig, dx, dy) {
  if (LINE_TYPES.has(o.type)) {
    o.x1 = orig.x1 + dx; o.y1 = orig.y1 + dy;
    o.x2 = orig.x2 + dx; o.y2 = orig.y2 + dy;
  } else if (STROKE_TYPES.has(o.type)) {
    o.points = orig.points.map((p) => [p[0] + dx, p[1] + dy]);
  } else {
    o.x = orig.x + dx; o.y = orig.y + dy;
  }
}

/** Box resulting from dragging handle `id` of box `b` to (px, py). */
export function dragBox(b, id, px, py, keepAspect) {
  const left = id.includes('w');
  const right = id.includes('e');
  const top = id[0] === 'n';
  const bottom = id[0] === 's';
  if (keepAspect && (left || right) && (top || bottom) && b.w > 0 && b.h > 0) {
    const ax = left ? b.x + b.w : b.x;
    const ay = top ? b.y + b.h : b.y;
    const s = Math.max(Math.abs(px - ax) / b.w, Math.abs(py - ay) / b.h);
    const w = b.w * s;
    const h = b.h * s;
    return { x: px < ax ? ax - w : ax, y: py < ay ? ay - h : ay, w, h };
  }
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h;
  if (left) x0 = px;
  if (right) x1 = px;
  if (top) y0 = py;
  if (bottom) y1 = py;
  return normBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
}

export function resize(o, orig, handleId, px, py, shift) {
  if (handleId === 'p1' || handleId === 'p2') {
    const [ax, ay] = handleId === 'p1' ? [orig.x2, orig.y2] : [orig.x1, orig.y1];
    const [x, y] = shift ? snapAngle(ax, ay, px, py) : [px, py];
    if (handleId === 'p1') { o.x1 = x; o.y1 = y; } else { o.x2 = x; o.y2 = y; }
    return;
  }
  const b = bbox(orig);
  if (o.type === 'text' || o.type === 'step') {
    const nb = dragBox(b, handleId, px, py, true);
    if (o.type === 'step') {
      o.size = Math.max(4, nb.w / 2);
      o.x = nb.x + o.size;
      o.y = nb.y + o.size;
    } else {
      o.size = Math.max(6, orig.size * (b.w > 0 ? nb.w / b.w : 1));
      const pad = textPad(o);
      o.x = nb.x + pad;
      o.y = nb.y + pad;
    }
    return;
  }
  // Images keep their aspect ratio unless Shift is held; everything else is the reverse.
  const keepAspect = o.type === 'image' ? !shift : shift;
  const nb = dragBox(b, handleId, px, py, keepAspect);
  if (STROKE_TYPES.has(o.type)) {
    const sx = b.w > 0 ? nb.w / b.w : 1;
    const sy = b.h > 0 ? nb.h / b.h : 1;
    o.points = orig.points.map((p) => [nb.x + (p[0] - b.x) * sx, nb.y + (p[1] - b.y) * sy]);
    return;
  }
  Object.assign(o, nb);
}

export function snapAngle(ax, ay, px, py) {
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(py - ay, px - ax) / step) * step;
  const len = Math.hypot(px - ax, py - ay);
  return [ax + Math.cos(ang) * len, ay + Math.sin(ang) * len];
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** `tol` is the extra hit tolerance in image pixels. */
export function hitObject(o, x, y, tol) {
  if (LINE_TYPES.has(o.type)) {
    return distToSegment(x, y, o.x1, o.y1, o.x2, o.y2) <= o.size / 2 + tol;
  }
  if (STROKE_TYPES.has(o.type)) {
    const r = o.size / 2 + tol;
    const pts = o.points;
    if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= r;
    for (let i = 1; i < pts.length; i++) {
      if (distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
    }
    return false;
  }
  if (o.type === 'step') return Math.hypot(x - o.x, y - o.y) <= o.size + tol;

  const b = bbox(o);
  const inside = x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
  if (!inside) return false;

  if (o.type === 'rect' && !o.fill) {
    const m = o.size / 2 + tol;
    return x <= b.x + m || x >= b.x + b.w - m || y <= b.y + m || y >= b.y + b.h - m;
  }
  if (o.type === 'ellipse') {
    const rx = b.w / 2, ry = b.h / 2;
    if (!rx || !ry) return true;
    const cx = b.x + rx, cy = b.y + ry;
    const m = o.size / 2 + tol;
    const outer = ((x - cx) / (rx + m)) ** 2 + ((y - cy) / (ry + m)) ** 2;
    if (outer > 1) return false;
    if (o.fill || rx <= m || ry <= m) return true;
    return ((x - cx) / (rx - m)) ** 2 + ((y - cy) / (ry - m)) ** 2 >= 1;
  }
  return true;
}

function clipRect(ctx, o) {
  const b = normBox(o);
  const x0 = Math.max(0, Math.floor(b.x));
  const y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(b.x + b.w));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(b.y + b.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Mosaic and blur read back whatever is already drawn beneath them, so stacking order matters.
function drawPixelated(ctx, o, smooth) {
  const r = clipRect(ctx, o);
  if (!r) return;
  const block = Math.max(2, o.size);
  const tw = Math.max(1, Math.ceil(r.w / block));
  const th = Math.max(1, Math.ceil(r.h / block));
  scratch.width = tw;
  scratch.height = th;
  scratchCtx.imageSmoothingEnabled = true;
  scratchCtx.imageSmoothingQuality = 'high';
  scratchCtx.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, tw, th);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scratch, 0, 0, tw, th, r.x, r.y, tw * (r.w / tw), th * (r.h / th));
  ctx.restore();
}

function drawArrow(ctx, o) {
  const { x1, y1, x2, y2, size, color } = o;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!len) return;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const head = Math.min(Math.max(size * 5, 14), len * 0.7);
  const half = head * 0.55;
  const bx = x2 - ux * head;
  const by = y2 - uy * head;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - ux * head * 0.85, y2 - uy * head * 0.85);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(bx - uy * half, by + ux * half);
  ctx.lineTo(bx + uy * half, by - ux * half);
  ctx.closePath();
  ctx.fill();
}

function strokePath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 1) {
    ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
  } else if (pts.length === 2) {
    ctx.lineTo(pts[1][0], pts[1][1]);
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }
  ctx.stroke();
}

function drawText(ctx, o) {
  const m = textMetrics(o.text, o.size);
  const lh = o.size * LINE_HEIGHT;
  if (o.fill) {
    const pad = textPad(o);
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.roundRect(o.x - pad, o.y - pad, m.w + pad * 2, m.h + pad * 2, o.size * 0.22);
    ctx.fill();
  }
  ctx.font = `600 ${o.size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = o.fill ? contrastColor(o.color) : o.color;
  m.lines.forEach((line, i) => ctx.fillText(line, o.x, o.y + lh * (i + 0.5)));
}

function drawStep(ctx, o) {
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.arc(o.x, o.y, o.size, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1, o.size * 0.12);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.fillStyle = contrastColor(o.color);
  ctx.font = `700 ${o.size * (o.n > 9 ? 0.95 : 1.15)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(o.n), o.x, o.y + o.size * 0.06);
}

function drawObject(ctx, o) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  switch (o.type) {
    case 'arrow':
      drawArrow(ctx, o);
      break;
    case 'line':
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.size;
      ctx.beginPath();
      ctx.moveTo(o.x1, o.y1);
      ctx.lineTo(o.x2, o.y2);
      ctx.stroke();
      break;
    case 'rect': {
      const b = normBox(o);
      if (o.fill) {
        ctx.fillStyle = o.color;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      } else {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.size;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      break;
    }
    case 'ellipse': {
      const b = normBox(o);
      ctx.beginPath();
      ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (o.fill) {
        ctx.fillStyle = o.color;
        ctx.fill();
      } else {
        ctx.strokeStyle = o.color;
        ctx.lineWidth = o.size;
        ctx.stroke();
      }
      break;
    }
    case 'pen':
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.size;
      strokePath(ctx, o.points);
      break;
    case 'highlight':
      ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.size;
      ctx.lineCap = 'butt';
      strokePath(ctx, o.points);
      break;
    case 'text':
      drawText(ctx, o);
      break;
    case 'step':
      drawStep(ctx, o);
      break;
    case 'redact': {
      const b = normBox(o);
      ctx.fillStyle = o.color;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      break;
    }
    case 'mosaic':
      drawPixelated(ctx, o, false);
      break;
    case 'blur':
      drawPixelated(ctx, o, true);
      break;
    case 'image': {
      const b = normBox(o);
      ctx.drawImage(o.img, b.x, b.y, b.w, b.h);
      break;
    }
  }
  ctx.restore();
}

function drawSpotlights(ctx, spots) {
  const { width, height } = ctx.canvas;
  scratch.width = width;
  scratch.height = height;
  scratchCtx.fillStyle = 'rgba(0, 0, 0, .58)';
  scratchCtx.fillRect(0, 0, width, height);
  scratchCtx.globalCompositeOperation = 'destination-out';
  scratchCtx.fillStyle = '#000';
  for (const s of spots) {
    const b = normBox(s);
    scratchCtx.fillRect(b.x, b.y, b.w, b.h);
  }
  scratchCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(scratch, 0, 0);
}

/** Paints the whole document. `skip` is an object hidden from view (the one being text-edited). */
export function renderDoc(ctx, doc, extras = [], skip = null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, doc.w, doc.h);
  ctx.drawImage(doc.base, 0, 0);
  const spots = [];
  for (const o of [...doc.objects, ...extras]) {
    if (o === skip) continue;
    if (o.type === 'spotlight') spots.push(o);
    else drawObject(ctx, o);
  }
  if (spots.length) drawSpotlights(ctx, spots);
}
