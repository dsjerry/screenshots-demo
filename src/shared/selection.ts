import type { Point, Rect } from './types';

/**
 * 选区的 8 个调整手柄。
 *
 * 主进程用它判定「这一下拖动是在调手柄、整体移动，还是重新框选」，
 * 遮罩渲染进程用同一套几何画手柄和鼠标样式 —— 两边必须一致，
 * 否则会出现「看得见但拖不动 / 看不见却拖动了」。
 */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLE_IDS: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 手柄命中半径（虚拟屏 DIP）。 */
export const HANDLE_HIT_DIP = 12;

/** 手柄绘制边长（虚拟屏 DIP）。 */
export const HANDLE_SIZE_DIP = 8;

/** 调整时选区的最小边长（DIP），防止拖成 0×0 后再也抓不到手柄。 */
const MIN_EDGE = 1;

export function handlePoint(rect: Rect, id: HandleId): Point {
  const { x, y, width, height } = rect;
  const cx = x + width / 2;
  const cy = y + height / 2;
  switch (id) {
    case 'nw':
      return { x, y };
    case 'n':
      return { x: cx, y };
    case 'ne':
      return { x: x + width, y };
    case 'e':
      return { x: x + width, y: cy };
    case 'se':
      return { x: x + width, y: y + height };
    case 's':
      return { x: cx, y: y + height };
    case 'sw':
      return { x, y: y + height };
    case 'w':
      return { x, y: cy };
  }
}

/** 主进程用：光标落在哪个手柄上（不限定显示在不在本屏）。 */
export function hitHandle(
  rect: Rect,
  p: Point,
  threshold = HANDLE_HIT_DIP,
): HandleId | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  for (const id of HANDLE_IDS) {
    const h = handlePoint(rect, id);
    if (Math.hypot(h.x - p.x, h.y - p.y) <= threshold) return id;
  }
  return null;
}

/**
 * 遮罩渲染进程用：手柄先换算到本窗口坐标，**落在窗外的直接跳过** ——
 * 跨屏选区的某个角可能在另一块屏上，那边由那块屏的遮罩画/响应，
 * 本屏不能凭「裁剪后的矩形角」伪造一个手柄出来。
 */
export function hitHandleIn(
  selection: Rect,
  origin: Rect,
  p: Point,
  viewport: { width: number; height: number },
  threshold = HANDLE_HIT_DIP,
): HandleId | null {
  if (selection.width <= 0 || selection.height <= 0) return null;
  for (const id of HANDLE_IDS) {
    const h = handlePoint(selection, id);
    const lx = h.x - origin.x;
    const ly = h.y - origin.y;
    if (lx < 0 || ly < 0 || lx > viewport.width || ly > viewport.height) {
      continue;
    }
    if (Math.hypot(lx - p.x, ly - p.y) <= threshold) return id;
  }
  return null;
}

export function pointInRect(rect: Rect, p: Point): boolean {
  return (
    p.x >= rect.x &&
    p.x <= rect.x + rect.width &&
    p.y >= rect.y &&
    p.y <= rect.y + rect.height
  );
}

/** 整体移动：按「按下点 → 当前光标」的位移平移原矩形。 */
export function moveRect(origin: Rect, start: Point, cursor: Point): Rect {
  return {
    ...origin,
    x: origin.x + (cursor.x - start.x),
    y: origin.y + (cursor.y - start.y),
  };
}

/**
 * 把矩形夹回边界内 —— 选区的「窗体碰撞」：拖动 / 调整时越出虚拟桌面
 * 的部分贴边停住，光标继续走选区也不动，往回拖立刻恢复跟随。
 * （选区比边界还宽的退化情形下贴左 / 上边，正常光标操作到不了这一步。）
 */
export function clampRect(rect: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - rect.width));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - rect.height));
  return { ...rect, x, y };
}

/** 拖动手柄调整：对侧的边固定，被拖的边/角跟着光标走，允许反向拖动翻转。 */
export function resizeRect(
  origin: Rect,
  handle: HandleId,
  cursor: Point,
): Rect {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (handle.includes('w')) left = Math.min(cursor.x, right - MIN_EDGE);
  if (handle.includes('e')) right = Math.max(cursor.x, left + MIN_EDGE);
  if (handle.includes('n')) top = Math.min(cursor.y, bottom - MIN_EDGE);
  if (handle.includes('s')) bottom = Math.max(cursor.y, top + MIN_EDGE);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};
