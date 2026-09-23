import type { Point, Rect, Shape } from '../shared/types';
import { HANDLE_IDS, handlePoint, resizeRect } from '../shared/selection';
import type { HandleId } from '../shared/selection';

const scratch = new Map<string, HTMLCanvasElement>();

function getScratch(key: string, w: number, h: number): HTMLCanvasElement {
  let c = scratch.get(key);
  if (!c) {
    c = document.createElement('canvas');
    scratch.set(key, c);
  }
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

function normRect(
  x: number,
  y: number,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/**
 * 顺序回放单个 shape。调用时画布上已经是「底图 + 前面所有 shape」，
 * 这正是马赛克需要的语义 —— 它盖住的是**它下面的合成结果**，
 * 所以能一并糊掉更早画上去的箭头。
 */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (shape.type) {
    case 'arrow': {
      const { x1, y1, x2, y2, color, width } = shape;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = Math.max(width * 4, 14);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;

      const bx = x2 - head * 0.55 * Math.cos(angle);
      const by = y2 - head * 0.55 * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(bx, by);
      ctx.stroke();

      const spread = Math.PI / 7;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
      ctx.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'rect': {
      const r = normRect(shape.x, shape.y, shape.w, shape.h);
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = normRect(shape.x, shape.y, shape.w, shape.h);
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.ellipse(
        r.x + r.w / 2,
        r.y + r.h / 2,
        Math.max(r.w / 2, 0.5),
        Math.max(r.h / 2, 0.5),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    }
    case 'pen': {
      const pts = shape.points;
      if (pts.length === 0) break;
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
      break;
    }
    case 'mosaic':
      mosaic(ctx, shape.x, shape.y, shape.w, shape.h);
      break;
    case 'text': {
      ctx.fillStyle = shape.color;
      ctx.textBaseline = 'top';
      ctx.font = textFont(shape.size);
      const lineHeight = textLineHeight(shape.size);
      shape.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, shape.x, shape.y + i * lineHeight);
      });
      break;
    }
  }

  ctx.restore();
}

