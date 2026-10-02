import { BrowserWindow, screen } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { captureDisplays, resolveOutScale, unionBounds } from './capture';
import {
  acquireOverlay,
  displayAtCursor,
  pruneOverlayCache,
} from './overlay-window';
import type { OverlayHooks } from './overlay-window';
import {
  startAutoScroll,
  startScrollCapture,
  stopAutoScroll,
  stopScrollCapture,
} from './scroll-capture';
import { createPinWindow, loadPin, copyPng, defaultSnipName, savePng } from './pin-window';
import { CH } from '../shared/channels';
import {
  PIN_MIN_HEIGHT,
  PIN_MIN_WIDTH,
  PIN_SHADOW_PAD,
} from '../shared/pin-layout';
import type { PinPadding } from '../shared/pin-layout';
import {
  clampRect,
  hitHandle,
  moveRect,
  pointInRect,
  resizeRect,
} from '../shared/selection';
import type { HandleId } from '../shared/selection';
import type {
  DisplayShot,
  OverlayActionKind,
  OverlayComposePayload,
  OverlayInitPayload,
  OverlayInput,
  OverlayRemoteDraftPayload,
  OverlayRemoteShapesPayload,
  OverlaySelectionPayload,
  PinActionResult,
  PinInitPayload,
  Point,
  Rect,
  ScrollActionPayload,
  Shape,
  SnipPhase,
  ToolId,
} from '../shared/types';

interface PinLayout {
  /** 图像位置（虚拟屏 DIP） */
  bounds: Rect;
  /** 窗口四边给外阴影留的白 —— 渲染进程按它让开画布 */
  padding: PinPadding;
}

/**
 * 当前这次按下在做什么。真相源始终是 `screen.getCursorScreenPoint()`，
 * 这里只存「按下瞬间的基准」，每帧用光标增量重算。
 */
type DragMode =
  /** 重新框选；prev 是误点时要还原的旧选区 */
  | { kind: 'new'; anchor: Point; prev: Rect | null }
  /** 窗口捕获待定：原地点击 = 采纳整窗；拖动过阈值 = 转为普通框选 */
  | { kind: 'window'; anchor: Point }
  /** 整体移动 */
  | { kind: 'move'; origin: Rect; start: Point }
  /** 拖手柄调整 */
  | { kind: 'resize'; origin: Rect; handle: HandleId; start: Point };

interface Session {
  shots: DisplayShot[];
  virtualBounds: Rect;
  overlays: BrowserWindow[];
  /** webContents.id -> 它对应那块屏的截图 */
  shotByContents: Map<number, DisplayShot>;
  /** webContents.id -> overlay window */
  byContents: Map<number, BrowserWindow>;
  ready: Set<number>;
  shown: boolean;
  mode: DragMode | null;
  selection: Rect | null;
  poll: NodeJS.Timeout | null;
  phase: SnipPhase;
  pendingPin: BrowserWindow | null;
  /** 钉图窗口布局（图像 + 阴影留白），确认时算好，boot 时原样回给渲染进程 */
  pinLayout: PinLayout | null;
  /** 当前标注工具（选区下方工具条选的），广播给所有遮罩 */
  activeTool: ToolId;
  /** 正在打字的遮罩：这些窗口的 Enter / Esc 交给渲染进程 */
  editText: Set<number>;
  /** webContents.id -> 本屏 DIP 坐标的标注，确认时统一换算成图像像素 */
  shapesByContents: Map<number, Shape[]>;
  /** webContents.id -> 正被拖动 / 缩放的标注下标（null = 无）；广播给其余屏时滤掉 */
  inFlightByContents: Map<number, number | null>;
  /** 光标下的应用窗口（虚拟屏 DIP）；仅 selecting 且尚无选区时非空 */
  hoverRect: Rect | null;
  hoverPoll: NodeJS.Timeout | null;
  hoverBusy: boolean;
  hoverErrorLogged: boolean;
  /** 会话创建时刻，用于「触发 → 首窗 ready」的总耗时打点 */
  startedAt: number;
}

export interface SnipHooks {
  isMainWindow(win: BrowserWindow): boolean;
  onSnippingChange(snipping: boolean): void;
  focusMainWindow(): void;
}

const MIN_SELECTION = 3;
/**
 * 窗口捕获的「原地点击」判定：按下后位移小于该值才采纳整窗，
 * 超过即转为普通框选 —— 否则悬停在窗口上就画不了自定义选区了。
 */
const WINDOW_CLICK_THRESHOLD = 4;
/** 长图捕获区域的最小边长（DIP）：太小滚不出重叠，无法拼接 */
const MIN_SCROLL_REGION = 64;
/** 只等**第一块屏**（光标所在屏）就绪 —— 其余屏抓完各自补上，不卡首帧 */
const READY_TIMEOUT_MS = 2500;
/** 确认时若其余屏还没抓完，最多再等这么久（否则拼接会缺一块） */
const CAPTURE_WAIT_MS = 2500;
const PIN_TIMEOUT_MS = 8000;

let session: Session | null = null;
let hiddenWindows: BrowserWindow[] = [];
let readyTimer: NodeJS.Timeout | null = null;
/** 其余屏的抓屏 + 补窗；确认选区前要等它落地，否则拼接会缺一块 */
let pendingRest: Promise<void> | null = null;
let hooks: SnipHooks = {
  isMainWindow: () => false,
  onSnippingChange: () => {},
  focusMainWindow: () => {},
};

const pinReadyWaiters = new Map<number, () => void>();

