/**
 * IPC 通道名的唯一来源 —— 任何地方都不允许写字符串字面量。
 *
 * 主 -> 渲染：`selection` / `teardown` / `compose` / `appState` /
 *           `remoteShapes` / `remoteDraft` / `scrollFrame`（事件，send）
 * 渲染 -> 主：`boot` / `ready` / `input` / `tool` / `action` / `shapes` / `draft` /
 *           `editState` / `move` / `action(pin)` / `startSnip` / `action(scroll)`（invoke）
 *
 * `boot` 用 invoke 而不是 send，是为了避免「主进程先 send、渲染进程还没订阅」的竞态。
 * `tool` / `action` / `shapes` / `draft` / `editState` 是**遮罩阶段的标注**用的：
 * 选区下方浮条选工具、点动作、回传本屏标注与拖画草稿、告知文字输入框开合；
 * `remoteShapes` / `remoteDraft` 把一块屏的标注实时投影到其余屏（跨屏画图）。
 */
export const CH = {
  overlayBoot: 'overlay:boot',
  overlaySelection: 'overlay:selection',
  overlayTeardown: 'overlay:teardown',
  overlayReady: 'overlay:ready',
  overlayInput: 'overlay:input',
  /** 遮罩选了哪个标注工具（主进程广播给其余遮罩，跨屏画图要一致） */
  overlayTool: 'overlay:tool',
  /** 遮罩工具条的动作：钉住 / 取消 / 复制 / 保存 */
  overlayAction: 'overlay:action',
  /** 主 -> 遮罩：把合成数据推给宿主遮罩，就地拼图导出（复制 / 保存） */
  overlayCompose: 'overlay:compose',
  /** 遮罩 -> 主：合成好的 PNG，交给主进程进剪贴板 / 存盘 */
  overlayExport: 'overlay:export',
  /** 光标所在屏的遮罩请求前台 —— 保证键盘事件归正确的窗口 */
  overlayFocus: 'overlay:focus',
  /** 写入剪贴板文本（放大镜复制颜色值） */
  overlayCopyText: 'overlay:copyText',
  /** 遮罩把本屏标注（本屏 DIP）回传给主进程，确认时统一换算 */
  overlayShapes: 'overlay:shapes',
  /** 遮罩 -> 主：本屏正在拖画的草稿（本屏 DIP），主进程换算后广播给其余遮罩 */
  overlayDraft: 'overlay:draft',
  /** 遮罩 -> 主：本屏正在拖动 / 缩放的标注下标（null = 结束），广播时滤掉 */
  overlayInFlight: 'overlay:inFlight',
  /** 主 -> 遮罩：其余屏已提交的标注（虚拟屏 DIP） */
  overlayRemoteShapes: 'overlay:remoteShapes',
  /** 主 -> 遮罩：其余屏正在拖画的草稿（虚拟屏 DIP；null = 草稿结束） */
  overlayRemoteDraft: 'overlay:remoteDraft',
  /** 文字输入框开合 —— 打字时主进程别把 Enter/Esc 吃掉 */
  overlayEditState: 'overlay:editState',

  /** 遮罩工具条「录制」：进录制模式（收起遮罩、起控制条） */
  overlayRecord: 'overlay:record',

  /** 主 -> 录制控制条：一帧录制画面（按选区裁好的 RGBA） */
  recordFrame: 'record:frame',
  /** 主 -> 录制控制条：状态推进（帧数 / 时长 / 阶段） */
  recordStatus: 'record:status',
  /** 录制控制条 -> 主：导出时回传成品字节（gif / mp4）或帧文件 */
  recordExport: 'record:export',
  /** 录制控制条 -> 主：控制条自身的动作（暂停 / 继续 / 停止 / 取消 / 导出 / 换格式） */
  recordAction: 'record:action',
  /** 控制条 -> 主：标注层是否接管指针。主进程处理后把同一 payload 回发给标注层窗口（切换指针事件） */
  recordInk: 'record:ink',
  /** 主 -> 标注层：压笔 / 移动 / 抬笔（主进程轮询全局光标后下发） */
  recordInkInput: 'record:inkInput',
  /** 主 -> 标注层：控制条下发的笔刷（工具 / 颜色 / 线宽） */
  recordBrush: 'record:brush',
  /** 录制控制条 -> 主：笔刷变化（主进程只做转发，不解释） */
  recordBrushSet: 'record:brushSet',
  /** 录制控制条 -> 主：录制期间叠加的标注（虚拟屏 DIP，主进程按时刻记进时间轴） */
  recordShapes: 'record:shapes',
  /** 录制控制条 -> 主：点击涟漪（操作可视化），导出时按时间画在帧上 */
  recordClick: 'record:click',
  /** 录制控制条 -> 主：编码前一次性取走时间轴（标注快照 / 点击涟漪 / 区域） */
  recordTimeline: 'record:timeline',

  /** 主 -> 控制条：滚动截长图的裁剪帧（选区条带 RGBA） */
  scrollFrame: 'scroll:frame',
  /** 控制条 -> 主：复制 / 保存（随带长图 PNG）/ 取消 */
  scrollAction: 'scroll:action',

  /** 主窗口 -> 主：读取 / 写入应用设置 */
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  /** 主窗口 -> 主：选择保存目录（系统对话框） */
  settingsPickDir: 'settings:pickDir',
  /** 主 -> 遮罩：OCR 识别结果 */
  ocrResult: 'overlay:ocrResult',
  /** 截图历史 <-> 主；主窗口「查看全部」也走 open */
  historyBoot: 'history:boot',
  historyThumb: 'history:thumb',
  historyAction: 'history:action',
  historyOpen: 'history:open',

  pinBoot: 'pin:boot',
  pinReady: 'pin:ready',
  pinAction: 'pin:action',

  appState: 'app:state',
  appStartSnip: 'app:startSnip',
} as const;
