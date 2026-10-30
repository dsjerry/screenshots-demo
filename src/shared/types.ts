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
 * - `recording`：录屏 —— 遮罩已收起，由录制控制条接管
 */
export type SnipPhase = 'selecting' | 'adjusting' | 'confirming' | 'scrolling' | 'recording';

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
 * - `record` 进入录屏（遮罩收起，由录制控制条接管）
 * - `cancel` 取消
 */
export type OverlayActionKind = 'pin' | 'cancel' | 'copy' | 'save' | 'scroll' | 'ocr' | 'record';

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
  /** 采录时的前台应用（会话开始时探得，拿不到就缺省） */
  app?: string;
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

/** 截图历史的保留策略：不记录 / 仅本次运行（内存，默认）/ 落盘持久化 */
export type HistoryRetention = 'off' | 'session' | 'persistent';

export interface AppSettings {
  /** 全局截图快捷键（Electron accelerator 字符串） */
  hotkey: string;
  /** 开机自启 */
  autoStart: boolean;
  /** 保存目录 */
  saveDir: string;
  /** 默认保存格式 */
  saveFormat: SaveFormat;
  /** macOS Liquid Glass 烟熏染色（0-100 透明度；越高越透、染色越淡） */
  glassTransparency: number;
  /** 截图历史保留策略（默认仅会话内 —— 隐私上保守，落盘要用户明说） */
  historyRetention: HistoryRetention;
}

export type SettingsPatch = Partial<AppSettings>;

export type ToolId = 'hand' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'pen' | 'marker' | 'mosaic' | 'counter' | 'text';

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

// ------------------------------------------------------------------ 录屏 / GIF

/**
 * 录制产物格式。
 *
 * - `gif`：离线自编码（`shared/gif.ts` + `record/quantize.ts`），聊天 / 文档里
 *   能直接预览；只有 256 色，体积大
 * - `mp4`：计划走系统编码器（mac AVAssetWriter / Windows Media Foundation），
 *   **尚未接入**，下拉里置灰
 * - `png-sequence`：逐帧 PNG 落到自己新建的子目录，无损、零编码器依赖，
 *   是无 GIF 可用的兜底产物
 */
export type RecordFormat = 'gif' | 'mp4' | 'png-sequence';

/** 录制控制条的阶段：录制中 / 已暂停 / 已停止待导出 */
export type RecordPhase = 'recording' | 'paused' | 'stopped';

/** 主进程推给控制条的录制状态（帧数、时长、产物尺寸）。 */
export interface RecordStatusPayload {
  phase: RecordPhase;
  /** 已采集并编码的帧数 */
  frames: number;
  /** 从开始录制到现在的墙钟时长（暂停不计），毫秒 */
  elapsed: number;
  /** 最近一帧的像素尺寸 */
  width: number;
  height: number;
  /** 录制区域（虚拟屏 DIP），控制条据此摆放与标注坐标换算 */
  region: Rect;
  format: RecordFormat;
}

/** 录制中叠加的标注快照（标注层渲染进程回传，主进程按收到时刻记进时间轴）。 */
export interface RecordShapesPayload {
  shapes: Shape[];
}

/** 一份标注快照及其生效时刻（相对录制起点毫秒，单调递增）。 */
export interface RecordShapeSnapshot {
  shapes: Shape[];
  at: number;
}

/** 录制中光标位置的涟漪（点击可视化）：虚拟屏 DIP。 */
export interface RecordClickPayload {
  point: Point;
  /** 落点时间（录制起点为 0 的相对毫秒），导出时据此决定在哪些帧上画 */
  at: number;
}

/** 控制条动作：开始 / 暂停 / 继续 / 停止 / 取消 / 导出（复制 / 保存）。 */
export type RecordActionPayload =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'cancel' }
  | { kind: 'copy' }
  | { kind: 'save' }
  | { kind: 'format'; format: RecordFormat };

export interface RecordActionResult {
  ok: boolean;
  /** 失败原因；用户取消保存对话框时是「已取消」，控制条据此提示而不报错 */
  error?: string;
  /** 落盘后的**绝对路径**（单文件是文件、png-sequence 是目录） */
  path?: string;
  /** 用户主动取消（不是失败） */
  canceled?: boolean;
}

/** 主 -> 录制控制条：一帧录制画面（按选区裁好的 RGBA，尺寸恒定） */
export interface RecordFramePayload {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** 抓帧时刻（相对录制起点毫秒，主进程时钟）—— 编码时据此对齐标注快照 */
  at: number;
}

/**
 * 录制时间轴：编码前由控制条向主进程一次性取走（标注快照 / 点击涟漪 / 选区）。
 * 所有时刻都是主进程的「相对录制起点毫秒」，与 `RecordFramePayload.at` 同一时钟，
 * 暂停期间双方一起冻结 —— 控制条不要拿自己的 performance.now() 去对齐。
 */
export interface RecordTimelinePayload {
  /** 标注快照序列（每次历史变化一条，`at` 递增）；shapes 为录制区域 DIP 坐标 */
  snapshots: RecordShapeSnapshot[];
  /** 点击涟漪：录制区域 DIP 坐标 + 相对录制起点毫秒 */
  clicks: { point: Point; at: number }[];
  /** 录制区域（虚拟屏 DIP），控制条据此把 DIP 标注换算到帧的物理像素 */
  region: Rect;
  /** 目标帧率（帧间隔 = 1000 / fps 毫秒），编码时按它给每帧算显示时长 */
  fps: number;
  sourceApp?: string;
}

/**
 * 录制控制条 -> 主：导出结果。
 *
 * 两条路径都由主进程负责落盘与剪贴板，控制条只管编码：
 * - `copy`：单文件成品（gif / mp4）直接进剪贴板；`png-sequence` 没有单文件
 *   形态，复制不了图像，只能**保存**后把路径放剪贴板（见主进程说明）；
 * - `save`：走系统保存对话框，默认落在设置的 `saveDir`。
 */
export interface RecordExportPayload {
  kind: 'copy' | 'save';
  format: RecordFormat;
  /** gif / mp4 成品字节 */
  data?: Uint8Array;
  /** png-sequence：逐帧 PNG */
  files?: Uint8Array[];
}

/** 标注层压笔 / 移动 / 抬笔（由主进程转发的全局光标驱动，坐标是本窗口 CSS px）。 */
export interface RecordInkInputPayload {
  kind: 'down' | 'move' | 'up';
  point: Point;
}

/**
 * 控制条（或工具条窗口）下发给标注层的笔刷状态与编辑命令。
 * 主进程原样转发给标注层窗口，不解释内容。
 */
export interface RecordBrushPayload {
  tool?: ToolId;
  color?: string;
  width?: number;
  arrowHead?: ArrowHead;
  fontSize?: number;
  mosaicMode?: MosaicMode;
  /** 历史操作遥控：标注层的编辑器执行（工具条窗口与标注层不在同一进程） */
  cmd?: 'undo' | 'redo' | 'clear' | 'delete';
}
