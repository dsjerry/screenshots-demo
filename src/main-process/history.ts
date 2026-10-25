import { clipboard, nativeImage, BrowserWindow, app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toBlob } from '../shared/bytes';
import { forwardRendererLogs } from './renderer-log';
import { getSettings } from './settings';
import type { HistoryActionKind, HistoryEntryInfo } from '../shared/types';

/**
 * 截图历史，按保留策略（settings.historyRetention）分三种形态：
 * - off：不记录；
 * - session（默认）：内存环形缓冲 20 张，重启即没，零磁盘痕迹；
 * - persistent：落盘 userData/shot-history/（index.json + images/<id>.png），
 *   上限 200 张 / 500MB，超限淘汰最旧，重启还在。
 *
 * 历史是「便利贴」不是「档案库」：切到 off/session 时**删掉已落盘内容**
 * （用户说不留就不留）；切到 persistent 时把内存条目迁去落盘，不丢。
 * 采录点在导出路径（copyPng / savePng），不主动记录。
 */

const SESSION_MAX = 20;
const PERSIST_MAX_ENTRIES = 200;
const PERSIST_MAX_BYTES = 500 * 1024 * 1024;

/** 索引里落盘的条目元数据（不含像素） */
interface StoredMeta {
  id: number;
  width: number;
  height: number;
  time: number;
  app?: string;
  size: number;
}

interface Entry extends StoredMeta {
  /** session 形态：像素驻内存 */
  png?: Buffer;
  /** persistent 形态：像素落盘后的路径 */
  file?: string;
}

let entries: Entry[] = [];
let nextId = 1;
/** persistent 索引是否已加载（懒加载，首次访问历史时读盘） */
let loaded = false;

function storeDir(): string {
  return path.join(app.getPath('userData'), 'shot-history');
}
function imagesDir(): string {
  return path.join(storeDir(), 'images');
}
function imagePath(id: number): string {
  return path.join(imagesDir(), `${id}.png`);
}
function indexPath(): string {
  return path.join(storeDir(), 'index.json');
}

/** persistent 形态首次访问时从索引恢复；缺文件 / 尺寸不符的条目直接丢（自愈） */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(indexPath(), 'utf8')) as {
      next?: number;
      entries?: StoredMeta[];
    };
    nextId = raw.next ?? 1;
    const restored: Entry[] = [];
    for (const m of raw.entries ?? []) {
      const file = imagePath(m.id);
      try {
        const st = await fs.stat(file);
        if (st.size !== m.size) continue;
        restored.push({ ...m, file });
      } catch {
        // 索引有、文件没了：丢
      }
    }
    entries = restored;
  } catch {
    // 首次运行 / 索引损坏：空表
    entries = [];
  }
}

async function writeIndex(): Promise<void> {
  await fs.mkdir(imagesDir(), { recursive: true });
  const meta: StoredMeta[] = entries.map(
    ({ id, width, height, time, app, size }) => ({ id, width, height, time, app, size }),
  );
  await fs.writeFile(indexPath(), JSON.stringify({ next: nextId, entries: meta }), 'utf8');
}

/** 超出张数 / 字节上限时从最旧开始淘汰（连带删文件） */
async function enforceCaps(): Promise<void> {
  let bytes = entries.reduce((s, e) => s + e.size, 0);
  let evicted = false;
  while (entries.length > PERSIST_MAX_ENTRIES || bytes > PERSIST_MAX_BYTES) {
    const old = entries.pop();
    if (!old) break;
    bytes -= old.size;
    if (old.file) await fs.rm(old.file, { force: true }).catch(() => {});
    evicted = true;
  }
  if (evicted) await writeIndex();
}