/** 接线只在窗口创建时做一次，见 overlay-window.ts 的说明。 */
const overlayHooks: OverlayHooks = {
  onKey: (webContents, kind) => {
    // 文字输入框开着时，Enter / Esc 归渲染进程（提交 / 取消文字）
    if (session?.editText.has(webContents.id)) return;
    onOverlayInput(webContents, { kind });
  },
  onClosed: (contentsId) => {
    const s = session;
    if (!s) return;
    s.byContents.delete(contentsId);
    s.shotByContents.delete(contentsId);
    s.ready.delete(contentsId);
    s.overlays = s.overlays.filter((w) => !w.isDestroyed());
  },
};

export function setSnipHooks(next: SnipHooks): void {
  hooks = next;
}

/** 必须在 app ready 之后调用（screen 模块的限制）。 */
export function initSnipping(): void {
  const cancelIfSnipping = () => {
    if (session) cancelSnip('display-changed');
  };
  screen.on('display-metrics-changed', cancelIfSnipping);
  screen.on('display-removed', cancelIfSnipping);
}

// ---------------------------------------------------------------- 自家窗口

function hideOwnWindows(): void {
  hiddenWindows = [];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isVisible()) {
      win.hide();
      hiddenWindows.push(win);
    }
  }
}

/**
 * 恢复抓屏前隐藏的窗口。`keepHidden` 返回 true 的窗口继续留在列表里，
 * 下一次调用再恢复（主窗口在「确认」后要保持隐藏，只在「取消」时才回来）。
 */
function restoreWindows(keepHidden: (win: BrowserWindow) => boolean): void {
  const remaining: BrowserWindow[] = [];
  for (const win of hiddenWindows) {
    if (win.isDestroyed()) continue;
    if (keepHidden(win)) {
      remaining.push(win);
      continue;
    }
    win.showInactive();
  }
  hiddenWindows = remaining;
}

// ---------------------------------------------------------------- 选区广播

/** 工具条挂哪块屏：选区中心所在屏；中心落在屏间空隙就退回光标所在屏。 */
function toolbarDisplayFor(s: Session): number | null {
  if (s.phase !== 'adjusting' || !s.selection) return null;
  const sel = s.selection;
  const center = { x: sel.x + sel.width / 2, y: sel.y + sel.height / 2 };
  const displays = screen.getAllDisplays();
  const at = displays.find(
    (d) =>
      center.x >= d.bounds.x &&
      center.x < d.bounds.x + d.bounds.width &&
      center.y >= d.bounds.y &&
      center.y < d.bounds.y + d.bounds.height,
  );
  return (at ?? displayAtCursor(displays)).id;
}

function broadcast(): void {
  if (!session) return;
  const payload: OverlaySelectionPayload = {
    selection: session.selection,
    cursor: screen.getCursorScreenPoint(),
    outScale: session.selection
      ? resolveOutScale(session.shots, session.selection)
      : 1,
    phase: session.phase,
    toolbarDisplayId: toolbarDisplayFor(session),
    activeTool: session.activeTool,
    hoverRect: session.hoverRect,
  };
  for (const win of session.overlays) {
    if (!win.isDestroyed()) {
      win.webContents.send(CH.overlaySelection, payload);
    }
  }
}

