import { clipboard, nativeImage, BrowserWindow } from 'electron';
import path from 'node:path';
import { toBlob } from '../shared/bytes';
import { forwardRendererLogs } from './renderer-log';
import type { HistoryActionKind, HistoryEntryInfo } from '../shared/types';

/**
 * 截图历史：内存环形缓冲（最近 20 张），托盘菜单打开历史窗口查看。
 * 不主动记录 —— 复制 / 保存的导出路径上调用 pushHistory 采录。
 */
interface Entry {
  id: number;
  png: Buffer;
  width: number;
  height: number;
  time: number;
}

const MAX_ENTRIES = 20;
const entries: Entry[] = [];
let nextId = 1;

export function pushHistory(png: Uint8Array): void {
  const img = nativeImage.createFromBuffer(Buffer.from(png));
  if (img.isEmpty()) return;
  const { width, height } = img.getSize();
  entries.unshift({
    id: nextId++,
    png: Buffer.from(png),
    width,
    height,
    time: Date.now(),
  });
  if (entries.length > MAX_ENTRIES) entries.pop();
}

export function listEntries(): HistoryEntryInfo[] {
  return entries.map((e) => ({
    id: e.id,
    width: e.width,
    height: e.height,
    time: e.time,
  }));
}

export function thumb(id: number): Promise<string> {
  const e = entries.find((x) => x.id === id);
  if (!e) return Promise.resolve('');
  const img = nativeImage.createFromBuffer(e.png);
  return Promise.resolve(img.resize({ width: Math.min(360, e.width) }).toDataURL());
}

let historyWindow: BrowserWindow | null = null;

/** 打开（或聚焦）截图历史窗口。 */
export function openHistoryWindow(): void {
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.focus();
    return;
  }
  historyWindow = new BrowserWindow({
    width: 780,
    height: 560,
    title: '截图历史',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  forwardRendererLogs(historyWindow, 'history');
  historyWindow.on('closed', () => {
    historyWindow = null;
  });
  void loadHistoryWindow(historyWindow);
}

async function loadHistoryWindow(win: BrowserWindow): Promise<void> {
  if (HISTORY_VITE_DEV_SERVER_URL) {
    await win.loadURL(`${HISTORY_VITE_DEV_SERVER_URL}/history.html`);
  } else {
    await win.loadFile(
      path.join(__dirname, `../renderer/${HISTORY_VITE_NAME}/history.html`),
    );
  }
}

export async function runAction(payload: {
  kind: HistoryActionKind;
  id: number;
}): Promise<void> {
  const e = entries.find((x) => x.id === payload.id);
  if (!e) return;
  switch (payload.kind) {
    case 'copy':
      clipboard.write([
        new ClipboardItem({
          'image/png': toBlob(e.png, 'image/png'),
        }) as unknown as Electron.ClipboardItem,
      ]);
      return;
    case 'save': {
      // 惰性 import：pin-window 也惰性引用本模块（pushHistory），避免环
      const { savePng, defaultSnipName } = await import('./pin-window');
      await savePng(null, new Uint8Array(e.png), defaultSnipName());
      return;
    }
    case 'pin': {
      const { createPinFromImage } = await import('./pin-window');
      await createPinFromImage(new Uint8Array(e.png), false);
      return;
    }
    case 'delete': {
      const i = entries.findIndex((x) => x.id === payload.id);
      if (i >= 0) entries.splice(i, 1);
      return;
    }
  }
}
