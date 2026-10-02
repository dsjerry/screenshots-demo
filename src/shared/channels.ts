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

  /** 主 -> 控制条：滚动截长图的裁剪帧（选区条带 RGBA） */
  scrollFrame: 'scroll:frame',
  /** 控制条 -> 主：复制 / 保存（随带长图 PNG）/ 取消 */
  scrollAction: 'scroll:action',

  pinBoot: 'pin:boot',
  pinReady: 'pin:ready',
  pinAction: 'pin:action',

  appState: 'app:state',
  appStartSnip: 'app:startSnip',
} as const;
