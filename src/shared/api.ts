import type {
  AppSettings,
  HistoryActionKind,
  HistoryEntryInfo,
  OcrResultPayload,
  OverlayActionKind,
  OverlayComposePayload,
  OverlayInitPayload,
  OverlayInput,
  OverlayRemoteDraftPayload,
  OverlayRemoteShapesPayload,
  OverlaySelectionPayload,
  OverlayTeardownPayload,
  PinAction,
  PinActionResult,
  PinBootPayload,
  RecordActionPayload,
  RecordActionResult,
  RecordClickPayload,
  RecordExportPayload,
  RecordBrushPayload,
  RecordFormat,
  RecordFramePayload,
  RecordInkInputPayload,
  RecordStatusPayload,
  RecordTimelinePayload,
  ScrollActionPayload,
  ScrollFramePayload,
  SettingsPatch,
  Shape,
  ToolId,
} from './types';

/** preload 暴露给渲染进程的 API 形状，主窗口 / overlay / pin 三个窗口共用。 */
export interface ScreenshotsApi {
  overlay: {
    /** 拉取本窗口对应的截图；会话已结束则返回 null */
    boot(): Promise<OverlayInitPayload | null>;
    selection(cb: (payload: OverlaySelectionPayload) => void): () => void;
    teardown(cb: (payload: OverlayTeardownPayload) => void): () => void;
    ready(): Promise<void>;
    input(payload: OverlayInput): Promise<void>;
    /** 换标注工具；主进程会广播给其余遮罩 */
    tool(payload: { tool: ToolId }): Promise<void>;
    /** 工具条动作（确定 / 取消 / 复制 / 保存） */
    action(payload: { kind: OverlayActionKind }): Promise<void>;
    /** 把本屏标注（本屏 DIP 坐标）回传，仅在历史变化时调 */
    shapes(payload: { shapes: Shape[] }): Promise<void>;
    /** 把本屏正在拖画的草稿（本屏 DIP 坐标）回传，主进程换算后投影到其余屏 */
    draft(payload: { draft: Shape | null }): Promise<void>;
    /** 本屏正在拖动 / 缩放的标注下标（null = 结束）；主进程广播时把它滤掉 */
    inFlight(payload: { index: number | null }): Promise<void>;
    /** 其余屏已提交的标注（虚拟屏 DIP），本屏只负责渲染落在本屏的部分 */
    remoteShapes(cb: (payload: OverlayRemoteShapesPayload) => void): () => void;
    /** 其余屏正在拖画的草稿（虚拟屏 DIP）；draft 为 null 表示草稿结束 */
    remoteDraft(cb: (payload: OverlayRemoteDraftPayload) => void): () => void;
    /** 文字输入框开合，主进程据此决定要不要接管 Enter / Esc */
    editState(payload: { textEditing: boolean }): Promise<void>;
    /** 把本遮罩提到前台（光标移到哪块屏，键盘事件就归哪块屏） */
    focus(): Promise<void>;
    /** 写入剪贴板文本（放大镜的复制颜色值） */
    copyText(payload: { text: string }): Promise<PinActionResult>;
    /** 主进程推来合成数据（复制 / 保存），宿主遮罩就地拼图导出 */
    compose(cb: (payload: { kind: 'copy' | 'save'; data: OverlayComposePayload }) => void): () => void;
    /** 合成好的 PNG：交主进程进剪贴板 / 存盘，随后结束截图 */
    export(payload: { kind: 'copy' | 'save'; png: Uint8Array }): Promise<PinActionResult>;
    /** OCR 识别结果（识别在主进程异步进行，完成后推回） */
    ocrResult(cb: (payload: OcrResultPayload) => void): () => void;
    /** 进入录制模式（遮罩收起，改由录制控制条接管） */
    record(): Promise<void>;
  };
  /**
   * 录制控制条：录制中显示状态与动作，**录制完成后才停在原地**等导出。
   *
   * 控制条窗口只在录制期间存在（每屏一个不成立 —— 录制区域限定单屏），
   * 导出后由主进程关窗；本 API 只服务它自己。
   */
  recorder: {
    /** 主进程推来的一帧录制画面（按选区裁好的 RGBA，尺寸恒定） */
    frame(cb: (payload: RecordFramePayload) => void): () => void;
    /** 状态推进（帧数 / 时长 / 阶段） */
    status(cb: (payload: RecordStatusPayload) => void): () => void;
    /** 暂停 / 继续 / 停止 / 取消 */
    action(payload: RecordActionPayload): Promise<RecordActionResult>;
    /** 切换输出格式（编码在控制条里做，主进程只记一份给状态用） */
    format(payload: { format: RecordFormat }): Promise<RecordActionResult>;
    /** 录制期间在画面上叠加的标注（本窗口 DIP，主进程按收到时刻记进时间轴） */
    shapes(payload: { shapes: Shape[] }): Promise<void>;
    /** 点击涟漪事件（相对录制起点的毫秒 + 录制区域内的 DIP 坐标） */
    click(payload: RecordClickPayload): Promise<void>;
    /** 标注层是否接管指针：true = 覆盖层收指针画标注；false = 点击穿透 */
    ink(active: boolean): Promise<void>;
    /** 标注层：指针接管状态的主进程回执（本窗口据此切换指针事件） */
    inkActive(cb: (payload: { active: boolean }) => void): () => void;
    /** 标注层：压笔 / 移动 / 抬笔（Windows 由主进程按全局光标下发，本窗口自身收不到指针） */
    inkInput(cb: (payload: RecordInkInputPayload) => void): () => void;
    /** 标注层：接收工具条窗口下发的笔刷 / 编辑命令 */
    brush(cb: (payload: RecordBrushPayload) => void): () => void;
    /** 工具条窗口：把当前笔刷（或历史命令）推给标注层 */
    brushSet(payload: RecordBrushPayload): Promise<void>;
    /** 编码前取走时间轴（标注快照 / 点击涟漪 / 区域）；会话已结束返回 null */
    timeline(): Promise<RecordTimelinePayload | null>;
    /** 导出（复制 = 路径进剪贴板；保存 = 弹目录选择） */
    export(payload: RecordExportPayload): Promise<RecordActionResult>;
  };
  pin: {
    /** 拉取拼接所需的全部数据（截图会话拼接或历史独立图片） */
    boot(): Promise<PinBootPayload | null>;
    ready(payload: { width: number; height: number }): Promise<void>;
    action(payload: PinAction): Promise<PinActionResult>;
  };
  scroll: {
    /** 主进程推来的一帧选区条带（已裁好的 RGBA） */
    frame(cb: (payload: ScrollFramePayload) => void): () => void;
    /** 复制 / 保存（随带拼接好的长图 PNG）/ 取消 */
    action(payload: ScrollActionPayload): Promise<void>;
  };
  history: {
    /** 拉取历史条目列表 */
    boot(): Promise<HistoryEntryInfo[]>;
    /** 单条缩略图（dataURL） */
    thumb(id: number): Promise<string>;
    /** 复制 / 贴图 / 保存 / 删除 */
    action(payload: { kind: HistoryActionKind; id: number }): Promise<void>;
    /** 打开（或聚焦）历史窗口（面板「查看全部」） */
    open(): Promise<void>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: SettingsPatch): Promise<AppSettings>;
    /** 系统目录选择对话框；取消返回 null */
    pickDir(): Promise<string | null>;
  };
  app: {
    state(cb: (payload: { snipping: boolean }) => void): () => void;
    startSnip(): Promise<void>;
  };
}