/** persistent 形态入库：写文件 + 进列表 + 容量淘汰 + 落索引 */
async function persistEntry(e: Entry): Promise<void> {
  if (!e.png) return;
  await fs.mkdir(imagesDir(), { recursive: true });
  const file = imagePath(e.id);
  await fs.writeFile(file, e.png);
  entries.unshift({
    id: e.id,
    width: e.width,
    height: e.height,
    time: e.time,
    app: e.app,
    size: e.size,
    file,
  });
  await writeIndex();
  await enforceCaps();
}

export async function pushHistory(png: Uint8Array, sourceApp?: string): Promise<void> {
  const policy = (await getSettings()).historyRetention;
  if (policy === 'off') return;
  const img = nativeImage.createFromBuffer(Buffer.from(png));
  if (img.isEmpty()) return;
  const { width, height } = img.getSize();
  const buf = Buffer.from(png);
  const base = {
    id: nextId++,
    width,
    height,
    time: Date.now(),
    app: sourceApp,
    size: buf.byteLength,
  };
  if (policy === 'session') {
    entries.unshift({ ...base, png: buf });
    while (entries.length > SESSION_MAX) entries.pop();
    return;
  }
  await ensureLoaded();
  await persistEntry({ ...base, png: buf });
}

/** 保留策略切换（在 settings 落地后调用，从设置读当前策略）。隐私原则：
 *  off / session 不留任何盘上痕迹；persistent 迁移内存条目。 */
export async function applyHistoryRetention(): Promise<void> {
  const policy = (await getSettings()).historyRetention;
  if (policy === 'persistent') {
    if (entries.length > 0 && entries[0].png) {
      // 从 session 迁移：内存条目逐张落盘（保持新旧顺序）
      const mem = entries;
      entries = [];
      for (const e of mem) await persistEntry(e);
    } else {
      await ensureLoaded();
    }
    return;
  }
  // off / session：清内存 + 删整个存储目录
  entries = [];
  nextId = 1;
  loaded = false;
  await fs.rm(storeDir(), { recursive: true, force: true }).catch(() => {});
}

export function listEntries(): HistoryEntryInfo[] {
  return entries.map((e) => ({
    id: e.id,
    width: e.width,
    height: e.height,
    time: e.time,
    app: e.app,
  }));
}

/** 条目像素：session 直取内存，persistent 按需读盘 */
async function getPng(e: Entry): Promise<Buffer> {
  if (e.png) return e.png;
  if (e.file) {
    try {
      return await fs.readFile(e.file);
    } catch {
      return Buffer.alloc(0);
    }
  }
  return Buffer.alloc(0);
}

export async function thumb(id: number): Promise<string> {
  const e = entries.find((x) => x.id === id);
  if (!e) return Promise.resolve('');
  const png = await getPng(e);
  if (png.byteLength === 0) return '';
  const img = nativeImage.createFromBuffer(png);
  return img.resize({ width: Math.min(360, e.width) }).toDataURL();
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
  const png = await getPng(e);
  switch (payload.kind) {
    case 'copy':
      if (png.byteLength === 0) return;
      clipboard.write([
        new ClipboardItem({
          'image/png': toBlob(png, 'image/png'),
        }) as unknown as Electron.ClipboardItem,
      ]);
      return;
    case 'save': {
      if (png.byteLength === 0) return;
      // 惰性 import：pin-window 也惰性引用本模块（pushHistory），避免环
      const { savePng, defaultSnipName } = await import('./pin-window');
      await savePng(null, new Uint8Array(png), defaultSnipName());
      return;
    }
    case 'pin': {
      if (png.byteLength === 0) return;
      const { createPinFromImage } = await import('./pin-window');
      await createPinFromImage(new Uint8Array(png), false);
      return;
    }
    case 'delete': {
      const i = entries.findIndex((x) => x.id === payload.id);
      if (i < 0) return;
      const [gone] = entries.splice(i, 1);
      if (gone?.file) {
        // persistent 形态：连带删文件并落索引
        await fs.rm(gone.file, { force: true }).catch(() => {});
        await writeIndex().catch(() => {});
      }
      return;
    }
  }
}
