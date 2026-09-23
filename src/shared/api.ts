import type {
  OverlayActionKind,
  OverlayComposePayload,
  OverlayInitPayload,
  OverlayInput,
  OverlaySelectionPayload,
  OverlayTeardownPayload,
  PinAction,
  PinActionResult,
  PinInitPayload,
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
    /** 文字输入框开合，主进程据此决定要不要接管 Enter / Esc */
    editState(payload: { textEditing: boolean }): Promise<void>;
    /** 主进程推来合成数据（复制 / 保存），宿主遮罩就地拼图导出 */
    compose(
      cb: (payload: { kind: 'copy' | 'save'; data: OverlayComposePayload }) => void,
    ): () => void;
    /** 合成好的 PNG：交主进程进剪贴板 / 存盘，随后结束截图 */
    export(payload: {
      kind: 'copy' | 'save';
      png: Uint8Array;
    }): Promise<PinActionResult>;
  };
  pin: {
    /** 拉取拼接所需的全部数据 */
    boot(): Promise<PinInitPayload | null>;
    ready(payload: { width: number; height: number }): Promise<void>;
    action(payload: PinAction): Promise<PinActionResult>;
  };
  app: {
    state(cb: (payload: { snipping: boolean }) => void): () => void;
    startSnip(): Promise<void>;
  };
}