function rectFrom(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

// --------------------------------------------------- 悬停窗口捕获

/**
 * get-windows 是 ESM-only 包，主进程（CJS bundle）里用动态 import 惰性加载；
 * 原生部分是 N-API 预编译二进制，与 Electron 的 ABI 无关。
 */
let getWindowsModule: typeof import('get-windows') | null = null;

/** 悬停轮询间隔：原生枚举全窗口，太频白烧 CPU，太慢高亮跟不上手 */
const HOVER_POLL_MS = 64;

function startHoverPoll(s: Session): void {
  if (s.hoverPoll) return;
  s.hoverPoll = setInterval(() => {
    void detectHoverWindow(s);
  }, HOVER_POLL_MS);
}

function stopHoverPoll(s: Session | null): void {
  if (!s) return;
  if (s.hoverPoll) clearInterval(s.hoverPoll);
  s.hoverPoll = null;
  s.hoverBusy = false;
}

/**
 * 检测光标下的应用窗口：按 z 序取第一个包含光标的**第三方**窗口。
 * 必须过滤自家进程 —— 截图时满屏遮罩就是最顶层窗口，不过滤永远命中的是自己。
 * get-windows 返回物理像素，先用 screenToDipPoint 换算再与光标（DIP）比较。
 */
async function detectHoverWindow(s: Session): Promise<void> {
  // 只有「还没框选、也没在拖」的 selecting 阶段做窗口捕获；窗口捕获
  // 待定（原地点击判定中）也要继续 —— 高亮跟着光标走，松手才采纳
  const hoverIdle =
    session === s &&
    s.phase === 'selecting' &&
    !s.selection &&
    (!s.mode || s.mode.kind === 'window');
  if (!hoverIdle) {
    if (s.hoverRect && session === s) {
      s.hoverRect = null;
      broadcast();
    }
    return;
  }
  if (s.hoverBusy) return;
  s.hoverBusy = true;
  try {
    if (!getWindowsModule) getWindowsModule = await import('get-windows');
    const cursor = screen.getCursorScreenPoint();
    let rect: Rect | null = null;
    for (const win of getWindowsModule.openWindowsSync()) {
      const b = win.bounds;
      if (b.width <= 0 || b.height <= 0) continue;
      const p1 = screen.screenToDipPoint({ x: b.x, y: b.y });
      const p2 = screen.screenToDipPoint({ x: b.x + b.width, y: b.y + b.height });
      const dip = { x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y };
      if (pointInRect(dip, cursor)) {
        rect = dip;
        break;
      }
    }
    if (session !== s) return;
    const changed =
      (s.hoverRect === null) !== (rect === null) ||
      (rect !== null && s.hoverRect !== null && !sameRect(rect, s.hoverRect));
    if (changed) {
      s.hoverRect = rect;
      broadcast();
    }
  } catch (err) {
    // 原生模块加载失败等场景：只记一次，功能降级为普通框选
    if (!s.hoverErrorLogged) {
      s.hoverErrorLogged = true;
      console.error('[snip] 窗口检测不可用，已降级为普通框选', err);
    }
  } finally {
    s.hoverBusy = false;
  }
}

function fullDisplayAt(point: Point): Rect {
  const displays = screen.getAllDisplays();
  const d = displays.find(
    (x) =>
      point.x >= x.bounds.x &&
      point.x < x.bounds.x + x.bounds.width &&
      point.y >= x.bounds.y &&
      point.y < x.bounds.y + x.bounds.height,
  );
  return { ...(d ?? displays[0]).bounds };
}

/** 单击（选区过小）退化成「选中光标所在的整块屏」。 */
function hasRealSelection(sel: Rect | null): sel is Rect {
  return !!sel && sel.width >= MIN_SELECTION && sel.height >= MIN_SELECTION;
}

/**
 * 钉图窗口布局 = 图像 + **每侧自适应的阴影留白**。
 *
 * 外阴影画在窗口里（透明窗口 + CSS `box-shadow`），得先给它留地方；
 * 每侧留白 = 那侧屏幕还剩多少空间，最多 `PIN_SHADOW_PAD`，贴边就是 0
 * —— 桌面到头了，本来也画不出阴影。**图像位置永远等于选区**，留白只往
 * 窗外扩（没空间就缩到 0），不会把图挪走。
 */
function computePinLayout(sel: Rect): PinLayout {
  const imageW = Math.max(PIN_MIN_WIDTH, Math.round(sel.width));
  const imageH = Math.max(PIN_MIN_HEIGHT, Math.round(sel.height));
  const x = Math.round(sel.x);
  const y = Math.round(sel.y);
  const midY = y + imageH / 2;
  const midX = x + imageW / 2;

  const dL = fullDisplayAt({ x, y: midY });
  const dR = fullDisplayAt({ x: x + imageW, y: midY });
  const dT = fullDisplayAt({ x: midX, y });
  const dB = fullDisplayAt({ x: midX, y: y + imageH });

  const pad = (room: number): number =>
    Math.max(0, Math.min(PIN_SHADOW_PAD, Math.round(room)));

  const padding: PinPadding = {
    left: pad(x - dL.x),
    right: pad(dR.x + dR.width - (x + imageW)),
    top: pad(y - dT.y),
    bottom: pad(dB.y + dB.height - (y + imageH)),
  };

  return {
    padding,
    bounds: {
      x: x - padding.left,
      y: y - padding.top,
      width: imageW + padding.left + padding.right,
      height: imageH + padding.top + padding.bottom,
    },
  };
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** 丢弃隐藏记录但不恢复窗口（确认截图后主窗口要继续隐藏）。 */
function discardHidden(): void {
  hiddenWindows = [];
}

function stopPoll(s: Session | null): void {
  if (!s) return;
  if (s.poll) clearInterval(s.poll);
  s.poll = null;
  s.mode = null;
}

/**
 * 起 16ms 轮询：三种拖动模式（重新框选 / 整体移动 / 拖手柄）都靠它实时更新。
 *
 * 选区只存在主进程，遮罩是纯投影 —— 不轮询就只能在 `up` 那帧画一次，
 * 看起来就是「按住不刷新、松手才动」。必须在 `mode` 设好之后调（本函数不清 mode）。
 */
function startPoll(s: Session): void {
  if (s.poll) clearInterval(s.poll);
  s.poll = setInterval(() => {
    if (!session || !session.mode) return;
    applyDrag(session);
    broadcast();
  }, 16);
}

/** 每帧按当前模式用光标真相源重算选区；移动 / 调整夹回虚拟桌面（碰撞）。 */
function applyDrag(s: Session): void {
  const mode = s.mode;
  if (!mode) return;
  const cur = screen.getCursorScreenPoint();
  if (mode.kind === 'window') {
    // 窗口捕获待定：位移过阈值转成普通框选（从原按下点起算），否则
    // 维持 selection = null，悬停高亮继续跟着光标走
    if (Math.hypot(cur.x - mode.anchor.x, cur.y - mode.anchor.y) >= WINDOW_CLICK_THRESHOLD) {
      s.mode = { kind: 'new', anchor: mode.anchor, prev: null };
      s.selection = rectFrom(mode.anchor, cur);
    }
    return;
  }
  if (mode.kind === 'new') {
    // 重新框选的两端都是光标，天然落在桌面内，无需夹取
    s.selection = rectFrom(mode.anchor, cur);
  } else if (mode.kind === 'move') {
    s.selection = clampRect(moveRect(mode.origin, mode.start, cur), s.virtualBounds);
  } else {
    s.selection = clampRect(resizeRect(mode.origin, mode.handle, cur), s.virtualBounds);
  }
}

/**
 * 松手收尾：
 * - 窗口捕获待定（原地点击）→ 采纳当前悬停窗口为选区；
 * - 位移不足的「new」按误点处理（有旧选区就还原，否则选中整屏），
 *   然后一律进入 adjusting —— 出 8 向手柄，Enter / 双击才确认。
 */
function finishDrag(s: Session, mode: DragMode): void {
  if (mode.kind === 'window') {
    s.selection = s.hoverRect
      ? { ...s.hoverRect }
      : fullDisplayAt(mode.anchor);
    s.hoverRect = null;
    s.phase = 'adjusting';
    return;
  }
  if (mode.kind === 'new' && !hasRealSelection(s.selection)) {
    s.selection =
      mode.prev && hasRealSelection(mode.prev)
        ? mode.prev
        : fullDisplayAt(mode.anchor);
  }
  s.phase = 'adjusting';
}

// ---------------------------------------------------------------- 截图会话

export async function beginSnip(): Promise<void> {
  if (session) cancelSnip('restart');

  // 抓屏必须发生在任何遮罩窗口创建之前，否则会把自己截进去
  hideOwnWindows();
  hooks.onSnippingChange(true);

  const displays = screen.getAllDisplays();
  pruneOverlayCache(new Set(displays.map((d) => d.id)));

  // 光标所在屏优先落地，其余屏与它**并行**抓 —— 谁先回来谁先出遮罩，
  // 不再「全部屏抓完 + 全部窗口 ready」才显示
  const primary = displayAtCursor(displays);
  const rest = displays.filter((d) => d.id !== primary.id);
  const restPromise: Promise<{ shots: DisplayShot[] }[]> = Promise.all(
    rest.map(async (d) => ({ shots: await captureDisplays([d]) })),
  );

  const t0 = performance.now();
  let primaryShots: DisplayShot[];
  try {
    primaryShots = await captureDisplays([primary]);
  } catch (err) {
    console.error('[snip] 抓屏失败', err);
    restPromise.catch((cause: unknown) => {
      console.error('[snip] 其余屏抓屏失败', cause);
    });
    restoreWindows(() => false);
    hooks.onSnippingChange(false);
    hooks.focusMainWindow();
    return;
  }
  console.log(`[snip] 抓屏（光标屏）${Math.round(performance.now() - t0)}ms`);

  session = {
    shots: [...primaryShots],
    virtualBounds: unionBounds(displays),
    overlays: [],
    byContents: new Map(),
    shotByContents: new Map(),
    ready: new Set(),
    shown: false,
    mode: null,
    selection: null,
    poll: null,
    phase: 'selecting',
    pendingPin: null,
    pinLayout: null,
    activeTool: 'hand',
    editText: new Set(),
    shapesByContents: new Map(),
    inFlightByContents: new Map(),
    hoverRect: null,
    hoverPoll: null,
    hoverBusy: false,
    hoverErrorLogged: false,
    startedAt: performance.now(),
  };

  spawnOverlays(primaryShots);
  startHoverPoll(session);

  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (session && !session.shown) {
      cancelSnip('overlay-timeout');
    }
  }, READY_TIMEOUT_MS);

  const own = session;
  pendingRest = restPromise
    .then((list) => {
      // 会话可能已经取消 / 重启，别把旧抓屏结果塞进新会话
      if (!own || session !== own) return;
      for (const { shots } of list) {
        own.shots.push(...shots);
        spawnOverlays(shots);
      }
      // 迟到的窗口要能立刻看到当前选区
      broadcast();
    })
    .catch((err) => console.error('[snip] 其余屏抓屏失败', err))
    .then(() => {
      pendingRest = null;
      // 自家窗口（此前截到的钉图等）等**所有屏都抓完**再放回来，
      // 否则它们可能出现在还没抓的那块屏的截图里
      if (!session || session === own) {
        restoreWindows((win) => hooks.isMainWindow(win));
      }
    });
}

