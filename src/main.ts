import { app, BrowserWindow, globalShortcut } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { CH } from './shared/channels';
import { registerIpc } from './main-process/ipc';
import { forwardRendererLogs } from './main-process/renderer-log';
import { beginSnip, cancelSnip } from './main-process/snip-session';
import { createTray, destroyTray } from './main-process/tray';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

const isDev = !!MAIN_WINDOW_VITE_DEV_SERVER_URL;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 260,
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

app.whenReady().then(() => {
  // 双开的那个实例：等待退出的过程中不再创建任何窗口 / 托盘
  if (!gotLock) return;

  registerIpc({
    isMainWindow: (win) => win === mainWindow,
    broadcastAppState,
    focusMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.focus();
      }
    },
  });

  createMainWindow();

  createTray({
    onSnip: () => void beginSnip(),
    onShowMain: () => showMainWindow(),
    getMainWindow: () => mainWindow,
  });

  const registered = globalShortcut.register('Ctrl+Shift+A', () => {
    // 截图进行中再次触发 → 干净地重启会话
    cancelSnip('shortcut-restart');
    void beginSnip();
  });
  if (!registered) {
    // 别的程序占了这个组合键，退回按钮 / 托盘
    console.warn('[app] 全局快捷键 Ctrl+Shift+A 注册失败，可能已被其他程序占用');
  }
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
