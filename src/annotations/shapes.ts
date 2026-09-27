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

function normRect(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/**
 * 画布在**当前变换下**的可见尺寸（DIP / CSS px）。
 *
 * 标注坐标单位跟随 ctx 的变换：遮罩把 ctx 缩放到 dpr，钉图 / 导出是恒等。
 * `ctx.canvas.width/height` 是 backing 像素，直接拿来钳制坐标在 dpr≠1 时
 * 会差一个 dpr 倍数 —— 必须先除回去。
 */
function canvasSizeIn(ctx: CanvasRenderingContext2D): { w: number; h: number } {
  const t = ctx.getTransform();
  const kx = Math.abs(t.a) || 1;
  const ky = Math.abs(t.d) || 1;
  return { w: Math.floor(ctx.canvas.width / kx), h: Math.floor(ctx.canvas.height / ky) };
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
      const { x1, y1, x2, y2, color, width, head } = shape;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) break;

      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;

      const shaftMax = Math.max(2, width * 2);
      const headBase = Math.max(6, width * 5);
      const headLen = Math.min(Math.max(width * 6, 26), len * 0.85);
      const shaftLen = len - headLen;

      // 尾端收成一个点，半宽按 p² 增长：前半程始终很细，靠近头部才明显变粗。
      // 线性插值会整条均匀加粗，出不来参考图那种针尖起笔的效果。
      const halfAt = (t: number) => {
        const p = Math.min(t, shaftLen) / Math.max(shaftLen, 1);
        return (shaftMax / 2) * p * p;
      };
      const edge = (t: number, side: number) => ({
        x: x1 + ux * t + nx * halfAt(t) * side,
        y: y1 + uy * t + ny * halfAt(t) * side,
      });

      const tip = edge(0, 1); // 尾端两侧重合于同一点
      const shaft1 = edge(shaftLen, 1);
      const shaft2 = edge(shaftLen, -1);
      const rootX = x1 + ux * shaftLen;
      const rootY = y1 + uy * shaftLen;
      const wing1 = { x: rootX + nx * (headBase / 2), y: rootY + ny * (headBase / 2) };
      const wing2 = { x: rootX - nx * (headBase / 2), y: rootY - ny * (headBase / 2) };

      // 整支箭头是同一条轮廓：尖尾 → 杆身侧 → 肩部 → 头翼 → 尖尾。
      // 实心与空心只是「填充」与「描边」的差别，形状完全一致。
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(shaft1.x, shaft1.y);
      ctx.lineTo(wing1.x, wing1.y);
      ctx.lineTo(x2, y2);
      ctx.lineTo(wing2.x, wing2.y);
      ctx.lineTo(shaft2.x, shaft2.y);
      ctx.closePath();

      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineJoin = 'round';
      if (head === 'open') {
        // 空心：只描轮廓 —— 杆身与头部一并是空心的
        ctx.lineWidth = Math.max(1, width * 0.8);
        ctx.stroke();
      } else {
        ctx.fill();
      }
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
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w / 2, 0.5), Math.max(r.h / 2, 0.5), 0, 0, Math.PI * 2);
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
      if (shape.mode === 'region') {
        mosaic(ctx, shape.x, shape.y, shape.w, shape.h);
      } else {
        mosaicBrush(ctx, shape.points, shape.radius);
      }
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
 * 把 `ctx` 上 [rx,ry,rw,rh] 区域（**当前变换下的坐标**）像素化，返回承载结果
 * 的 scratch 画布（内容与区域左上角对齐，尺寸 rw×rh）。
 *
 * 关键是**降的时候开平滑、升的时候关平滑** —— 反过来就只会得到模糊而不是色块。
 * 快照必须先做：不能把 canvas 画到自己身上。
 * 另外取样源矩形是 `drawImage` 的**源坐标**，不吃 ctx 变换 —— 遮罩的 ctx
 * 带 dpr 缩放，必须先乘回去，否则高 DPI 屏上糊的是错位一半的区域。
 */
function pixelatedRegion(
  ctx: CanvasRenderingContext2D,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  blockTarget: number,
): HTMLCanvasElement | null {
  const cols = Math.max(1, Math.round(rw / blockTarget));
  const rows = Math.max(1, Math.round(rh / blockTarget));

  const t = ctx.getTransform();
  const kx = t.a || 1;
  const ky = t.d || 1;

  const snap = getScratch('snap', rw, rh);
  const sctx = snap.getContext('2d');
  if (!sctx) return null;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, rw, rh);
  sctx.drawImage(ctx.canvas, rx * kx, ry * ky, rw * kx, rh * ky, 0, 0, rw, rh);

  const tmp = getScratch('tmp', cols, rows);
  const tctx = tmp.getContext('2d');
  if (!tctx) return null;
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, cols, rows);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(snap, 0, 0, rw, rh, 0, 0, cols, rows);

  const out = getScratch('pix', rw, rh);
  const octx = out.getContext('2d');
  if (!octx) return null;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, rw, rh);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(tmp, 0, 0, cols, rows, 0, 0, rw, rh);
  return out;
}

