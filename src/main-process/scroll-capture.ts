import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { captureDisplays } from './capture';
import { forwardRendererLogs } from './renderer-log';
import { pointInRect } from '../shared/selection';
import { CH } from '../shared/channels';
import type {
  DisplayShot,
  Rect,
  ScrollFramePayload,
  ScrollSpeed,
} from '../shared/types';

/**
 * 滚动截长图（参考 QQ / PixPin 的手动滚动模式）。
 *
 * 进入后**收起全屏遮罩** —— 用户要看到并滚动真实窗口，遮罩盖着就什么都
 * 动不了。取而代之的是两个专用窗口：
 * - 轮廓窗：透明 + 全局点击穿透（`setIgnoreMouseEvents`），框外压暗、
 *   边框画在区域**外侧**（CSS outline）—— 边框像素落在裁剪区之外，
 *   无论 contentProtection 是否对本应用的抓屏生效都不会污染帧内容；
 * - 控制条：状态（已捕获尺寸）+ 复制 / 保存 / 取消，拼接逻辑在它的
 *   渲染进程里（行签名重叠匹配，见 `src/scroll/scroll.ts`）。
 *
 * 主进程只负责节奏：每帧抓屏 → 按选区裁出 RGBA 条带 → 推给控制条。
 * 只支持**单屏选区**：长图沿竖向滚动，跨屏选区没有意义。
 */

const FRAME_INTERVAL_MS = 250;
/** 窗口比 .bar 的可视区大 8px，给圆角和投影留呼吸空间（见 scroll.css） */
const BAR_WIDTH = 560;
const BAR_HEIGHT = 88;

interface ScrollState {
  bar: BrowserWindow;
  outline: BrowserWindow;
  timer: NodeJS.Timeout;
  displayId: number;
  region: Rect;
  /** 控制条位置（虚拟屏 DIP）—— 自动滚动注入的豁免区 */
  barBounds: Rect;
  busy: boolean;
}

let state: ScrollState | null = null;

export function isScrolling(): boolean {
  return state !== null;
}

/**
 * 启动滚动捕获。`shot` 必须是包含选区那块屏的截图，`region` 为该屏内
 * 的选区（虚拟屏 DIP）。返回 false 表示已在滚动中。
 *
 * `state` 在任何 await 之前同步赋值 —— 页面加载期间用户可能 Ctrl+Shift+A
 * 重启会话，cancelSnip → stopScrollCapture 必须能立刻杀掉这些窗口。
 */
