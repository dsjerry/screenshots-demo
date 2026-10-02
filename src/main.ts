import { app, BrowserWindow, globalShortcut, nativeTheme } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { CH } from './shared/channels';
import { registerIpc } from './main-process/ipc';
import { forwardRendererLogs } from './main-process/renderer-log';
import { beginSnip, cancelSnip } from './main-process/snip-session';
import { createTray, destroyTray } from './main-process/tray';
import { getSettings } from './main-process/settings';
import { openHistoryWindow } from './main-process/history';
import { setPinsMouseIgnore } from './main-process/pin-window';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

const isDev = !!MAIN_WINDOW_VITE_DEV_SERVER_URL;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 540,
    show: false,
    title: '截图工具',
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  forwardRendererLogs(mainWindow, 'main-window');

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 托盘应用：关掉主窗口只是隐藏，进程继续留在托盘里
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

// 单实例锁：双开会出现两个托盘图标、两份全局快捷键。拿不到锁说明已有
// 实例在跑 —— 那边会收到 second-instance 并弹出主窗口，这边直接退出。
// 注意 dev（npm start）与打包产物共用 userData（app.name 都是
// "screenshots"），dev 开着时打包 exe 会直接退出，属预期。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

function broadcastAppState(snipping: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CH.appState, { snipping });
}

/** 当前生效的全局快捷键（accelerator 字符串） */
let currentHotkey = '';

/** 注册（替换）全局截图快捷键；失败返回 false 且保持原键不变。 */
function applyHotkey(acc: string): boolean {
  if (currentHotkey) globalShortcut.unregister(currentHotkey);
  const ok = globalShortcut.register(acc, () => {
    // 截图进行中再次触发 → 干净地重启会话
    cancelSnip('shortcut-restart');
    void beginSnip();
  });
  if (!ok) {
    console.warn(`[app] 全局快捷键 ${acc} 注册失败，可能已被其他程序占用`);
    if (currentHotkey) globalShortcut.register(currentHotkey, () => {
      cancelSnip('shortcut-restart');
      void beginSnip();
    });
    return false;
  }
  currentHotkey = acc;
  return true;
}

app.whenReady().then(async () => {
  // 双开的那个实例：等待退出的过程中不再创建任何窗口 / 托盘
  if (!gotLock) return;

  // 全应用是固定暗色 UI：原生控件的弹层（select 下拉菜单等）跟系统
  // prefers-color-scheme 走，浅色系统的 Windows 上会渲染成白底 ——
  // 强制声明 dark，弹层才是暗色。
  nativeTheme.themeSource = 'dark';

  registerIpc({
    isMainWindow: (win) => win === mainWindow,
    broadcastAppState,
    focusMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.focus();
      }
    },
    applyHotkey,
  });

  createMainWindow();

  createTray({
    onSnip: () => void beginSnip(),
    onSnipDelay: (ms) => {
      setTimeout(() => void beginSnip(), ms);
    },
    onShowMain: () => showMainWindow(),
    onHistory: () => openHistoryWindow(),
    onRestorePins: () => setPinsMouseIgnore(false),
    getMainWindow: () => mainWindow,
  });

  // 设置里的全局快捷键（注册失败时 applyHotkey 内部回退旧键并告警）
  const settings = await getSettings();
  applyHotkey(settings.hotkey);
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyTray();
});

// 托盘应用必须在零窗口时也活着 —— 不能在这里 app.quit()
app.on('window-all-closed', () => {
  /* 保持运行 */
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  } else {
    showMainWindow();
  }
});
