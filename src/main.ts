import { app, BrowserWindow, globalShortcut, nativeTheme, screen } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { CH } from './shared/channels';
import { registerIpc } from './main-process/ipc';
import { forwardRendererLogs } from './main-process/renderer-log';
import { beginSnip, cancelSnip } from './main-process/snip-session';
import { createTray, destroyTray, getTrayBounds } from './main-process/tray';
import { hideHudCatchers, setHudDismissCallback, showHudCatchers } from './main-process/hud-catcher';
import { getSettings } from './main-process/settings';
import { openHistoryWindow } from './main-process/history';
import { setPinsMouseIgnore } from './main-process/pin-window';
import { ensureScreenCaptureAccess } from './main-process/screen-permission';

// macOS：纯菜单栏应用（Shottr 形态）—— 无 Dock 图标、不占 Cmd+Tab。
// 必须在 ready 之前声明 accessory：ready（didFinishLaunching）之后再调
// dock.hide()，激活策略改了但 Dock 图标可能赖着不走。
if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let devtoolsOpened = false;
let mainWindowReady = false;
let pendingMainWindowShow = false;
/** 面板刚因失焦自动收起的时刻：托盘点击会先夺走焦点，用它区分「再点一下 = 收起」 */
let lastBlurHideAt = 0;

const isDev = !!MAIN_WINDOW_VITE_DEV_SERVER_URL;

type NativeLiquidGlass = {
  addView: (handle: Buffer, options?: { cornerRadius?: number; tintColor?: string; opaque?: boolean }) => number;
};

function applyMacLiquidGlass(win: BrowserWindow, strength: number): void {
  try {
    // 这是原生 NSGlassEffectView 扩展，不要与 BrowserWindow vibrancy 同时启用。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const liquidGlass = require('electron-liquid-glass') as NativeLiquidGlass;
    const alpha = Math.round((strength / 100) * 0x70)
      .toString(16)
      .padStart(2, '0');
    const glassId = liquidGlass.addView(win.getNativeWindowHandle(), {
      cornerRadius: 16,
      tintColor: `#ffffff${alpha}`,
    });
    if (glassId >= 0) {
      console.info(`[app] macOS Liquid Glass 已启用（view=${glassId}）`);
      return;
    }
  } catch (error) {
    console.warn('[app] 原生 Liquid Glass 加载失败，回退到系统 HUD 模糊', error);
  }

  // 老系统或原生二进制不可用时保留原有模糊效果，不让面板变成透明空窗。
  win.setVibrancy('hud');
}

