import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { Display, WebContents } from 'electron';
import { forwardRendererLogs } from './renderer-log';
import type { DisplayShot } from '../shared/types';

export const OVERLAY_LEVEL = 'screen-saver' as const;

/**
 * 只在窗口**创建时**接线一次 —— 窗口会被复用，每次截图都挂一遍
 * `before-input-event` / `closed` 会堆出重复监听器。
 */
export interface OverlayHooks {
  onKey(webContents: WebContents, kind: 'escape' | 'enter'): void;
  onClosed(contentsId: number): void;
}

/** displayId -> 已创建的遮罩窗口。复用是它的全部意义：省掉每次重建窗口 + 重新加载页面。 */
const cache = new Map<number, BrowserWindow>();

/** 每块显示器一个遮罩窗口，bounds 严格等于 display.bounds。 */
export function createOverlayWindow(
  shot: DisplayShot,
  hooks: OverlayHooks,
): BrowserWindow {
  const b = shot.bounds;

  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    // thickFrame:false —— 否则无边框窗口会吃到 Aero Snap / 隐形边框，bounds 会偏几像素
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    // 不用 transparent:true（Windows 上不可靠）；画布自己铺截图做背景
    backgroundColor: '#000000',
    fullscreenable: false,
    focusable: true,
    webPreferences: {
      // 与 main 同在 .vite/build 下
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 构造函数的 alwaysOnTop 只接受布尔，层级必须单独设置。
  // status 及以下在任务栏之下，popup-menu 及以上在任务栏之上 —— 遮罩必须盖住任务栏。
  win.setAlwaysOnTop(true, OVERLAY_LEVEL);
  // 构造函数传入的宽高会被 WM_GETMINMAXINFO 钳到**工作区**（任务栏以上）
  // —— 首次创建的遮罩会比显示器矮一条任务栏，真实任务栏从遮罩下面露出，
  // 截图里出现两条任务栏。与 pin-window 同解：创建后紧跟 setBounds 强制落位
  //（缓存窗口复用走的 setBounds 不受钳制，所以只有冷启动看得到）。
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  // 遮罩自身不能被别的截图工具截进去（Win10 build 19044 支持 WDA_EXCLUDEFROMCAPTURE）
  win.setContentProtection(true);
  forwardRendererLogs(win, `overlay:${shot.displayId}`);
  // 渲染进程崩溃 / 无响应时遮罩会「卡死在屏幕上」，没有这行日志就只能瞎猜
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[overlay:${shot.displayId}] 渲染进程退出 reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
  win.on('unresponsive', () => {
    console.warn(`[overlay:${shot.displayId}] 窗口无响应`);
  });

  const contentsId = win.webContents.id;

  // Escape / Enter 在主进程处理：preventDefault 之后渲染进程收不到，
  // 因此不会和渲染进程的 keydown 重复触发；渲染进程 JS 挂了也照样有效。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape') {
      event.preventDefault();
      hooks.onKey(win.webContents, 'escape');
    } else if (input.key === 'Enter' || input.key === 'NumpadEnter') {
      event.preventDefault();
      hooks.onKey(win.webContents, 'enter');
    }
  });

  win.on('closed', () => {
    for (const [id, w] of cache) {
      if (w === win) cache.delete(id);
    }
    hooks.onClosed(contentsId);
  });

  return win;
}

/**
 * 取一块屏的遮罩窗口：有缓存就复用（重设 bounds + reload），
 * 没有才新建。返回值里的 `load` 是「页面加载」这一步，
 * 复用时由 reload 完成，无需再 loadURL/loadFile。
 */
export function acquireOverlay(
  shot: DisplayShot,
  hooks: OverlayHooks,
): { win: BrowserWindow; load: Promise<void> } {
  const b = shot.bounds;
  const cached = cache.get(shot.displayId);
  if (cached && !cached.isDestroyed()) {
    // 显示器位置/分辨率可能变过，落一次 bounds
    cached.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    cached.reload();
    return { win: cached, load: Promise.resolve() };
  }
  const win = createOverlayWindow(shot, hooks);
  cache.set(shot.displayId, win);
  return { win, load: loadOverlay(win) };
}

/** 拔掉显示器 / 窗口已销毁的缓存项。 */
export function pruneOverlayCache(liveDisplayIds: Set<number>): void {
  for (const [id, win] of cache) {
    if (win.isDestroyed()) {
      cache.delete(id);
      continue;
    }
    if (!liveDisplayIds.has(id)) {
      cache.delete(id);
      win.destroy();
    }
  }
}

export async function loadOverlay(win: BrowserWindow): Promise<void> {
  if (OVERLAY_VITE_DEV_SERVER_URL) {
    // dev 的 URL 没有 path，`/` 会被 SPA 规则解析成 index.html（主窗口），必须带文件名
    await win.loadURL(`${OVERLAY_VITE_DEV_SERVER_URL}/overlay.html`);
  } else {
    await win.loadFile(
      path.join(__dirname, `../renderer/${OVERLAY_VITE_NAME}/overlay.html`),
    );
  }
}

/** 光标当前落在哪块显示器上。 */
export function displayAtCursor(displays: Display[]): Display {
  const p = screen.getCursorScreenPoint();
  return (
    displays.find(
      (d) =>
        p.x >= d.bounds.x &&
        p.x < d.bounds.x + d.bounds.width &&
        p.y >= d.bounds.y &&
        p.y < d.bounds.y + d.bounds.height,
    ) ?? displays[0]
  );
}
