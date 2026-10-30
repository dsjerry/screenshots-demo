import { app, BrowserWindow, clipboard, ClipboardItem, dialog, screen } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { captureDisplays } from './capture';
import { forwardRendererLogs } from './renderer-log';
import { getSettings } from './settings';
import { CH } from '../shared/channels';
import { toBlob } from '../shared/bytes';
import type {
  DisplayShot,
  Point,
  RecordActionPayload,
  RecordActionResult,
  RecordBrushPayload,
  RecordClickPayload,
  RecordExportPayload,
  RecordFormat,
  RecordPhase,
  RecordStatusPayload,
  RecordTimelinePayload,
  Rect,
  Shape,
} from '../shared/types';

/**
 * 录屏 / GIF 录制。
 *
 * 与滚动截长图（`scroll-capture.ts`）的分工一致：**主进程只负责节奏与裁剪**，
 * 重活（调色板量化、编码、合成标注）在控制条的渲染进程里做 —— 主进程是
 * 所有窗口的事件循环所在，一帧编码卡住会让整个应用（含遮罩、托盘）一起停顿。
 *
 * 流程：
 * 1. `startRecording()`：遮罩收起、按选区所在屏起**控制条窗口**（置顶，
 *    内容保护，永不出现在自己的录像里）；
 * 2. 固定间隔抓屏 → 按选区裁出 RGBA 帧 → `record:frame` 推给控制条；
 * 3. 控制条把帧攒进编码队列（同一时刻只编一帧，跟不上就丢帧并计数），
 *    同时把录制中的标注（`record:shapes`）与点击涟漪（`record:click`）
 *    一并记下时间轴；
 * 4. 停止 → 控制条编码出成品 → 主进程进剪贴板 / 存盘。
 *
 * 只支持**单屏**选区：控制条要贴着录制区域摆，跨屏时「贴着哪块屏」没有
 * 自然答案，且混合 DPI 下帧尺寸会随光标移动跳变。与长图同一取舍。
 */

/** 目标帧率；抓屏本身受 desktopCapturer 限制，实测 10fps 是稳定档 */
const FPS = 10;
/** 控制条尺寸（DIP）—— 比可视区大 8px，给圆角与投影留呼吸空间（见 record.css） */
const BAR_W = 440;
const BAR_H = 96;
/** 工具条窗口尺寸（DIP）：两行工具条约 500×90，留 8px 内边距与少量余量 */
const TOOLBAR_W = 544;
const TOOLBAR_H = 110;
/** 单次录制的上限，防止忘了停把内存吃光（GIF 体积随帧数线性增长） */
const MAX_DURATION_MS = 5 * 60 * 1000;

export interface RecordSessionOptions {
  /** 选区所在屏的抓屏（第一帧直接用它，省一次抓屏，也不会有「第一帧是旧画面」） */
  shot: DisplayShot;
  /** 录制区域（虚拟屏 DIP） */
  region: Rect;
  format: RecordFormat;
  sourceApp?: string;
  /**
   * 控制条被系统关闭时的收尾（截图会话用来放回被隐藏的自家窗口）。
   * 「停止 → 导出」不走这里：那条路径由会话自己收场。
   */
  onClosed?: () => void;
}