function createMainWindow(): void {
  const isMac = process.platform === 'darwin';
  // macOS 的玻璃由原生扩展绘制；Windows 继续用 DWM Acrylic。
  const glass = isMac
    ? {
        transparent: true,
        backgroundColor: '#00000000',
      }
    : process.platform === 'win32'
      ? {
          transparent: true,
          backgroundMaterial: 'acrylic' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#16181d' };

  mainWindow = new BrowserWindow({
    width: 400,
    height: 540,
    show: false,
    title: '截图工具',
    resizable: false,
    // HUD 形态：无框、不进任务栏，贴托盘弹出、失焦自动收起（见 blur 处理）
    frame: false,
    skipTaskbar: true,
    ...glass,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindowReady = false;
  pendingMainWindowShow = false;
  mainWindow.webContents.once('did-finish-load', async () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    try {
      const settings = await getSettings();
      if (isMac) applyMacLiquidGlass(win, settings.glassStrength);
    } catch (error) {
      console.warn('[app] 读取设置失败，使用默认 HUD 模糊', error);
      if (isMac) win.setVibrancy('hud');
    }
    if (mainWindow !== win || win.isDestroyed()) return;
    mainWindowReady = true;
    if (pendingMainWindowShow) {
      pendingMainWindowShow = false;
      presentMainWindow();
    }
  });

  if (isDev) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  forwardRendererLogs(mainWindow, 'main-window');
  // HUD 面板永不进截图（自家与第三方都算）：hide 与抓屏在窗口服务器上是
  // 异步合成的，macOS 27 移除窗口还有淡出动画 —— 只靠隐藏会抓到半透明残影
  mainWindow.setContentProtection(true);

  // 托盘应用：启动保持静默，不自动弹主窗口 —— 托盘左键 / 右键菜单才显示
  // （dev 的 DevTools 也推迟到首次显示时再开，见 showMainWindow）

  // 托盘应用：关掉主窗口只是隐藏，进程继续留在托盘里
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  // HUD 交互：点击面板外（焦点离开）自动收起。dev 下 DevTools 聚焦不算失焦；
  // 托盘点击夺走焦点导致的收起由 toggleMainWindow 的 lastBlurHideAt 抑制
  mainWindow.on('blur', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isDev && mainWindow.webContents.isDevToolsFocused()) return;
    if (!mainWindow.isVisible()) return;
    lastBlurHideAt = Date.now();
    hideMainWindow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 面板贴托盘弹出：水平对准托盘图标并夹进工作区；托盘在顶部就挂其下，否则贴工作区底部。 */
function positionNearTray(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const trayBounds = getTrayBounds();
  if (!trayBounds || trayBounds.width === 0) return;
  const { width, height } = mainWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x + Math.round(trayBounds.width / 2),
    y: trayBounds.y + Math.round(trayBounds.height / 2),
  });
  const wa = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  // mac 菜单栏 / 顶部任务栏的图标整体在 workArea 上方；Windows 任务栏默认在底部
  const trayAtTop = trayBounds.y + trayBounds.height <= wa.y + 2;
  const y = trayAtTop ? wa.y : wa.y + wa.height - height;
  mainWindow.setPosition(x, y, false);
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (!mainWindowReady) {
    pendingMainWindowShow = true;
    return;
  }
  presentMainWindow();
}

function presentMainWindow(): void {
  positionNearTray();
  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    // 必须在 show() **之前**设置：先上屏再改 collection behavior，面板拿不到
    // key window，点击面板外就不会触发 blur 收起（探针 A/B 变体实测）
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  mainWindow?.show();
  mainWindow?.focus();
  // accessory 应用不会被自动激活：托盘点击场景下 show+focus 常拿不到 key，
  // 点面板外就永远不触发 blur 收起 —— 显式抢激活（Spotlight 同款做法）
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }
  showHudCatchers();
  // dev：DevTools 跟随主窗口首次显示再打开，启动阶段保持零窗口
  if (isDev && !devtoolsOpened && mainWindow && !mainWindow.isDestroyed()) {
    devtoolsOpened = true;
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function hideMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 不能调 setVisibleOnWorkspaces(false)：accessory 应用上这次调用会把应用
  // 重新激活，Dock 图标跟着复活 —— 隐藏窗口带着 CanJoinAllSpaces 无副作用
  mainWindow.hide();
  hideHudCatchers();
}

/** 托盘左键：面板可见则收起；刚被本次点击的失焦收起过就保持收起（否则永远关不上）。 */
function toggleMainWindow(): void {
  if (mainWindow?.isVisible()) {
    hideMainWindow();
  } else if (Date.now() - lastBlurHideAt > 250) {
    showMainWindow();
  }
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
    if (currentHotkey)
      globalShortcut.register(currentHotkey, () => {
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

  // 面板打开期间铺透明点击盾（见 hud-catcher.ts），盾上点击 → 收起面板
  setHudDismissCallback(() => hideMainWindow());

  registerIpc({
    isMainWindow: (win) => win === mainWindow,
    broadcastAppState,
    focusMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.focus();
      }
    },
    applyHotkey,
    applyGlassStrength: (strength) => {
      if (process.platform !== 'darwin' || !mainWindow || mainWindow.isDestroyed() || !mainWindowReady) return;
      applyMacLiquidGlass(mainWindow, strength);
    },
  });

  createMainWindow();

  createTray({
    onSnip: () => void beginSnip(),
    onSnipDelay: (ms) => {
      setTimeout(() => void beginSnip(), ms);
    },
    onShowMain: () => showMainWindow(),
    onToggleMain: () => toggleMainWindow(),
    onHistory: () => openHistoryWindow(),
    onRestorePins: () => setPinsMouseIgnore(false),
    getMainWindow: () => mainWindow,
  });

  // 设置里的全局快捷键（注册失败时 applyHotkey 内部回退旧键并告警）
  const settings = await getSettings();
  applyHotkey(settings.hotkey);

  // macOS 没有「屏幕录制」权限时启动即引导授权，别等第一次截图截出壁纸才失败
  void ensureScreenCaptureAccess();
});

app.on('before-quit', () => {
  isQuitting = true;
  // 先于窗口关闭阶段销毁：盾的 close 事件带 preventDefault，会卡住 quit
  hideHudCatchers();
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