export function startScrollCapture(shot: DisplayShot, region: Rect): boolean {
  if (state) return false;
  const d = screen
    .getAllDisplays()
    .find((x) => x.id === shot.displayId);
  if (!d) return false;

  // ---- 轮廓窗：透明 + 点击穿透，纯视觉，无脚本（data URL 内联样式）
  const outline = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: false,
    focusable: false,
    webPreferences: {},
  });
  outline.setAlwaysOnTop(true, 'screen-saver');
  outline.setContentProtection(true);
  outline.setIgnoreMouseEvents(true);

  // ---- 控制条：状态 + 动作按钮，拼接在它的渲染进程里
  // transparent 窗口不要设 backgroundColor —— 某些版本会因此垫一层
  // 不透明的合成面，页面的透明区域就变成「额外的背景色」
  const bar = new BrowserWindow({
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    frame: false,
    show: false,
    resizable: false,
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    transparent: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setContentProtection(true);
  forwardRendererLogs(bar, 'scroll');
  const barRect = barBounds(region, d.bounds);
  bar.setBounds(barRect);

  const timer = setInterval(() => void grabFrame(), FRAME_INTERVAL_MS);
  state = {
    bar,
    outline,
    timer,
    displayId: shot.displayId,
    region,
    barBounds: barRect,
    busy: false,
  };

  // 页面加载完成再显示；加载期间抓的帧会被未就绪的页面丢弃，无副作用
  void outline
    .loadURL(outlineDataUrl(region, d.bounds))
    .then(() => {
      if (!outline.isDestroyed()) outline.showInactive();
    })
    .catch((err: unknown) => console.error('[scroll] 轮廓窗加载失败', err));
  void loadScrollBar(bar)
    .then(() => {
      if (!bar.isDestroyed()) {
        bar.show();
        bar.focus();
      }
    })
    .catch((err: unknown) => console.error('[scroll] 控制条加载失败', err));

  console.log(
    `[scroll] 启动滚动截图 display=${shot.displayId} region=${Math.round(region.width)}x${Math.round(region.height)}`,
  );
  return true;
}

/** 收起滚动捕获（窗口销毁 + 帧循环停止）。幂等。 */
export function stopScrollCapture(): void {
  stopAutoScroll();
  const s = state;
  if (!s) return;
  state = null;
  clearInterval(s.timer);
  for (const win of [s.bar, s.outline]) {
    if (!win.isDestroyed()) win.destroy();
  }
  console.log('[scroll] 滚动截图已收起');
}

// ------------------------------------------------------------ 自动滚动

const AUTO_SCROLL_INTERVAL_MS = 500;
/** 每个速度档对应的每次注入滚轮格数（一格 = WHEEL_DELTA 120） */
const AUTO_NOTCHES: Record<ScrollSpeed, number> = {
  slow: 1,
  normal: 3,
  fast: 6,
};
const WHEEL_DELTA = 120;
const MOUSEEVENTF_WHEEL = 0x0800;

let auto: {
  timer: NodeJS.Timeout;
  /** 当前速度档的注入格数（speed 动作可热切换） */
  notches: number;
  /** 上一拍的光标位置 —— 判断是用户在动鼠标还是程序上次的落点 */
  lastCursor: { x: number; y: number } | null;
} | null = null;
/** 自动滚动速度（未启动时切换也记着，启动即生效） */
let autoSpeed: ScrollSpeed = 'normal';
/** koffi / user32 只准备一次（重复注册同名 struct 会冲突） */
let injector: {
  place(center: { x: number; y: number }): void;
  wheel(notches: number): void;
} | null = null;

/**
 * 自动滚动的滚轮注入器：koffi 直调 user32 —— `SendInput` 注入向下滚轮，
 * 落在**光标之下**的真实窗口上（轮廓窗点击穿透、遮罩已收起，不会截胡）。
 */
async function prepareInjector(): Promise<{
  place(center: { x: number; y: number }): void;
  wheel(notches: number): void;
}> {
  if (injector) return injector;
  const koffi = (await import('koffi')).default;
  const user32 = koffi.load('user32.dll');
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'long',
    dy: 'long',
    // 用带符号 long 传负的 delta（位模式与 ULONG 一致）
    mouseData: 'long',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', mi: MOUSEINPUT });
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32, INPUT *, int)');
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int, int)');
  const size = koffi.sizeof(INPUT);
  injector = {
    place: (center) => {
      SetCursorPos(center.x, center.y);
    },
    wheel: (notches) => {
      SendInput(1, {
        type: 0,
        mi: {
          dx: 0,
          dy: 0,
          mouseData: -WHEEL_DELTA * notches,
          dwFlags: MOUSEEVENTF_WHEEL,
          time: 0,
          dwExtraInfo: 0,
        },
      }, size);
    },
  };
  return injector;
}

/**
 * 启动自动滚动。**只在启动时把光标放到选区中心一次** —— 之后绝不挪动
 * 光标：每拍检查光标位置，落在选区内（且不在控制条上）才注入滚轮。
 * 鼠标归用户管：移出选区 / 悬停控制条 = 自动暂停，移回来 = 自动恢复，
 * 不再出现「光标被拽回去、停不下来」的对抗。
 */
export async function startAutoScroll(): Promise<boolean> {
  if (auto || !state) return false;
  const io = await prepareInjector();
  const region = state.region;
  const bar = state.barBounds;
  // 启动时把光标放到选区中心一次（SetCursorPos 吃物理像素），
  // 之后光标完全归用户管 —— 注入与否只看光标当前在哪
  const center = screen.dipToScreenPoint({
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
  });
  io.place(center);
  const timer = setInterval(() => {
    if (!state || !auto) return;
    const cursor = screen.getCursorScreenPoint();
    // 用户在动鼠标（与上一拍位置差 > 4 DIP）→ 本拍不注入：移向控制条
    // 的路上滚动立即停手，按钮随手就能点；停住不动才继续注入
    const moved =
      auto.lastCursor !== null &&
      Math.hypot(cursor.x - auto.lastCursor.x, cursor.y - auto.lastCursor.y) > 4;
    auto.lastCursor = cursor;
    // 光标在选区内且不在控制条上才注入 —— 悬停控制条时滚轮会打在
    // 控制条自己身上，按钮就没法点了
    if (!moved && pointInRect(region, cursor) && !pointInRect(bar, cursor)) {
      io.wheel(auto.notches);
    }
  }, AUTO_SCROLL_INTERVAL_MS);
  auto = {
    timer,
    notches: AUTO_NOTCHES[autoSpeed],
    lastCursor: null,
  };
  console.log(`[scroll] 自动滚动已启动（${autoSpeed}）`);
  return true;
}

