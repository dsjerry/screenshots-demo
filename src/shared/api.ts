import type {
  AppSettings,
  HistoryActionKind,
  HistoryEntryInfo,
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
  SettingsPatch,
  Shape,
} from './types';

/** preload 暴露给渲染进程的 API 形状，主窗口 / overlay / pin 三个窗口共用。 */
export interface ScreenshotsApi {
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
