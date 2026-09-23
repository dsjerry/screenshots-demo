import { app, BrowserWindow, clipboard, ClipboardItem, dialog } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toBlob } from '../shared/bytes';
import { forwardRendererLogs } from './renderer-log';
import type { Rect } from '../shared/types';

/**
 * 钉图窗口：无边框、**透明**、置顶、不可 resize（否则会被 Aero Snap 吸走）。
 *
 * `bounds` = 图像 + **四边阴影留白**（由 snip-session 的 `computePinLayout`
 * 算好，随 `pin:boot` 下发），这里只负责原样落地。
 *
 * 必须 `transparent`：外阴影是画在窗口自己那圈留白里的（CSS `box-shadow`），
 * 窗口不透明的话阴影会被自己的底色盖住。相应地 `hasShadow: false` ——
 * `thickFrame: false` 下 Windows 本来也不给系统阴影，别指望那一层。
 */
export function createPinWindow(bounds: Rect): BrowserWindow {
  const win = new BrowserWindow({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(120, Math.round(bounds.width)),
    height: Math.max(90, Math.round(bounds.height)),
    frame: false,
    show: false,
    resizable: false,
    thickFrame: false,
    hasShadow: false,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      // 与 main 同在 .vite/build 下
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 构造函数传入的宽高会被 Windows 的 WM_GETMINMAXINFO 先钳一次
  // （跨屏窗口尤其明显，会收到「光标所在监视器」的尺寸）。
  // Electron 随后把 min/max 锁到我们请求的值，所以紧跟一次 setBounds 就能落到位。
  const want = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(120, Math.round(bounds.width)),
    height: Math.max(90, Math.round(bounds.height)),
  };
  win.setBounds(want);
  console.log(
    `[pin-window] 请求 ${want.width}x${want.height}@${want.x},${want.y}` +
      ` -> 实际 ${JSON.stringify(win.getBounds())}`,
  );

  // 钉图在普通应用之上，但仍在任务栏之下（floating < screen-saver）
  win.setAlwaysOnTop(true, 'floating');
  forwardRendererLogs(win, 'pin');
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(
      `[pin-window] 渲染进程退出 reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
  win.on('unresponsive', () => console.warn('[pin-window] 窗口无响应'));
  win.on('closed', () => {
    console.log('[pin-window] closed');
  });
  return win;
}

export async function loadPin(win: BrowserWindow): Promise<void> {
  if (PIN_VITE_DEV_SERVER_URL) {
    // dev 的 URL 没有 path，`/` 会被 SPA 规则解析成 index.html，必须带文件名
    await win.loadURL(`${PIN_VITE_DEV_SERVER_URL}/pin.html`);
  } else {
    await win.loadFile(
      path.join(__dirname, `../renderer/${PIN_VITE_NAME}/pin.html`),
    );
  }
}

export async function copyPng(png: Uint8Array): Promise<void> {
  if (png.byteLength === 0) throw new Error('图片数据为空');
  await clipboard.write([
    new ClipboardItem({ 'image/png': toBlob(png, 'image/png') }),
  ]);
}

/** 写入剪贴板文本（放大镜的复制颜色值）。 */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error('文本为空');
  clipboard.writeText(text);
}

export async function savePng(
  win: BrowserWindow | null,
  png: Uint8Array,
  suggestedName: string,
): Promise<string | null> {
  // 只有**可见**的置顶窗口才需要先降级（否则对话框被它盖住）；
  // 顺带也别动隐藏窗口的层级 —— 遮罩是 screen-saver，降完再恢复成
  // floating 的话，下次复用就压不住任务栏了。
  const owner = win && win.isVisible() ? win : null;
  const wasOnTop = !!owner && owner.isAlwaysOnTop();
  if (owner && wasOnTop) owner.setAlwaysOnTop(false);
  try {
    const opts = {
      title: '保存截图',
      defaultPath: path.join(app.getPath('pictures'), suggestedName),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    };
    const { canceled, filePath } = owner
      ? await dialog.showSaveDialog(owner, opts)
      : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    await fs.writeFile(filePath, Buffer.from(png));
    return filePath;
  } finally {
    if (owner && wasOnTop) owner.setAlwaysOnTop(true, 'floating');
  }
}

/** 默认文件名 snip_YYYY-MM-DD_HH-mm-ss-SSS.png（毫秒级，同秒多次保存不互相覆盖） */
export function defaultSnipName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return (
    `snip_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-${ms}.png`
  );
}