/** 建（或复用）遮罩窗口并加载页面；窗口加载完成前不参与 ready 判定。 */
function spawnOverlays(shots: DisplayShot[]): void {
  const s = session;
  if (!s) return;
  for (const shot of shots) {
    const { win, load } = acquireOverlay(shot, overlayHooks);
    s.overlays.push(win);
    s.byContents.set(win.webContents.id, win);
    s.shotByContents.set(win.webContents.id, shot);
    void load.catch((err) => {
      console.error('[snip] 遮罩加载失败', err);
    });
  }
}

/** renderer 调 overlay:boot 时返回它自己那块屏的截图。 */
export function onOverlayBoot(sender: WebContents): OverlayInitPayload | null {
  if (!session) return null;
  const shot = session.shotByContents.get(sender.id);
  if (!shot) return null;
  return { shot, virtualBounds: session.virtualBounds };
}

export function onOverlayReady(sender: WebContents): void {
  const s = session;
  if (!s) return;
  const win = s.byContents.get(sender.id);
  if (!win || win.isDestroyed()) return;

  s.ready.add(sender.id);
  // 第一个就绪的窗口（= 光标所在屏）立刻显示并拿走焦点，
  // 其余窗口就绪一个显示一个，不互相等
  const first = !s.shown;
  s.shown = true;
  if (first) {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    console.log(
      `[snip] 触发 → 首窗 ready 总耗时 ${Math.round(performance.now() - s.startedAt)}ms`,
    );
    win.show();
    win.moveTop();
    overlayAtCursor()?.focus();
  } else {
    win.show();
    win.moveTop();
  }
  // 迟到的窗口要能立刻拿到当前选区状态
  broadcast();
  // 再补发其余屏**已提交**的标注 —— 那些广播发生在本窗口订阅之前，
  // 错过了就永远看不到（A 屏先画完、B 屏遮罩才加载完就是这种顺序）
  for (const contentsId of s.shapesByContents.keys()) {
    if (contentsId === sender.id) continue;
    const shot = s.shotByContents.get(contentsId);
    if (!shot) continue;
    win.webContents.send(CH.overlayRemoteShapes, {
      fromDisplayId: shot.displayId,
      shapes: visibleRemoteShapes(s, contentsId).map((shape) =>
        mapShape(shape, shot.bounds.x, shot.bounds.y, 1),
      ),
    });
  }
}