/** 切换自动滚动速度（快/中/慢改变每次注入的滚轮格数）。 */
export function setAutoScrollSpeed(speed: ScrollSpeed): void {
  autoSpeed = speed;
  if (auto) auto.notches = AUTO_NOTCHES[speed];
}

export function stopAutoScroll(): void {
  if (!auto) return;
  clearInterval(auto.timer);
  auto = null;
}

async function grabFrame(): Promise<void> {
  const s = state;
  if (!s || s.busy) return;
  s.busy = true;
  try {
    const d = screen.getAllDisplays().find((x) => x.id === s.displayId);
    if (!d) throw new Error('显示器已断开');
    const [shot] = await captureDisplays([d], { silent: true });
    const frame = cropShot(shot, s.region);
    if (s.bar.isDestroyed()) return;
    s.bar.webContents.send(CH.scrollFrame, frame);
  } catch (err) {
    console.error('[scroll] 抓帧失败', err);
  } finally {
    if (state === s) s.busy = false;
  }
}

/** 按选区裁出物理像素条带（行拷贝，源是整屏 RGBA 位图）。 */
export function cropShot(shot: DisplayShot, region: Rect): ScrollFramePayload {
  const x0 = Math.max(0, Math.round((region.x - shot.bounds.x) * shot.scaleX));
  const y0 = Math.max(0, Math.round((region.y - shot.bounds.y) * shot.scaleY));
  const x1 = Math.min(
    shot.imageWidth,
    Math.round((region.x + region.width - shot.bounds.x) * shot.scaleX),
  );
  const y1 = Math.min(
    shot.imageHeight,
    Math.round((region.y + region.height - shot.bounds.y) * shot.scaleY),
  );
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y0 + row) * shot.imageWidth + x0) * 4;
    out.set(
      shot.pixels.subarray(srcStart, srcStart + w * 4),
      row * w * 4,
    );
  }
  return { pixels: out, width: w, height: h };
}

function barBounds(region: Rect, display: Rect): Electron.Rectangle {
  const x = Math.min(
    Math.max(
      display.x + 8,
      Math.round(region.x + region.width / 2 - BAR_WIDTH / 2),
    ),
    display.x + display.width - BAR_WIDTH - 8,
  );
  // 默认贴选区下方；放不下翻上方，再不行贴屏底
  let y = Math.round(region.y + region.height + 12);
  if (y + BAR_HEIGHT > display.y + display.height) {
    y = Math.round(region.y - BAR_HEIGHT - 12);
  }
  if (y < display.y) {
    y = display.y + display.height - BAR_HEIGHT - 8;
  }
  return { x, y, width: BAR_WIDTH, height: BAR_HEIGHT };
}

/** 轮廓页：区域本体全透明，压暗与边框都画在**区域外**，不污染抓帧。 */
function outlineDataUrl(region: Rect, display: Rect): string {
  const x = Math.round(region.x - display.x);
  const y = Math.round(region.y - display.y);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
    .hole {
      position: fixed;
      left: ${x}px; top: ${y}px;
      width: ${Math.round(region.width)}px; height: ${Math.round(region.height)}px;
      outline: 3px solid #2f6fed;
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    }
  </style></head><body><div class="hole"></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export async function loadScrollBar(win: BrowserWindow): Promise<void> {
  if (SCROLL_VITE_DEV_SERVER_URL) {
    await win.loadURL(`${SCROLL_VITE_DEV_SERVER_URL}/scroll.html`);
  } else {
    await win.loadFile(
      path.join(__dirname, `../renderer/${SCROLL_VITE_NAME}/scroll.html`),
    );
  }
}