/** 选区式马赛克：拖出来的矩形整体像素化。 */
function mosaic(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const size = canvasSizeIn(ctx);
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const rw = Math.min(Math.round(w), size.w - rx);
  const rh = Math.min(Math.round(h), size.h - ry);
  if (rw < 1 || rh < 1) return;

  const blockTarget = Math.min(40, Math.max(6, Math.round(Math.min(rw, rh) / 14)));
  const pix = pixelatedRegion(ctx, rx, ry, rw, rh, blockTarget);
  if (!pix) return;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pix, 0, 0, rw, rh, rx, ry, rw, rh);
  ctx.imageSmoothingEnabled = true;
}

/**
 * 涂抹式马赛克：沿路径按半径逐个圆斑盖上去，半径即笔刷大小。
 *
 * 包围盒整体取一次样再逐斑裁圆 —— 逐斑取样会让重叠处反复对已像素化的内容
 * 再采样，越描越糊。每个圆斑单独 save/clip/restore：clip() 是累加的，
 * 循环外只做一次的话，第二个圆斑会画进前两个圆的交集里。
 */
function mosaicBrush(ctx: CanvasRenderingContext2D, points: Point[], radius: number): void {
  if (points.length === 0) return;
  const r = Math.max(2, Math.round(radius));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x - r < minX) minX = p.x - r;
    if (p.y - r < minY) minY = p.y - r;
    if (p.x + r > maxX) maxX = p.x + r;
    if (p.y + r > maxY) maxY = p.y + r;
  }
  const size = canvasSizeIn(ctx);
  const rx = Math.max(0, Math.floor(minX));
  const ry = Math.max(0, Math.floor(minY));
  const rw = Math.min(size.w, Math.ceil(maxX)) - rx;
  const rh = Math.min(size.h, Math.ceil(maxY)) - ry;
  if (rw < 1 || rh < 1) return;

  // 色块尺寸跟着笔刷半径走，比按区域尺寸推算更均匀
  const pix = pixelatedRegion(ctx, rx, ry, rw, rh, Math.max(4, r));
  if (!pix) return;

  ctx.imageSmoothingEnabled = false;
  for (const p of points) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(pix, 0, 0, rw, rh, rx, ry, rw, rh);
    ctx.restore();
  }
  ctx.imageSmoothingEnabled = true;
}

/** 拖动中的马赛克只画半透明框，避免每帧都做一次像素运算。 */
export function drawDraftRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
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
  if (shape.type === 'mosaic') {
    if (shape.mode === 'region') {
      const r = normRect(shape.x, shape.y, shape.w, shape.h);
      return { x: r.x, y: r.y, width: r.w, height: r.h };
    }
    // 涂抹：路径点向外扩一个半径
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
    const rr = shape.radius;
    return {
      x: minX - rr,
      y: minY - rr,
      width: maxX - minX + rr * 2,
      height: maxY - minY + rr * 2,
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
    return handle === 'p1' ? { ...origin, x1: cursor.x, y1: cursor.y } : { ...origin, x2: cursor.x, y2: cursor.y };
  }
  const box = shapeBBox(origin, ctx);
  const next = resizeRect(box, handle as HandleId, cursor);
  if (origin.type === 'rect' || origin.type === 'ellipse') {
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
export function isShapeHit(canvas: HTMLCanvasElement, shape: Shape, p: Point, tol: number): boolean {
  if (shape.type === 'mosaic') {
    if (shape.mode === 'region') {
      const r = normRect(shape.x, shape.y, shape.w, shape.h);
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }
    // 涂抹：任一圆斑盖住光标即命中，半径再放宽一个容差便于点选
    const rr = shape.radius + tol;
    return shape.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= rr);
  }

  const x0 = Math.max(0, Math.floor(p.x - tol));
  const y0 = Math.max(0, Math.floor(p.y - tol));
  const x1 = Math.min(canvas.width, Math.ceil(p.x + tol) + 1);
  const y1 = Math.min(canvas.height, Math.ceil(p.y + tol) + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return false;

  // 检测画布只开**检测框**那么大，再把图形平移进来 —— 按 canvas 全尺寸开
  // 的话，4K 屏上这是一个 33MB 的 scratch，每个窗口各挂一份到进程退出。
  const hit = getScratch('hit', w, h);
  const hctx = hit.getContext('2d');
  if (!hctx) return false;
  hctx.setTransform(1, 0, 0, 1, -x0, -y0);
  hctx.clearRect(0, 0, w, h);
  drawShape(hctx, shape);
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  const { data } = hctx.getImageData(0, 0, w, h);
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
export function drawSelection(ctx: CanvasRenderingContext2D, shape: Shape, unit: number): void {
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
      ctx.strokeRect(hp.x - unit / 2 + 0.5, hp.y - unit / 2 + 0.5, unit - 1, unit - 1);
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
  if (shape.type === 'mosaic') {
    if (shape.mode === 'region') {
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    }
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

/**
 * 拖动中的涂抹马赛克：只描路径，不做像素运算。
 * 与选区式的半透明框同一思路 —— 预览不必与最终结果一致，松手才像素化。
 */
export function drawDraftPath(ctx: CanvasRenderingContext2D, points: Point[], radius: number): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = Math.max(4, radius * 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
  ctx.stroke();
  ctx.restore();
}