function overlayAtCursor(): BrowserWindow | null {
  if (!session) return null;
  const displays = screen.getAllDisplays();
  const d = displayAtCursor(displays);
  const win = session.overlays.find(
    (w) => !w.isDestroyed() && sameRect(w.getBounds(), d.bounds),
  );
  return win ?? null;
}

export function onOverlayInput(sender: WebContents, payload: OverlayInput): void {
  const s = session;
  if (!s || s.phase === 'confirming') return;
  if (!s.byContents.has(sender.id)) return;

  switch (payload.kind) {
    case 'down': {
      const p = screen.getCursorScreenPoint();
      stopPoll(s);

      // 已有选区时先判断这一下是调手柄、整体移动，还是重新框选
      const prev = s.selection;
      if (s.phase === 'adjusting' && prev && hasRealSelection(prev)) {
        const handle = hitHandle(prev, p);
        if (handle) {
          s.mode = { kind: 'resize', origin: { ...prev }, handle, start: p };
          startPoll(s);
          broadcast();
          break;
        }
        if (pointInRect(prev, p)) {
          s.mode = { kind: 'move', origin: { ...prev }, start: p };
          startPoll(s);
          broadcast();
          break;
        }
      }

      // 尚无选区且光标悬停在应用窗口上：进入「窗口捕获待定」——
      // 原地点击（位移小于阈值）= 采纳整窗；按住拖动 = 转普通框选，
      // 自定义选区不会被窗口捕获挡死
      if (!prev && s.hoverRect && pointInRect(s.hoverRect, p)) {
        s.mode = { kind: 'window', anchor: p };
        startPoll(s);
        break;
      }

      // 重新框选：回到 selecting（手柄收起来），旧选区留着以便误点时还原
      s.phase = 'selecting';
      s.selection = { x: p.x, y: p.y, width: 0, height: 0 };
      s.mode = { kind: 'new', anchor: p, prev: prev ?? null };
      startPoll(s);
      broadcast();
      break;
    }
    case 'up': {
      const mode = s.mode;
      if (!mode) break;
      // 松手这一帧以光标真相源补算一次：16ms 轮询最多落后一个 tick，
      // 否则快速拖动时选区会停在释放点之前
      applyDrag(s);
      stopPoll(s);
      finishDrag(s, mode);
      broadcast();
      break;
    }
    case 'dblclick':
    case 'enter': {
      if (!hasRealSelection(s.selection)) {
        s.selection = fullDisplayAt(screen.getCursorScreenPoint());
      }
      // 主流语义：双击 / Enter = **复制**（不是「确认进钉图」）
      requestExport('copy');
      break;
    }
    case 'nudge': {
      // 方向键微调选区：1px（Shift=10px）粒度由渲染端给，主进程负责
      // 碰撞钳制 —— 拖动 / 待定 / 非 adjusting 阶段一律不生效
      if (s.phase !== 'adjusting' || s.mode) break;
      const sel = s.selection;
      if (!hasRealSelection(sel)) break;
      s.selection = clampRect(
        { ...sel, x: sel.x + payload.dx, y: sel.y + payload.dy },
        s.virtualBounds,
      );
      broadcast();
      break;
    }
    case 'escape':
      cancelSnip('escape');
      break;
    case 'context':
      cancelSnip('context-menu');
      break;
  }
}

// --------------------------------------------------- 遮罩阶段的标注

/** 遮罩换了标注工具：记下来并广播给其余遮罩（跨屏画图要用同一个工具）。 */
export function onOverlayTool(sender: WebContents, tool: ToolId): void {
  const s = session;
  if (!s || s.activeTool === tool) return;
  s.activeTool = tool;
  broadcast();
}

/**
 * 遮罩工具条的动作。**没有「确定」** —— 复制 / 保存在遮罩里就地合成
 * （主进程只把数据推过去，拼图由遮罩渲染进程做），完成后回传 PNG。
 */
export function onOverlayAction(
  sender: WebContents,
  kind: OverlayActionKind,
): void {
  const s = session;
  if (!s || s.phase === 'confirming') return;
  if (!s.byContents.has(sender.id)) return;
  console.log(`[snip] 遮罩工具条动作 kind=${kind} phase=${s.phase}`);
  if (kind === 'cancel') {
    cancelSnip('toolbar');
    return;
  }
  if (kind === 'pin') {
    void confirmSnip();
    return;
  }
  if (kind === 'scroll') {
    startScroll(s);
    return;
  }
  requestExport(kind);
}

/**
 * 进入滚动截长图：长图沿竖向滚动，只能在单块屏内进行 —— 与各屏取
 * **最大交集**作为实际捕获区域。最大化窗口的选区会带出屏幕外的隐形
 * 边框（窗口捕获采用 GetWindowRect 风格的 bounds），夹回屏幕后正好是
 * 可见区域；真正跨屏的选区则保留最大的一块。
 */
