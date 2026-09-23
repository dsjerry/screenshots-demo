import type { PinPadding } from './pin-layout';

/** 与方向无关的点，单位一律是虚拟屏 DIP（可为负）。 */
export interface Point {
  x: number;
  y: number;
}

/** 矩形，单位一律是虚拟屏 DIP（可为负）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 一块显示器的截图。
 *
 * `scaleX/scaleY` 是「每 DIP 对应多少物理像素」，从 `thumbnail.getSize()`
 * 回读得到 —— Electron 文档明确 thumbnailSize 不保证被遵守，
 * 所以绝不能直接用 `display.scaleFactor`。
 */
export interface DisplayShot {
  displayId: number;
  bounds: Rect;
  scaleX: number;
  scaleY: number;
  imageWidth: number;
  imageHeight: number;
  /** 缩略图的 PNG 字节 */
  png: Uint8Array;
}

export interface OverlayInitPayload {
  shot: DisplayShot;
  virtualBounds: Rect;
}

/**
 * 截图会话阶段。
 *
 * - `selecting`：正在框选（或尚未框选），不画手柄
 * - `adjusting`：松手后，8 向手柄 + 浮动工具条，选区可实时调整；
 *   `Enter` / 双击 = 复制，点「钉住」才进 `confirming`
 * - `confirming`：已确认钉住，等钉图就绪
 */
export type SnipPhase = 'selecting' | 'adjusting' | 'confirming';

export interface OverlaySelectionPayload {
  /** 虚拟屏 DIP；null 表示尚未产生选区 */
  selection: Rect | null;
  /** 当前光标位置，虚拟屏 DIP */
  cursor: Point;
  /** 当前选区按此比例换算成输出像素 */
  outScale: number;
  /** 只有 adjusting 才画手柄 */
  phase: SnipPhase;
  /** 工具条挂在哪块屏上（选区中心所在屏）；不在本屏就不渲染工具条 */
  toolbarDisplayId: number | null;
  /** 当前标注工具，其余遮罩据此决定「画标注」还是「调整选区」 */
  activeTool: ToolId;
}

/**
 * 遮罩工具条的动作 —— **没有「确定」**（主流截图工具都没有）：
 * - `pin`   进钉图窗口（本工具区别于主流的地方，标注原样带过去）
 * - `copy` / `save` 就地合成整图 → 剪贴板 / 存盘 → 结束截图
 * - `cancel` 取消
 */
export type OverlayActionKind = 'pin' | 'cancel' | 'copy' | 'save';

/** 遮罩就地合成导出所需的数据（主进程推给宿主遮罩）。 */
export interface OverlayComposePayload {
  shots: DisplayShot[];
  selection: Rect;
  outScale: number;
  /** 全部标注，**已换算成图像像素**（各屏合并后的坐标） */
  shapes: Shape[];
}

export type OverlayInput =
  | { kind: 'down' }
  | { kind: 'up' }
  | { kind: 'dblclick' }
  | { kind: 'enter' }
  | { kind: 'escape' }
  | { kind: 'context' };

export interface OverlayTeardownPayload {
  reason: 'confirm' | 'cancel';
}

export interface PinInitPayload {
  shots: DisplayShot[];
  selection: Rect;
  outScale: number;
  dipWidth: number;
  dipHeight: number;
  /** 窗口四边的阴影留白（DIP）：渲染进程据此让开画布位置，好让阴影露出来 */
  padding: PinPadding;
  /**
   * 遮罩阶段画的标注，**已换算成图像像素**（各屏本屏 DIP → 选区坐标 × outScale）。
   * 钉图 seed 进编辑器后继续可编辑。
   */
  initialShapes: Shape[];
}

export type PinAction =
  | { kind: 'copy'; png: Uint8Array }
  | { kind: 'save'; png: Uint8Array; suggestedName: string }
  | { kind: 'close' };

export interface PinActionResult {
  ok: boolean;
  error?: string;
}

export type ToolId =
  | 'hand'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'pen'
  | 'mosaic'
  | 'text';

export interface StrokeBase {
  color: string;
  width: number;
}

/**
 * 所有标注坐标都在**图像像素空间**（画布 backing store 的像素），
 * 与窗口 DIP / devicePixelRatio 无关，因此拖动窗口不会让标注错位。
 */
export type Shape =
  | ({ type: 'arrow' } & StrokeBase & { x1: number; y1: number; x2: number; y2: number })
  | ({ type: 'rect' } & StrokeBase & { x: number; y: number; w: number; h: number })
  | ({ type: 'ellipse' } & StrokeBase & { x: number; y: number; w: number; h: number })
  | ({ type: 'pen' } & StrokeBase & { points: Point[] })
  | { type: 'mosaic'; x: number; y: number; w: number; h: number }
  | { type: 'text'; x: number; y: number; text: string; color: string; size: number };
