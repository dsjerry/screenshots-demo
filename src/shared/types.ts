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
  /**
   * 屏幕原始位图（RGBA，imageWidth × imageHeight × 4 字节）。
   * 不用 PNG：整屏 PNG 的同步编码 + 渲染端解码要几百毫秒，
   * 原始位图 IPC 直传（structured clone 一次 memcpy）然后直接进 ImageData。
   */
  pixels: Uint8Array;
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
 * - `scrolling`：滚动截长图 —— 遮罩已收起，由滚动截图专用窗口接管
 */
export type SnipPhase = 'selecting' | 'adjusting' | 'confirming' | 'scrolling';

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
  /**
   * 光标下的应用窗口（虚拟屏 DIP）。仅在 selecting 且尚无选区时非空：
   * 遮罩据此画高亮框（主流截图工具的窗口捕获），此时按下鼠标即采纳为选区。
   */
  hoverRect: Rect | null;
}

/**
 * 遮罩工具条的动作 —— **没有「确定」**（主流截图工具都没有）：
 * - `pin`   进钉图窗口（本工具区别于主流的地方，标注原样带过去）
 * - `copy` / `save` 就地合成整图 → 剪贴板 / 存盘 → 结束截图
 * - `scroll` 进入滚动截长图（遮罩收起，由专用窗口接管）
 * - `cancel` 取消
 */
export type OverlayActionKind =
  | 'pin'
  | 'cancel'
  | 'copy'
  | 'save'
  | 'scroll'
  | 'ocr';

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
  | { kind: 'context' }
  /** 方向键微调选区（adjusting 阶段）：渲染端给的 DIP 增量，主进程钳制碰撞 */
  | { kind: 'nudge'; dx: number; dy: number }
  /** Tab 轮换光标下的重叠窗口（窗口捕获阶段） */
  | { kind: 'cycle-window' };

export interface OverlayTeardownPayload {
  reason: 'confirm' | 'cancel';
}

/**
 * 滚动截长图的单帧：已按选区裁好的原始 RGBA 条带，
 * 主进程按固定间隔抓屏裁剪后推给控制条渲染进程拼接。
 */
export interface ScrollFramePayload {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/**
 * 滚动截图控制条的动作：
 * - `auto` / `manual` 切换滚动方式（自动 = 主进程注入滚轮）
 * - `speed` 切换自动滚动速度（speed 字段）
 * - `bottom` 自动模式下渲染端判定已到底，主进程停止注入
 * - `edit` 把拼接好的长图送进贴图编辑模式
 * - `copy` / `save` 随带拼接完成的 PNG 结束；`cancel` 收场
 */
export type ScrollSpeed = 'slow' | 'normal' | 'fast';

export interface ScrollActionPayload {
  kind: 'copy' | 'save' | 'cancel' | 'auto' | 'manual' | 'bottom' | 'edit' | 'speed';
  png?: Uint8Array;
  speed?: ScrollSpeed;
}

/**
 * 主进程广播给**其余遮罩**的跨屏标注（来源屏已提交的全部标注）。
 * 坐标已换算成虚拟屏 DIP —— 接收方减去自己那块屏的原点就是本窗口局部坐标。
 */
export interface OverlayRemoteShapesPayload {
  /** 来源屏的 displayId，接收方据此过滤自己 */
  fromDisplayId: number;
  shapes: Shape[];
}

/** 其余遮罩正在拖画的草稿（虚拟屏 DIP）；`draft` 为 null 表示草稿已结束。 */
export interface OverlayRemoteDraftPayload {
  fromDisplayId: number;
  draft: Shape | null;
}

/**
 * 本屏正在被拖动 / 缩放的标注下标（null = 拖动结束）。主进程对内仍存
 * 全量快照（导出 / 钉图用），只在对其余遮罩广播时把它滤掉 —— 其余屏
 * 改画拖动副本，不会旧位、新位叠着两份。
 */
export interface OverlayInFlightPayload {
  index: number | null;
}

export interface PinInitPayload {
  kind: 'snip';
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
  | { kind: 'close' }
  /** 滚轮缩放：窗口尺寸 × factor，光标下的点保持不动 */
  | { kind: 'zoom'; factor: number }
  /** Ctrl+滚轮 调整贴图不透明度（±delta） */
  | { kind: 'opacity'; delta: number }
  /** Ctrl+T 切换鼠标点击穿透 */
  | { kind: 'ignore' };

export interface PinActionResult {
  ok: boolean;
  error?: string;
}

/** 贴图窗口的两种来源：截图会话的拼接结果，或历史记录里的独立图片 */
export interface PinImageInitPayload {
  kind: 'image';
  png: Uint8Array;
  width: number;
  height: number;
  /** 打开后直接进入标注编辑模式（长图二次编辑用） */
  editMode: boolean;
}

export type PinBootPayload = PinInitPayload | PinImageInitPayload;

/** 截图历史条目信息（缩略图与原图按 id 另取） */
export interface HistoryEntryInfo {
  id: number;
  width: number;
  height: number;
  time: number;
}

export type HistoryActionKind = 'copy' | 'pin' | 'save' | 'delete';

/** OCR 识别结果（主进程推回发起识别的遮罩） */
export interface OcrResultPayload {
  ok: boolean;
  text?: string;
  error?: string;
}

/** 应用设置（主窗口设置页读写，settings.json 持久化） */
export type SaveFormat = 'png' | 'jpg';

export interface AppSettings {
  /** 全局截图快捷键（Electron accelerator 字符串） */
  hotkey: string;
  /** 开机自启 */
  autoStart: boolean;
  /** 保存目录 */
  saveDir: string;
  /** 默认保存格式 */
  saveFormat: SaveFormat;
}

export type SettingsPatch = Partial<AppSettings>;

export type ToolId =
  | 'hand'
  | 'arrow'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'pen'
  | 'marker'
  | 'mosaic'
  | 'counter'
  | 'text';

export interface StrokeBase {
  color: string;
  width: number;
}

/**
 * 所有标注坐标都在**图像像素空间**（画布 backing store 的像素），
 * 与窗口 DIP / devicePixelRatio 无关，因此拖动窗口不会让标注错位。
 */
/** 箭头样式：实心（整支填充）/ 空心（整支描边，杆身与头部同为空心） */
export type ArrowHead = 'solid' | 'open';

/** 马赛克绘制形式：选区（拖矩形）/ 涂抹（沿路径的笔刷圆斑）/ 高斯模糊 */
export type MosaicMode = 'region' | 'brush' | 'blur';

export type Shape =
  | ({ type: 'arrow' } & StrokeBase & {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        head: ArrowHead;
      })
  | ({ type: 'line' } & StrokeBase & {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      })
  | ({ type: 'rect' } & StrokeBase & { x: number; y: number; w: number; h: number })
  | ({ type: 'ellipse' } & StrokeBase & { x: number; y: number; w: number; h: number })
  | ({ type: 'pen' } & StrokeBase & { points: Point[] })
  | ({ type: 'mosaic' } & (
      | { mode: 'region'; x: number; y: number; w: number; h: number }
      | { mode: 'brush'; points: Point[]; radius: number }
      | { mode: 'blur'; x: number; y: number; w: number; h: number }
    ))
  | { type: 'counter'; x: number; y: number; n: number; color: string }
  | { type: 'text'; x: number; y: number; text: string; color: string; size: number };