function startScroll(s: Session): void {
  const sel = s.selection;
  if (!hasRealSelection(sel)) return;
  let bestShot: DisplayShot | null = null;
  let bestRegion: Rect | null = null;
  let bestArea = 0;
  for (const shot of s.shots) {
    const b = shot.bounds;
    const x0 = Math.max(sel.x, b.x);
    const y0 = Math.max(sel.y, b.y);
    const x1 = Math.min(sel.x + sel.width, b.x + b.width);
    const y1 = Math.min(sel.y + sel.height, b.y + b.height);
    const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    if (area > bestArea) {
      bestArea = area;
      bestShot = shot;
      bestRegion = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
  }
  if (
    !bestShot ||
    !bestRegion ||
    bestRegion.width < MIN_SCROLL_REGION ||
    bestRegion.height < MIN_SCROLL_REGION
  ) {
    console.warn('[scroll] 选区无法落在单块屏内，长图未启动');
    return;
  }
  stopPoll(s);
  stopHoverPoll(s);
  hideOverlays();
  s.phase = 'scrolling';
  if (!startScrollCapture(bestShot, bestRegion)) {
    console.warn('[scroll] 启动失败（可能已在滚动中）');
  }
}

/**
 * 滚动控制条的动作：auto / manual 切换滚动方式，bottom = 自动模式判定
 * 已到底（停止注入），复制 / 保存（随带拼接好的长图 PNG）→ 结束截图后
 * 进剪贴板 / 存盘；取消 → 直接收场。
 */
export async function onScrollAction(
  _sender: WebContents,
  payload: ScrollActionPayload,
): Promise<void> {
  switch (payload.kind) {
    case 'auto':
      await startAutoScroll();
      return;
    case 'manual':
      stopAutoScroll();
      return;
    case 'bottom':
      stopAutoScroll();
      console.log('[scroll] 已到底部，自动滚动停止');
      return;
    case 'cancel':
      cancelSnip('scroll-cancel');
      return;
  }
  const png = payload.png;
  if (!png || png.byteLength === 0) {
    cancelSnip('scroll-empty');
    return;
  }
  // 先收场（滚动窗口销毁、此前隐藏的窗口恢复），再进剪贴板 / 存盘对话框
  cancelSnip(payload.kind === 'copy' ? 'scroll-copy' : 'scroll-save');
  try {
    if (payload.kind === 'copy') {
      await copyPng(png);
      console.log(`[scroll] 长图已复制 ${png.byteLength} 字节`);
    } else {
      await savePng(null, png, defaultSnipName());
    }
  } catch (err) {
    console.error('[scroll] 导出失败', err);
  }
}

/**
 * 把合成数据推给「工具条所在屏」的那块遮罩，由它就地拼图 + 画标注后回传。
 * 只推给一块：拼图一次就够，其余遮罩只负责各自的标注（已含在 `shapes` 里）。
 */
function requestExport(kind: 'copy' | 'save'): void {
  void runExport(kind);
}

async function runExport(kind: 'copy' | 'save'): Promise<void> {
  const s = session;
  if (!s || !hasRealSelection(s.selection)) {
    console.warn(`[snip] 导出被拒绝：没有有效选区 kind=${kind}`);
    return;
  }
  // 拖动过程中（Enter / 双击）触发的导出：先定住选区，别让 16ms 轮询继续改它
  stopPoll(s);
  s.phase = 'adjusting';
  broadcast();

  // 分批抓屏可能还没补完 —— 与 confirmSnip 同一个坑：不等的话，
  // 晚到那块屏在拼接里就是空的
  if (pendingRest) {
    await Promise.race([
      pendingRest,
      new Promise((resolve) => setTimeout(resolve, CAPTURE_WAIT_MS)),
    ]);
    if (session !== s) return; // 等待期间被取消 / 重开过会话
  }

  const hostDisplayId = toolbarDisplayFor(s);
  const data: OverlayComposePayload = {
    shots: s.shots,
    selection: s.selection,
    outScale: resolveOutScale(s.shots, s.selection),
    shapes: toImageShapes(s),
  };
  for (const [contentsId, shot] of s.shotByContents) {
    if (shot.displayId !== hostDisplayId) continue;
    const win = s.byContents.get(contentsId);
    if (!win || win.isDestroyed()) continue;
    console.log(
      `[snip] 请求就地合成 kind=${kind} host=${hostDisplayId} ` +
        `shapes=${data.shapes.length}`,
    );
    win.webContents.send(CH.overlayCompose, { kind, data });
    return;
  }
  console.warn(`[snip] 请求就地合成失败：找不到宿主遮罩 display=${hostDisplayId}`);
}

/**
 * 遮罩合成好的 PNG：**先收遮罩、恢复窗口**，再进剪贴板 / 弹存盘框 ——
 * 否则满屏置顶的遮罩会把保存对话框压在下面。
 */
export async function onOverlayExport(
  sender: WebContents,
  kind: 'copy' | 'save',
  png: Uint8Array,
): Promise<PinActionResult> {
  if (!session) return { ok: false, error: '截图会话已结束' };
  if (png.byteLength === 0) return { ok: false, error: '图片数据为空' };
  const win = BrowserWindow.fromWebContents(sender);
  cancelSnip(kind === 'copy' ? 'copy' : 'save');
  try {
    if (kind === 'copy') {
      await copyPng(png);
      console.log(`[snip] 已复制 ${png.byteLength} 字节`);
      return { ok: true };
    }
    const saved = await savePng(win, png, defaultSnipName());
    return saved
      ? { ok: true }
      : { ok: false, error: '已取消保存' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[snip] 导出失败 kind=${kind}`, err);
    return { ok: false, error };
  }
}

/** 遮罩回传本屏标注（本屏 DIP）。只在历史变化时调，不是每帧。 */
export function onOverlayShapes(sender: WebContents, shapes: Shape[]): void {
  const s = session;
  if (!s) return;
  s.shapesByContents.set(sender.id, shapes);
  broadcastRemoteShapes(s, sender.id);
}

/** 遮罩回传本屏拖画中的草稿（本屏 DIP）。拖画期间按帧合并成一条。 */
export function onOverlayDraft(sender: WebContents, draft: Shape | null): void {
  const s = session;
  if (!s) return;
  broadcastRemoteDraft(s, sender.id, draft);
}

/**
 * 遮罩回传本屏正在拖动 / 缩放的标注下标。主进程**照存全量快照**
 * （导出 / 钉图用它，无需兜底），只在对其余遮罩广播时把这条滤掉，
 * 其余屏改画拖动副本 —— 不滤的话旧位、新位会叠着画两份。
 */
export function onOverlayInFlight(
  sender: WebContents,
  index: number | null,
): void {
  const s = session;
  if (!s) return;
  s.inFlightByContents.set(sender.id, index);
  broadcastRemoteShapes(s, sender.id);
}

/** 某个遮罩当前应被其余屏看到的标注：全量快照滤掉拖动中的那条。 */
function visibleRemoteShapes(s: Session, contentsId: number): Shape[] {
  const shapes = s.shapesByContents.get(contentsId) ?? [];
  const inFlight = s.inFlightByContents.get(contentsId);
  // 0 也是合法下标，判空必须用 != null
  return inFlight != null ? shapes.filter((_, i) => i !== inFlight) : shapes;
}

/**
 * 把某个遮罩的本屏标注换算成虚拟屏 DIP 并广播给**其余遮罩**。
 *
 * 一条标注从 A 屏画到 B 屏时，A 的窗口只会画出落在 A 的半截，
 * B 屏那半截得靠 B 自己的遮罩补出来 —— 每块屏一个窗口、画布互相独立，
 * 不广播的话 B 永远是空的。接收方减去自己那块屏的原点即是局部坐标。
 */
function broadcastRemoteShapes(s: Session, senderId: number): void {
  const shot = s.shotByContents.get(senderId);
  if (!shot) return;
  const payload: OverlayRemoteShapesPayload = {
    fromDisplayId: shot.displayId,
    shapes: visibleRemoteShapes(s, senderId).map((shape) =>
      mapShape(shape, shot.bounds.x, shot.bounds.y, 1),
    ),
  };
  for (const win of s.overlays) {
    if (win.isDestroyed() || win.webContents.id === senderId) continue;
    win.webContents.send(CH.overlayRemoteShapes, payload);
  }
}

/** 同上，但走的是草稿通道；`draft` 为 null 表示来源屏的草稿已结束。 */
function broadcastRemoteDraft(
  s: Session,
  senderId: number,
  draft: Shape | null,
): void {
  const shot = s.shotByContents.get(senderId);
  if (!shot) return;
  const payload: OverlayRemoteDraftPayload = {
    fromDisplayId: shot.displayId,
    draft: draft ? mapShape(draft, shot.bounds.x, shot.bounds.y, 1) : null,
  };
  for (const win of s.overlays) {
    if (win.isDestroyed() || win.webContents.id === senderId) continue;
    win.webContents.send(CH.overlayRemoteDraft, payload);
  }
}

/** 文字输入框开合 —— 打字时 Enter / Esc 交给渲染进程，别被会话吃掉。 */
export function onOverlayEditState(
  sender: WebContents,
  textEditing: boolean,
): void {
  const s = session;
  if (!s) return;
  if (textEditing) s.editText.add(sender.id);
  else s.editText.delete(sender.id);
}

/**
 * 遮罩阶段的标注是**本屏 DIP**，确认时换算成图像像素：
 * `(本屏 DIP + 本屏原点 - 选区原点) × outScale`，线宽 / 字号一起放大。
 * 存 DIP 而不是提前换算，是因为选区在调整阶段还会变，`outScale` 也跟着变。
 */
function toImageShapes(s: Session): Shape[] {
  const sel = s.selection;
  if (!sel) return [];
  const k = resolveOutScale(s.shots, sel);
  const out: Shape[] = [];
  for (const [contentsId, shapes] of s.shapesByContents) {
    const shot = s.shotByContents.get(contentsId);
    if (!shot) continue;
    const dx = shot.bounds.x - sel.x;
    const dy = shot.bounds.y - sel.y;
    for (const shape of shapes) out.push(mapShape(shape, dx, dy, k));
  }
  return out;
}

function mapShape(shape: Shape, dx: number, dy: number, k: number): Shape {
  switch (shape.type) {
    case 'arrow':
      return {
        ...shape,
        x1: (shape.x1 + dx) * k,
        y1: (shape.y1 + dy) * k,
        x2: (shape.x2 + dx) * k,
        y2: (shape.y2 + dy) * k,
        width: shape.width * k,
      };
    case 'pen':
      return {
        ...shape,
        width: shape.width * k,
        points: shape.points.map((p) => ({
          x: (p.x + dx) * k,
          y: (p.y + dy) * k,
        })),
      };
    case 'text':
      return {
        ...shape,
        x: (shape.x + dx) * k,
        y: (shape.y + dy) * k,
        size: shape.size * k,
      };
    case 'mosaic':
      if (shape.mode === 'brush') {
        // 涂抹：点与半径一起换算
        return {
          ...shape,
          radius: shape.radius * k,
          points: shape.points.map((p) => ({
            x: (p.x + dx) * k,
            y: (p.y + dy) * k,
          })),
        };
      }
      return {
        ...shape,
        x: (shape.x + dx) * k,
        y: (shape.y + dy) * k,
        w: shape.w * k,
        h: shape.h * k,
      };
    default:
      // rect / ellipse：w、h 可能是负的，×正数方向不变
      return {
        ...shape,
        x: (shape.x + dx) * k,
        y: (shape.y + dy) * k,
        w: shape.w * k,
        h: shape.h * k,
      };
  }
}

// ---------------------------------------------------------------- 确认 / 取消

async function confirmSnip(): Promise<void> {
  const s = session;
  if (!s || s.phase === 'confirming' || !hasRealSelection(s.selection)) {
    return;
  }

  // 分批抓屏可能还没补完：不等的话，晚到那块屏在拼接里就是空的
  if (pendingRest) {
    await Promise.race([
      pendingRest,
      new Promise((resolve) => setTimeout(resolve, CAPTURE_WAIT_MS)),
    ]);
    // 等待期间用户可能 Esc / 重开过会话
    if (session !== s) return;
  }

  const selection = s.selection;
  const outScale = resolveOutScale(s.shots, selection);
  console.log(
    `[snip] 确认选区 dip=${Math.round(selection.x)},${Math.round(selection.y)} ` +
      `${Math.round(selection.width)}x${Math.round(selection.height)} outScale=${outScale}`,
  );
  s.phase = 'confirming';
  stopPoll(s);

  const layout = computePinLayout(selection);
  s.pinLayout = layout;
  console.log(
    `[snip] 钉图布局 pad=${JSON.stringify(layout.padding)} bounds=${layout.bounds.width}x` +
      `${layout.bounds.height}@${layout.bounds.x},${layout.bounds.y}`,
  );

  const pin = createPinWindow(layout.bounds);
  s.pendingPin = pin;
  const pinId = pin.webContents.id;

  // renderer 自己通过 pin:boot 拉取数据并拼接，就绪后回调 pin:ready
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const state = { ok: false };

  const fail = () => {
    pinReadyWaiters.delete(pinId);
    settle();
  };
  pinReadyWaiters.set(pinId, () => {
    state.ok = true;
    settle();
  });

  void loadPin(pin).catch((err) => {
    console.error('[snip] 钉图窗口加载失败', err);
    fail();
  });
  const timer = setTimeout(fail, PIN_TIMEOUT_MS);

  await finished;
  clearTimeout(timer);
  pinReadyWaiters.delete(pinId);

  if (!state.ok || pin.isDestroyed()) {
    console.warn('[snip] 钉图未就绪，取消本次截图');
    if (!pin.isDestroyed()) pin.close();
    cancelSnip('pin-timeout');
    return;
  }

  console.log('[snip] 钉图就绪，替换遮罩');
  // 遮罩销毁与钉图显示放在同一 tick，避免闪白
  hideOverlays();
  pin.showInactive();
  pin.focus();
  session = null;
  // 确认后主窗口继续保持隐藏，只把抓屏前隐藏的钉图放回来
  discardHidden();
  hooks.onSnippingChange(false);
}

export function ownsPendingPin(sender: WebContents): boolean {
  return session?.pendingPin?.webContents.id === sender.id;
}

/** renderer 拼接完成并调用 pin:ready 时，唤醒 confirmSnip 的等待。 */
export function markPinReady(sender: WebContents): void {
  const resolve = pinReadyWaiters.get(sender.id);
  if (resolve) {
    pinReadyWaiters.delete(sender.id);
    resolve();
  }
}

/** renderer 调 pin:boot 时拿到拼接所需的全部数据。 */
export function onPinBoot(sender: WebContents): PinInitPayload | null {
  const s = session;
  if (!s || s.pendingPin?.webContents.id !== sender.id) {
    console.warn(
      `[snip] pin:boot 被拒绝 sender=${sender.id} phase=${s?.phase ?? 'none'} pending=${s?.pendingPin?.webContents.id ?? 'none'}`,
    );
    return null;
  }
  if (!hasRealSelection(s.selection)) {
    console.warn('[snip] pin:boot 被拒绝：选区无效');
    return null;
  }
  return {
    shots: s.shots,
    selection: s.selection,
    outScale: resolveOutScale(s.shots, s.selection),
    dipWidth: s.selection.width,
    dipHeight: s.selection.height,
    padding: s.pinLayout?.padding ?? { top: 0, right: 0, bottom: 0, left: 0 },
    // 遮罩阶段画的标注（已换算），钉图 seed 进去继续可编辑
    initialShapes: toImageShapes(s),
  };
}

/**
 * 收起遮罩但**不销毁**：窗口按 displayId 缓存，下次截图复用，
 * 省掉重建窗口 + 重新加载页面的开销（对应对方的 singleWindow）。
 */
function hideOverlays(): void {
  if (!session) return;
  stopPoll(session);
  stopHoverPoll(session);
  const overlays = session.overlays;
  session.overlays = [];
  for (const win of overlays) {
    if (win.isDestroyed()) continue;
    // 让渲染进程丢掉全屏位图 —— 窗口要留着复用，位图不该一直占着显存
    win.webContents.send(CH.overlayTeardown, { reason: 'confirm' });
    win.hide();
  }
}

export function cancelSnip(reason = 'manual'): void {
  const s = session;
  if (s) console.log(`[snip] 取消截图 (${reason}) phase=${s.phase}`);
  session = null;
  if (readyTimer) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
  if (s) {
    stopPoll(s);
    stopHoverPoll(s);
    stopScrollCapture();
    for (const win of s.overlays) {
      if (win.isDestroyed()) continue;
      // teardown 让渲染进程丢掉全屏位图（窗口留着复用，不该一直占着显存）
      win.webContents.send(CH.overlayTeardown, { reason: 'cancel' });
      win.hide();
    }
    if (s.pendingPin && !s.pendingPin.isDestroyed()) s.pendingPin.close();
  }
  for (const resolve of pinReadyWaiters.values()) resolve();
  pinReadyWaiters.clear();

  const hadSession = !!s;
  restoreWindows(() => false);
  if (hadSession) {
    hooks.onSnippingChange(false);
    hooks.focusMainWindow();
  }
}
