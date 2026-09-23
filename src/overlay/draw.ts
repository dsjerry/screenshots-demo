import type { DisplayShot, OverlaySelectionPayload, Rect } from '../shared/types';
import { HANDLE_IDS, HANDLE_SIZE_DIP, handlePoint } from '../shared/selection';

const MASK = 'rgba(0, 0, 0, 0.45)';

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, width: x2 - x, height: y2 - y };
}

export interface OverlayRenderState {
  shot: DisplayShot;
  payload: OverlaySelectionPayload | null;
}

/**
 * 把「虚拟屏 DIP」坐标下的选区画到本窗口（本窗口 = 单块显示器）。
 *
 * 画布 backing store 已按 devicePixelRatio 放大，因此统一先 setTransform 到
 * CSS 像素（本窗口里 CSS px ≡ 本显示器 DIP），再做平移即可。
 */
export function renderOverlay(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  bg: CanvasImageSource,
  state: OverlayRenderState,
): void {
  // 先在设备像素空间清干净，再切到 CSS 像素（本窗口 CSS px ≡ 本显示器 DIP）。
  // 注意不能直接 setTransform(1,0,0,1,0,0) —— 那是单位矩阵，在 dpr≠1 的屏上
  // 会只画进画布左上 1/dpr 的区域，剩下是黑的（选框也会跟着对不上）。
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const scale = cssWidth > 0 ? ctx.canvas.width / cssWidth : 1;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // 本窗口原点（虚拟屏 DIP）
  const origin = state.shot.bounds;

  ctx.drawImage(bg, 0, 0, cssWidth, cssHeight);
  ctx.fillStyle = MASK;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const payload = state.payload;
  if (!payload?.selection) return;

  const local = intersect(payload.selection, origin);
  if (!local) return;

  const lx = local.x - origin.x;
  const ly = local.y - origin.y;
  const lw = local.width;
  const lh = local.height;

  // 选区内重新铺一次原图 = 把遮罩“擦掉”
  ctx.save();
  ctx.beginPath();
  ctx.rect(lx, ly, lw, lh);
  ctx.clip();
  ctx.drawImage(bg, 0, 0, cssWidth, cssHeight);
  ctx.restore();

  // 边框：先黑后白，保证在任何底色上都看得见
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeRect(lx - 0.5, ly - 0.5, lw + 1, lh + 1);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#ffffff';
  ctx.strokeRect(lx + 0.5, ly + 0.5, Math.max(0, lw - 1), Math.max(0, lh - 1));

  // 松手进入 adjusting 才出手柄：框选过程中手柄只会碍事
  if (payload.phase === 'adjusting') {
    drawHandles(ctx, payload.selection, origin, cssWidth, cssHeight);
  }

  drawSizeLabel(ctx, cssWidth, cssHeight, origin, payload);
}

/**
 * 8 向手柄。手柄位置一律从**完整选区**算，再平移到本窗口 ——
 * 跨屏选区被本屏裁掉的那些角不属于本屏，跳过即可（那块屏的遮罩会画）。
 */
function drawHandles(
  ctx: CanvasRenderingContext2D,
  selection: Rect,
  origin: Rect,
  cssWidth: number,
  cssHeight: number,
): void {
  const size = HANDLE_SIZE_DIP;
  for (const id of HANDLE_IDS) {
    const h = handlePoint(selection, id);
    const x = h.x - origin.x - size / 2;
    const y = h.y - origin.y - size / 2;
    if (x + size < 0 || y + size < 0 || x > cssWidth || y > cssHeight) {
      continue;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, size, size);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  }
}

function drawSizeLabel(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  origin: Rect,
  payload: OverlaySelectionPayload,
): void {
  const sel = payload.selection;
  if (!sel) return;

  const outW = Math.round(sel.width * payload.outScale);
  const outH = Math.round(sel.height * payload.outScale);
  const text = `${outW} × ${outH}`;

  ctx.font =
    '12px "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif';
  const tw = ctx.measureText(text).width;
  const boxW = Math.ceil(tw) + 14;
  const boxH = 20;

  // 标签优先贴在选区左上角；那个角不在本屏（跨屏选区）时改贴光标
  let x: number;
  let y: number;
  const cornerInThisDisplay =
    sel.x >= origin.x &&
    sel.x < origin.x + origin.width &&
    sel.y >= origin.y &&
    sel.y < origin.y + origin.height;
  if (cornerInThisDisplay) {
    x = sel.x - origin.x + 6;
    y = sel.y - origin.y + 6;
  } else {
    x = payload.cursor.x - origin.x + 14;
    y = payload.cursor.y - origin.y + 16;
  }
  x = Math.min(Math.max(4, x), cssWidth - boxW - 4);
  y = Math.min(Math.max(4, y), cssHeight - boxH - 4);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 7, y + boxH / 2 + 0.5);
}