interface RecorderState {
  bar: BrowserWindow;
  /** 控制条的落位（工具条窗口贴着它摆，录制结束据此还原） */
  barRect: Electron.Rectangle;
  displayId: number;
  region: Rect;
  format: RecordFormat;
  phase: RecordPhase;
  timer: NodeJS.Timeout | null;
  /** 正在抓帧（上一帧还没回来就不发新的，避免请求堆叠） */
  busy: boolean;
  frames: number;
  width: number;
  height: number;
  /** 录制起点（performance.now() 基准），暂停时长从 elapsed 里扣掉 */
  startedAt: number;
  pausedAt: number;
  pausedTotal: number;
  /**
   * 标注快照时间轴：标注层每次历史变化回传一份快照，主进程盖上「收到时刻」
   * （相对录制起点毫秒）。导出时每帧取「时刻 ≤ 帧时刻」的最新一份 ——
   * 只留最新一份的话，第 5 秒画的箭头会凭空出现在前 5 秒的画面里。
   */
  snapshots: RecordTimelinePayload['snapshots'];
  /** 点击涟漪（虚拟屏 DIP + 相对起点毫秒） */
  clicks: { point: Point; at: number }[];
  sourceApp?: string;
  /** 首帧已推给控制条（控制条 ready 之后才算真正开始计时） */
  started: boolean;
  /** 标注模式当前开关（标注层页面晚加载时补发用） */
  inking: boolean;
}

let state: RecorderState | null = null;

export function isRecording(): boolean {
  return state !== null;
}

/** 控制条已经加载完、可以收帧（在此之前抓的帧要丢弃，否则会压在 boot 之前） */
let barReady = false;

/**
 * 启动录制。返回 false 表示选区无法落在单块屏内（跨屏选区）或已在录制。
 *
 * `state` 在任何 await 之前同步赋值 —— 页面加载期间用户可能按 Esc 或触发
 * 新的截图，`cancelRecording()` 必须能立刻把这些窗口收掉。
 */