/** 文字绘制用的字体 —— 测量（编辑器定位夹紧）必须用同一个，否则对不上。 */
export function textFont(size: number): string {
  return `${size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
}

export function textLineHeight(size: number): number {
  return size * 1.3;
}

/** 文字块的外接尺寸（多行取最宽一行，高度按行高累加）。 */
export function measureTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  size: number,
): { width: number; height: number } {
  ctx.save();
  ctx.font = textFont(size);
  ctx.textBaseline = 'top';
  const lines = text.split('\n');
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, ctx.measureText(line).width);
  }
  ctx.restore();
  return { width, height: lines.length * textLineHeight(size) };
}

/**
 * 马赛克：先降采样再升采样。
 *
 * 关键是**降的时候开平滑、升的时候关平滑** —— 反过来就只会得到模糊而不是色块。
 * 快照必须先做：不能把 canvas 画到自己身上。
 */
function mosaic(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const rw = Math.min(Math.round(w), ctx.canvas.width - rx);
  const rh = Math.min(Math.round(h), ctx.canvas.height - ry);
  if (rw < 1 || rh < 1) return;

  const blockTarget = Math.min(40, Math.max(6, Math.round(Math.min(rw, rh) / 14)));
  const cols = Math.max(1, Math.round(rw / blockTarget));
  const rows = Math.max(1, Math.round(rh / blockTarget));

  const snap = getScratch('snap', rw, rh);
  const sctx = snap.getContext('2d');
  if (!sctx) return;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, rw, rh);
  sctx.drawImage(ctx.canvas, rx, ry, rw, rh, 0, 0, rw, rh);

  const tmp = getScratch('tmp', cols, rows);
  const tctx = tmp.getContext('2d');
  if (!tctx) return;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, cols, rows);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(snap, 0, 0, rw, rh, 0, 0, cols, rows);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, cols, rows, rx, ry, rw, rh);
  ctx.imageSmoothingEnabled = true;
}

/** 拖动中的马赛克只画半透明框，避免每帧都做一次像素运算。 */
export function drawDraftRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const r = normRect(x, y, w, h);
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
  ctx.restore();
}

// ---------------------------------------------------------------- 对象级操作

/** 控制点：包围盒的 8 个手柄，或箭头的两个端点。 */
export type ShapeHandle = HandleId | 'p1' | 'p2';

/** 深拷贝（画笔的点数组要另开一份），历史快照用。 */
export function cloneShape(shape: Shape): Shape {
  if (shape.type === 'pen') {
    return { ...shape, points: shape.points.map((p) => ({ ...p })) };
  }
  return { ...shape };
}

/** 图形的外接矩形；文字需要 ctx 才能测量。 */
export function shapeBBox(shape: Shape, ctx: CanvasRenderingContext2D): Rect {
  if (shape.type === 'text') {
    const m = measureTextBlock(ctx, shape.text, shape.size);
    return { x: shape.x, y: shape.y, width: m.width, height: m.height };
  }
  if (shape.type === 'pen') {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of shape.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  if (shape.type === 'arrow') {
    return {
      x: Math.min(shape.x1, shape.x2),
      y: Math.min(shape.y1, shape.y2),
      width: Math.abs(shape.x2 - shape.x1),
      height: Math.abs(shape.y2 - shape.y1),
    };
  }
  const r = normRect(shape.x, shape.y, shape.w, shape.h);
  return { x: r.x, y: r.y, width: r.w, height: r.h };
}

/** 只有这几种支持拖手柄改大小；画笔 / 文字 / 马赛克只能整体移动。 */
export function canResize(shape: Shape): boolean {
  return shape.type === 'rect' || shape.type === 'ellipse' || shape.type === 'arrow';
}

export function shapeHandlePoints(
  shape: Shape,
  ctx: CanvasRenderingContext2D,
): { id: ShapeHandle; x: number; y: number }[] {
  if (shape.type === 'arrow') {
    return [
      { id: 'p1', x: shape.x1, y: shape.y1 },
      { id: 'p2', x: shape.x2, y: shape.y2 },
    ];
  }
  if (!canResize(shape)) return [];
  const box = shapeBBox(shape, ctx);
  return HANDLE_IDS.map((id) => ({ id, ...handlePoint(box, id) }));
}

/** 按手柄拖动的结果（新图形对象，不动原对象）。 */
export function applyShapeHandle(
  origin: Shape,
  handle: ShapeHandle,
  cursor: Point,
  ctx: CanvasRenderingContext2D,
): Shape {
  if (origin.type === 'arrow') {
    return handle === 'p1'
      ? { ...origin, x1: cursor.x, y1: cursor.y }
      : { ...origin, x2: cursor.x, y2: cursor.y };
  }
  const box = shapeBBox(origin, ctx);
  const next = resizeRect(box, handle as HandleId, cursor);
  if (
    origin.type === 'rect' ||
    origin.type === 'ellipse' ||
    origin.type === 'mosaic'
  ) {
    return { ...origin, x: next.x, y: next.y, w: next.width, h: next.height };
  }
  return cloneShape(origin);
}

/**
 * 光标是否落在图形上：把图形单独画进检测画布，看目标像素有没有 alpha。
 *
 * 每次只清「检测框」那么大一块 —— 全画布 clear 的话，候选图形一多点击就卡。
 * 马赛克例外：它对下层取样，空白检测画布上取不到颜色（alpha 恒为 0），
 * 改按包围盒判定。
 */
export function isShapeHit(
  canvas: HTMLCanvasElement,
  shape: Shape,
  p: Point,
  tol: number,
): boolean {
  if (shape.type === 'mosaic') {
    const r = normRect(shape.x, shape.y, shape.w, shape.h);
    return (
      p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
    );
  }

  const x0 = Math.max(0, Math.floor(p.x - tol));
  const y0 = Math.max(0, Math.floor(p.y - tol));
  const x1 = Math.min(canvas.width, Math.ceil(p.x + tol) + 1);
  const y1 = Math.min(canvas.height, Math.ceil(p.y + tol) + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return false;

  const hit = getScratch('hit', canvas.width, canvas.height);
  const hctx = hit.getContext('2d');
  if (!hctx) return false;
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(x0, y0, w, h);
  drawShape(hctx, shape);
  const { data } = hctx.getImageData(x0, y0, w, h);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return true;
  }
  return false;
}

/**
 * 选中态外观：能调大小的画手柄（箭头画两端点圆），
 * 只能移动的画一圈虚线包围盒 —— 摆出手柄却拖不动更让人困惑。
 * `unit` 是手柄边长，按图像像素 / 屏幕像素的换算放大，别在高 DPI 图上画成一个点。
 */
export function drawSelection(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  unit: number,
): void {
  const box = shapeBBox(shape, ctx);
  ctx.save();
  ctx.lineWidth = 1;

  if (shape.type === 'arrow') {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    for (const p of [
      { x: shape.x1, y: shape.y1 },
      { x: shape.x2, y: shape.y2 },
    ]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, unit * 0.6), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  } else if (canResize(shape)) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    for (const id of HANDLE_IDS) {
      const hp = handlePoint(box, id);
      ctx.fillRect(hp.x - unit / 2, hp.y - unit / 2, unit, unit);
      ctx.strokeRect(
        hp.x - unit / 2 + 0.5,
        hp.y - unit / 2 + 0.5,
        unit - 1,
        unit - 1,
      );
    }
  } else {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(47, 111, 237, 0.95)';
    ctx.strokeRect(box.x - 0.5, box.y - 0.5, box.width + 1, box.height + 1);
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/** 整体平移（移动选中图形时从「按下时的副本」重算，天然不受跨帧累积影响）。 */
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if (shape.type === 'arrow') {
    return {
      ...shape,
      x1: shape.x1 + dx,
      y1: shape.y1 + dy,
      x2: shape.x2 + dx,
      y2: shape.y2 + dy,
    };
  }
  if (shape.type === 'pen') {
    return {
      ...shape,
      points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    };
  }
  return { ...shape, x: shape.x + dx, y: shape.y + dy };
}

/** 改色：马赛克没有颜色属性，原样返回（调用方据此跳过一次无意义的历史）。 */
export function withColor(shape: Shape, color: string): Shape {
  if (shape.type === 'mosaic') return shape;
  return { ...shape, color };
}
