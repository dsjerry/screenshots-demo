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
    compose(
      cb: (payload: {
        kind: 'copy' | 'save';
        data: OverlayComposePayload;
      }) => void,
    ): () => void;
    /** 合成好的 PNG：交主进程进剪贴板 / 存盘，随后结束截图 */
    export(payload: {
      kind: 'copy' | 'save';
      png: Uint8Array;
    }): Promise<PinActionResult>;
    /** OCR 识别结果（识别在主进程异步进行，完成后推回） */
    ocrResult(cb: (payload: OcrResultPayload) => void): () => void;
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