export function startRecording(opts: RecordSessionOptions): boolean {
  if (state) return false;
  const d = screen.getAllDisplays().find((x) => x.id === opts.shot.displayId);
  if (!d) return false;

  const bar = new BrowserWindow({
    width: BAR_W,
    height: BAR_H,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    // 透明窗口别设 backgroundColor：某些版本会垫一层不透明合成面
    transparent: true,
    fullscreenable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // 与遮罩同层级：要盖住任务栏，否则录制区域贴着底部时控制条会被压住
  bar.setAlwaysOnTop(true, 'screen-saver');
  // 控制条绝不能被录进去 —— 内容保护是这里唯一的保证（抓屏时它一直可见）
  bar.setContentProtection(true);
  forwardRendererLogs(bar, 'record');

  const barRect = barBoundsFor(opts.region, d.bounds);
  bar.setBounds(barRect);

  state = {
    bar,
    barRect,
    displayId: opts.shot.displayId,
    region: opts.region,
    format: opts.format,
    phase: 'recording',
    timer: null,
    busy: false,
    frames: 0,
    width: 0,
    height: 0,
    startedAt: performance.now(),
    pausedAt: 0,
    pausedTotal: 0,
    snapshots: [],
    clicks: [],
    sourceApp: opts.sourceApp,
    started: false,
    inking: false,
  };
  barReady = false;

  bar.on('closed', () => {
    if (state?.bar !== bar) return;
    // 控制条被系统关掉（Alt+F4 等）：标注层与工具条还悬在录制区域上，
    // 必须一并收掉，否则会留下一块点不透的透明窗
    console.log('[record] 控制条被关闭，终止录制');
    stopRecordingTimer();
    stopInkPoll();
    destroyInkWindow();
    destroyToolbarWindow();
    state = null;
    barReady = false;
    opts.onClosed?.();
  });

  void loadRecordBar(bar)
    .then(() => {
      if (!state || state.bar !== bar) return;
      barReady = true;
      ensureInkWindow();
      ensureToolbarWindow();
      bar.show();
      bar.focus();
      // 第一帧直接用手上的抓屏（`startRecording` 之前刚抓过），避免开头闪一下旧画面
      void pushFrame(opts.shot);
      state.timer = setInterval(() => void grabFrame(), Math.round(1000 / FPS));
      console.log(
        `[record] 开始录制 display=${opts.shot.displayId} ` +
          `region=${Math.round(opts.region.width)}x${Math.round(opts.region.height)} format=${opts.format}`,
      );
    })
    .catch((err: unknown) => {
      console.error('[record] 控制条加载失败', err);
      cancelRecording();
    });

  return true;
}

/** 停掉定时器（不动 state，调用方决定后续） */
function stopRecordingTimer(): void {
  if (state?.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** 取消录制：销毁窗口、丢弃已采集的帧。幂等。 */
export function cancelRecording(): void {
  const s = state;
  if (!s) return;
  stopRecordingTimer();
  stopInkPoll();
  state = null;
  barReady = false;
  if (!s.bar.isDestroyed()) s.bar.destroy();
  destroyInkWindow();
  destroyToolbarWindow();
  console.log(`[record] 录制已取消 frames=${s.frames}`);
}

/** 当前录制状态（推给控制条，也用于主进程日志） */
function statusPayload(s: RecorderState): RecordStatusPayload {
  return {
    phase: s.phase,
    frames: s.frames,
    elapsed: elapsedMs(s),
    width: s.width,
    height: s.height,
    region: s.region,
    format: s.format,
  };
}

function elapsedMs(s: RecorderState): number {
  const now = s.pausedAt > 0 ? s.pausedAt : performance.now();
  return Math.max(0, Math.round(now - s.startedAt - s.pausedTotal));
}

function pushStatus(s: RecorderState): void {
  if (s.bar.isDestroyed()) return;
  s.bar.webContents.send(CH.recordStatus, statusPayload(s));
}

async function grabFrame(): Promise<void> {
  const s = state;
  if (!s || s.busy || s.phase !== 'recording') return;
  if (elapsedMs(s) > MAX_DURATION_MS) {
    console.warn('[record] 达到时长上限，自动停止');
    stopRecordingTimer();
    s.phase = 'stopped';
    pushStatus(s);
    return;
  }
  s.busy = true;
  try {
    const d = screen.getAllDisplays().find((x) => x.id === s.displayId);
    if (!d) throw new Error('显示器已断开');
    const [shot] = await captureDisplays([d], { silent: true });
    if (state !== s) return;
    await pushFrame(shot);
  } catch (err) {
    console.error('[record] 抓帧失败', err);
  } finally {
    if (state === s) s.busy = false;
  }
}

/** 裁剪 + 推给控制条。所有帧尺寸一致，渲染进程据此分配画布。 */
async function pushFrame(shot: DisplayShot): Promise<void> {
  const s = state;
  if (!s || !barReady || s.bar.isDestroyed()) return;
  const frame = cropShot(shot, s.region);
  if (!s.started) {
    // 首帧到达才算开始计时：控制条加载期间的光阴不该算进录像时长
    s.started = true;
    s.startedAt = performance.now();
  }
  s.frames += 1;
  s.width = frame.width;
  s.height = frame.height;
  // at 用主进程时钟（暂停时冻结）：控制条拿它对齐标注快照，别用渲染进程自己的钟
  s.bar.webContents.send(CH.recordFrame, { ...frame, at: Math.round(elapsedMs(s)) });
  // 每秒最多推 4 次状态，够刷时长又不刷屏
  if (s.frames % Math.max(1, Math.round(FPS / 4)) === 0) pushStatus(s);
}

/**
 * 按选区裁出物理像素帧（行拷贝，源是整屏 RGBA 位图）。
 *
 * 与 `scroll-capture.cropShot` 同样的做法：先四舍五入各条边再相减，
 * 保证相邻帧的边界落在同一整数上（换帧时不抖）。
 */
export function cropShot(shot: DisplayShot, region: Rect): { pixels: Uint8Array; width: number; height: number } {
  const x0 = Math.max(0, Math.round((region.x - shot.bounds.x) * shot.scaleX));
  const y0 = Math.max(0, Math.round((region.y - shot.bounds.y) * shot.scaleY));
  const x1 = Math.min(shot.imageWidth, Math.round((region.x + region.width - shot.bounds.x) * shot.scaleX));
  const y1 = Math.min(shot.imageHeight, Math.round((region.y + region.height - shot.bounds.y) * shot.scaleY));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y0 + row) * shot.imageWidth + x0) * 4;
    out.set(shot.pixels.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { pixels: out, width: w, height: h };
}

/**
 * 控制条位置：优先贴选区下方，放不下翻到上方，再不行贴屏底。
 * 水平方向以选区中心对齐，并夹回屏内 8px 内边距。
 */
function barBoundsFor(region: Rect, display: Rect): Electron.Rectangle {
  const x = Math.min(
    Math.max(display.x + 8, Math.round(region.x + region.width / 2 - BAR_W / 2)),
    display.x + display.width - BAR_W - 8,
  );
  let y = Math.round(region.y + region.height + 12);
  if (y + BAR_H > display.y + display.height) {
    y = Math.round(region.y - BAR_H - 12);
  }
  if (y < display.y) {
    y = display.y + display.height - BAR_H - 8;
  }
  return { x, y, width: BAR_W, height: BAR_H };
}

/**
 * 控制条、标注层与工具条是**同一个 renderer 入口**（record.html）的三个角色：
 * - `#bar`：有按钮、计时与导出面板的那条（唯一可交互的自家窗口）
 * - `#ink`：只铺一张画布，画录制期间的标注，平时点击穿透
 * - `#toolbar`：标注工具条，贴在控制条上方的独立小窗
 *
 * 用 URL hash 而不是三个 HTML：三者共享同一份 CSS / 脚本，拆成三个入口会
 * 让 Forge 多打两份、还要再改四处接线（见 AGENTS.md 的「加一个 renderer 入口」）。
 * dev 下 URL 必须带文件名 —— 光写 `/` 会被 Vite 的 SPA 规则解析成 index.html。
 */
async function loadRecordPage(win: BrowserWindow, role: 'bar' | 'ink' | 'toolbar'): Promise<void> {
  if (RECORD_VITE_DEV_SERVER_URL) {
    await win.loadURL(`${RECORD_VITE_DEV_SERVER_URL}/record.html#${role}`);
  } else {
    await win.loadFile(path.join(__dirname, `../renderer/${RECORD_VITE_NAME}/record.html`), {
      hash: role,
    });
  }
}

const loadRecordBar = (win: BrowserWindow): Promise<void> => loadRecordPage(win, 'bar');

// ------------------------------------------------------------ 控制条动作

/**
 * 控制条的动作入口（`record:action`）。
 *
 * 这里只处理「主进程有话说」的几件事：暂停 / 继续 / 停止 / 取消 / 换格式。
 * 导出（复制 / 保存）需要控制条先把帧编码成成品、再把字节回传，所以走
 * 控制条自己的 `record:export` —— 主进程只负责落盘与剪贴板。
 */
export function onRecordAction(senderId: number, payload: RecordActionPayload): RecordActionResult {
  const s = state;
  if (!s || s.bar.webContents.id !== senderId) return { ok: false, error: '录制会话已结束' };
  switch (payload.kind) {
    case 'pause':
      if (s.phase !== 'recording') return { ok: false, error: '当前不是录制中' };
      s.phase = 'paused';
      s.pausedAt = performance.now();
      pushStatus(s);
      console.log('[record] 已暂停');
      return { ok: true };
    case 'resume':
      if (s.phase !== 'paused') return { ok: false, error: '当前不是暂停中' };
      s.pausedTotal += performance.now() - s.pausedAt;
      s.pausedAt = 0;
      s.phase = 'recording';
      pushStatus(s);
      console.log('[record] 继续录制');
      return { ok: true };
    case 'stop':
      if (s.phase === 'stopped') return { ok: true };
      stopRecordingTimer();
      s.phase = 'stopped';
      pushStatus(s);
      console.log(`[record] 停止录制 frames=${s.frames} elapsed=${elapsedMs(s)}ms`);
      return { ok: true };
    case 'cancel':
      cancelRecording();
      return { ok: true };
    case 'format':
      s.format = payload.format;
      pushStatus(s);
      return { ok: true };
    default:
      return { ok: false, error: '未知动作' };
  }
}

/**
 * 录制中叠加的标注（虚拟屏 DIP）：每次历史变化回传一份快照，主进程盖上
 * 收到时刻记进时间轴，导出时控制条按帧时刻取「当时生效」的那份合成。
 */
export function onRecordShapes(senderId: number, shapes: Shape[]): void {
  const s = state;
  if (!s || s.bar.webContents.id !== senderId) return;
  s.snapshots.push({ shapes, at: elapsedMs(s) });
}

/**
 * 点击涟漪：记进时间轴，导出时按帧时间画上扩散圈。
 *
 * 用主进程的 `elapsedMs` 而不是渲染进程给的 `at` —— 两侧时钟起点不同，
 * 只有主进程知道「相对录制起点」的准确毫秒数。
 */
export function onRecordClick(senderId: number, payload: RecordClickPayload): void {
  const s = state;
  if (!s || s.bar.webContents.id !== senderId) return;
  s.clicks.push({ point: payload.point, at: elapsedMs(s) });
}

/** 导出用的时间轴（控制条编码前一次性取走）。 */
export function takeTimeline(senderId: number): RecordTimelinePayload | null {
  const s = state;
  if (!s || s.bar.webContents.id !== senderId) return null;
  return {
    snapshots: s.snapshots,
    clicks: s.clicks,
    region: s.region,
    fps: FPS,
    sourceApp: s.sourceApp,
  };
}

/** 导出完成后由主进程收场（关控制条、清状态）。 */
export function finishRecording(): void {
  const s = state;
  if (!s) return;
  stopRecordingTimer();
  stopInkPoll();
  state = null;
  barReady = false;
  if (!s.bar.isDestroyed()) s.bar.destroy();
  destroyInkWindow();
  destroyToolbarWindow();
  console.log(`[record] 录制收场 frames=${s.frames}`);
}

// ------------------------------------------------------------ 控制条侧通道

/**
 * 标注层开关（`record:ink`）。
 *
 * 录制区域的覆盖层平时是**点击穿透**的：用户要能点到底下的真实应用，
 * 覆盖层只负责把标注画给你看（不会被录进帧 —— 它是独立窗口且开了内容保护）。
 *
 * 指针来源按平台分两路：
 * - Windows：有 `GetAsyncKeyState`，覆盖层保持穿透，轮询全局光标 + 按键状态
 *   驱动绘制（见下方 startInkPoll）——「边操作边标注」；
 * - macOS / Linux：没有公开的全局按键查询，轮询方案画不了。改为**模态**：
 *   开启标注时覆盖层临时收指针（窗口 `focusable: false`，不会抢走用户应用的
 *   键盘焦点），点「完成」后恢复穿透。
 *
 * 两种模式下都把开关回发给标注层窗口（切指针事件）与工具条窗口（显隐）。
 */
export function onRecordInk(senderId: number, active: boolean): void {
  const s = state;
  if (!s || s.bar.webContents.id !== senderId) return;
  s.inking = active;
  const ink = inkWindow;
  if (process.platform === 'win32') {
    if (active) startInkPoll(s);
    else stopInkPoll();
  } else if (ink && !ink.isDestroyed()) {
    if (active) ink.setIgnoreMouseEvents(false);
    else ink.setIgnoreMouseEvents(true, { forward: true });
  }
  // 回发开关：标注层切画布的指针事件，控制条收敛「标注」按钮高亮，工具条窗口显隐
  const payload = { active };
  if (ink && !ink.isDestroyed()) ink.webContents.send(CH.recordInk, payload);
  if (!s.bar.isDestroyed()) s.bar.webContents.send(CH.recordInk, payload);
  const toolbar = toolbarWindow;
  if (toolbar && !toolbar.isDestroyed()) {
    // showInactive：不抢键盘焦点（focusable:false 的窗口本就不参与焦点）
    if (active) toolbar.showInactive();
    else toolbar.hide();
  }
}

/** 控制条的笔刷 → 转发给标注层（主进程不解释内容） */
export function onRecordBrush(payload: RecordBrushPayload): void {
  const ink = inkWindow;
  if (!ink || ink.isDestroyed()) return;
  ink.webContents.send(CH.recordBrush, payload);
}

// -------------------------------------------------- 标注层的指针来源

/**
 * Windows 路径的指针来源。
 *
 * 标注层是**整窗鼠标穿透**的透明覆盖层：它盖在录制区域上，一旦收指针，
 * 用户就没法操作真实应用 —— 而录制最需要「边操作边标注」。所以标注层
 * 自己拿不到 `pointerdown`，绘制由这里轮询 `screen.getCursorScreenPoint()`
 * 换算成标注层坐标后下发；按下状态用 koffi 读 `GetAsyncKeyState`。
 * 非 Windows 没有公开的全局按键查询，不走轮询 —— 见 `onRecordInk` 的模态方案。
 */
let inkTimer: NodeJS.Timeout | null = null;
let inkDown = false;
/** 上一拍的光标（去重：位置没变就不发 move） */
let inkLast: { x: number; y: number } | null = null;

const INK_POLL_MS = 16;

function startInkPoll(s: RecorderState): void {
  if (inkTimer) return;
  inkDown = false;
  inkLast = null;
  inkTimer = setInterval(() => pollInk(s), INK_POLL_MS);
}

function stopInkPoll(): void {
  if (inkTimer) clearInterval(inkTimer);
  inkTimer = null;
  inkDown = false;
  inkLast = null;
}

function pollInk(s: RecorderState): void {
  const ink = inkWindow;
  if (!ink || ink.isDestroyed() || !state || state !== s) {
    stopInkPoll();
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const local = { x: cursor.x - s.region.x, y: cursor.y - s.region.y };
  const down = isLeftButtonDown();
  const send = (kind: 'down' | 'move' | 'up'): void => {
    ink.webContents.send(CH.recordInkInput, { kind, point: local });
  };
  if (down && !inkDown) {
    inkDown = true;
    send('down');
  } else if (down && inkDown) {
    if (!inkLast || inkLast.x !== local.x || inkLast.y !== local.y) send('move');
  } else if (!down && inkDown) {
    inkDown = false;
    send('up');
  }
  inkLast = local;
}

/** 左键当前是否按下（user32，仅 Windows；其它平台恒 false） */
let keyState: ((vk: number) => number) | null | undefined;
function isLeftButtonDown(): boolean {
  if (process.platform !== 'win32') return false;
  if (keyState === undefined) {
    keyState = null;
    try {
      // 同步加载：按钮状态每 16ms 问一次，异步化反而更慢
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = require('koffi') as typeof import('koffi');
      const user32 = koffi.load('user32.dll');
      const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)');
      keyState = (vk: number) => GetAsyncKeyState(vk);
    } catch (err) {
      console.warn('[record] 读取鼠标按键失败，标注停用', err);
    }
  }
  // VK_LBUTTON = 0x01；最高位为 1 表示当前按下
  return keyState ? (keyState(0x01) & 0x8000) !== 0 : false;
}

/** 覆盖层窗口（标注层）：与录制区域同形，透明、置顶、内容保护 */
let inkWindow: BrowserWindow | null = null;

/**
 * 覆盖层窗口在**控制条页面就绪之后**才创建 —— 它与控制条同属 record.html，
 * 但主进程只建一个，渲染进程把标注画进同一个 canvas。
 */
function destroyInkWindow(): void {
  if (inkWindow && !inkWindow.isDestroyed()) inkWindow.destroy();
  inkWindow = null;
}

export function ensureInkWindow(): BrowserWindow | null {
  const s = state;
  if (!s) return null;
  if (inkWindow && !inkWindow.isDestroyed()) return inkWindow;
  const region = s.region;
  const win = new BrowserWindow({
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.max(64, Math.round(region.width)),
    height: Math.max(64, Math.round(region.height)),
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    transparent: true,
    fullscreenable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  forwardRendererLogs(win, 'record-ink');
  inkWindow = win;
  void loadRecordPage(win, 'ink').catch((err: unknown) => console.error('[record] 标注层加载失败', err));
  return win;
}

// -------------------------------------------------------- 工具条窗口

/**
 * 标注工具条窗口：控制条只有一条的高度，两行工具条塞不下（行 1 就约 500px 宽），
 * 单独开一块透明小窗贴在控制条上方。同样内容保护 —— 绝不能被录进去。
 */
let toolbarWindow: BrowserWindow | null = null;

function destroyToolbarWindow(): void {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) toolbarWindow.destroy();
  toolbarWindow = null;
}

/** 工具条窗口贴控制条上沿居中；上方放不下（控制条贴屏顶）就翻到控制条下方 */
function ensureToolbarWindow(): BrowserWindow | null {
  const s = state;
  if (!s) return null;
  if (toolbarWindow && !toolbarWindow.isDestroyed()) return toolbarWindow;
  const b = screen.getAllDisplays().find((x) => x.id === s.displayId)?.bounds;
  if (!b) return null;
  const x = Math.min(
    Math.max(b.x + 8, Math.round(s.barRect.x + s.barRect.width / 2 - TOOLBAR_W / 2)),
    b.x + b.width - TOOLBAR_W - 8,
  );
  let y = Math.round(s.barRect.y - TOOLBAR_H - 8);
  if (y < b.y + 8) y = Math.round(s.barRect.y + s.barRect.height + 8);
  const win = new BrowserWindow({
    x,
    y,
    width: TOOLBAR_W,
    height: TOOLBAR_H,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    transparent: true,
    fullscreenable: false,
    // 不参与焦点：点工具条不能把用户正在操作的应用的键盘焦点抢走
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  forwardRendererLogs(win, 'record-toolbar');
  toolbarWindow = win;
  void loadRecordPage(win, 'toolbar').catch((err: unknown) => console.error('[record] 工具条加载失败', err));
  return win;
}

/**
 * 导出（`record:export`）—— **与截图同一套约定**：走系统保存对话框、默认落在
 * 设置的 `saveDir`，成功后把落盘路径写进剪贴板。
 *
 * 两种产物的去处不一样：
 * - `copy` + 单文件（gif / mp4）：图片**直接进剪贴板**，与截图「复制」一致；
 * - `copy` + `png-sequence`：多文件没有单张图像可放，退化为「先保存、再复制
 *   路径」，并在返回值里标 `saved` 让控制条如实提示；
 * - `save`：一律弹对话框。帧序列选的是**目录**（在里面新建一个带时间戳的
 *   子目录，不往用户选的位置里混文件）。
 */
export async function onRecordExport(payload: RecordExportPayload): Promise<RecordActionResult> {
  try {
    if (payload.format === 'png-sequence') {
      const files = payload.files ?? [];
      if (files.length === 0) return { ok: false, error: '没有可导出的帧' };
      const dir = await pickTargetDir();
      if (!dir) return { ok: false, canceled: true, error: '已取消' };
      for (let i = 0; i < files.length; i++) {
        // 帧号补到 4 位：文件管理器按名字排序就是播放顺序
        const name = `frame-${String(i).padStart(4, '0')}.png`;
        await fs.writeFile(path.join(dir, name), Buffer.from(files[i]));
      }
      const manifest = { fps: FPS, frames: files.length, width: state?.width ?? 0, height: state?.height ?? 0 };
      await fs.writeFile(path.join(dir, 'frames.json'), JSON.stringify(manifest, null, 2), 'utf8');
      clipboard.writeText(dir);
      console.log(`[record] PNG 序列已写入 ${dir}（${files.length} 帧）`);
      return { ok: true, path: dir };
    }

    const data = payload.data;
    if (!data || data.byteLength === 0) return { ok: false, error: '没有可导出的数据' };
    const mime = payload.format === 'gif' ? 'image/gif' : 'video/mp4';
    const suggested = recordFileName(payload.format);

    if (payload.kind === 'copy') {
      // 单文件成品直接进剪贴板；同时也落一份盘 —— 视频类内容粘到聊天窗口时
      // 不少应用只认文件路径，两种都给上最稳
      await clipboard.write([new ClipboardItem({ [mime]: toBlob(data, mime) })]);
      const target = await writeToSaveDir(data, suggested);
      clipboard.writeText(target);
      return { ok: true, path: target };
    }

    const target = await pickTargetFile(suggested, payload.format);
    if (!target) return { ok: false, canceled: true, error: '已取消' };
    await fs.writeFile(target, Buffer.from(data));
    clipboard.writeText(target);
    console.log(`[record] 录制已保存 ${target}`);
    return { ok: true, path: target };
  } catch (err) {
    console.error('[record] 导出失败', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 控制条是置顶的 screen-saver 窗口：对话框弹出前先降级，结束后恢复 */
async function withBarDemoted<T>(fn: (owner: BrowserWindow | null) => Promise<T>): Promise<T> {
  const owner = state?.bar && !state.bar.isDestroyed() ? state.bar : null;
  const wasOnTop = !!owner?.isAlwaysOnTop();
  if (owner && wasOnTop) owner.setAlwaysOnTop(false);
  try {
    return await fn(owner);
  } finally {
    if (owner && wasOnTop) owner.setAlwaysOnTop(true, 'screen-saver');
  }
}

/** 弹「选择文件夹」，并在里面新建一个带时间戳的子目录（不污染用户选的位置） */
function pickTargetDir(): Promise<string | null> {
  return withBarDemoted(async (owner) => {
    const base = await saveDirOrPictures();
    const opts: Electron.OpenDialogOptions = {
      title: '保存录制帧序列',
      defaultPath: base,
      buttonLabel: '保存到此处',
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } = owner
      ? await dialog.showOpenDialog(owner, opts)
      : await dialog.showOpenDialog(opts);
    if (canceled || filePaths.length === 0) return null;
    const target = path.join(filePaths[0], recordDirName());
    await fs.mkdir(target, { recursive: true });
    return target;
  });
}

/** 弹「另存为」：默认目录就是设置的 saveDir，用户可改 */
function pickTargetFile(suggested: string, format: RecordFormat): Promise<string | null> {
  return withBarDemoted(async (owner) => {
    const base = await saveDirOrPictures();
    const opts: Electron.SaveDialogOptions = {
      title: '保存录制',
      defaultPath: path.join(base, suggested),
      filters:
        format === 'gif' ? [{ name: 'GIF 动图', extensions: ['gif'] }] : [{ name: 'MP4 视频', extensions: ['mp4'] }],
    };
    const { canceled, filePath } = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    return canceled || !filePath ? null : filePath;
  });
}

/** 不弹框直接写进 saveDir（「复制」也需要一个可分享的文件路径） */
async function writeToSaveDir(data: Uint8Array, name: string): Promise<string> {
  const dir = await saveDirOrPictures();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await fs.writeFile(target, Buffer.from(data));
  return target;
}

async function saveDirOrPictures(): Promise<string> {
  const settings = await getSettings();
  return settings.saveDir || app.getPath('pictures');
}

/** 产物文件名：record_YYYY-MM-DD_HH-mm-ss.gif（与截图 snip_ 前缀区分） */
function recordFileName(format: RecordFormat): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = format === 'png-sequence' ? 'png' : format;
  return (
    `record_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.${ext}`
  );
}

/** 帧序列目录名：record_YYYY-MM-DD_HH-mm-ss */
function recordDirName(): string {
  return recordFileName('png-sequence').replace(/\.png$/, '');
}
