import { BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { CH } from '../shared/channels';
import type {
  AppSettings,
  HistoryActionKind,
  OverlayActionKind,
  OverlayInput,
  PinAction,
  PinBootPayload,
  ScrollActionPayload,
  SettingsPatch,
  Shape,
  ToolId,
} from '../shared/types';
import { getSettings, setSettings } from './settings';
import * as history from './history';
import {
  beginSnip,
  initSnipping,
  markPinReady,
  onOverlayAction,
  onOverlayBoot,
  onOverlayEditState,
  onOverlayExport,
  onOverlayInput,
  onOverlayReady,
  onOverlayShapes,
  onOverlayDraft,
  onOverlayInFlight,
  onOverlayTool,
  onScrollAction,
  onPinBoot,
  ownsPendingPin,
  setSnipHooks,
} from './snip-session';
import { copyPng, copyText, defaultSnipName, savePng, takePendingImageBoot } from './pin-window';

export interface AppContext {
  isMainWindow(win: BrowserWindow): boolean;
  broadcastAppState(snipping: boolean): void;
  focusMainWindow(): void;
  /** 应用新的全局快捷键；失败（被占用等）返回 false */
  applyHotkey(acc: string): boolean;
}

export function registerIpc(ctx: AppContext): void {
  setSnipHooks({
    isMainWindow: (win) => ctx.isMainWindow(win),
    onSnippingChange: (snipping) => ctx.broadcastAppState(snipping),
    focusMainWindow: () => ctx.focusMainWindow(),
  });
  initSnipping();

  // ---------------------------------------------------------- 应用设置
  ipcMain.handle(CH.settingsGet, () => getSettings());
  ipcMain.handle(
    CH.settingsSet,
    async (_event, patch: SettingsPatch): Promise<AppSettings> => {
      const prev = await getSettings();
      const next = await setSettings(patch);
      if (
        patch.hotkey !== undefined &&
        patch.hotkey !== prev.hotkey &&
        !ctx.applyHotkey(next.hotkey)
      ) {
        // 新快捷键注册失败：回滚设置并恢复旧键，渲染进程据此提示
        await setSettings({ hotkey: prev.hotkey });
        ctx.applyHotkey(prev.hotkey);
        throw new Error(`快捷键 ${patch.hotkey} 注册失败，可能已被其他程序占用`);
      }
      return next;
    },
  );

  // -------------------------------------------------------- 截图历史
  ipcMain.handle(CH.historyBoot, () => history.listEntries());
  ipcMain.handle(CH.historyThumb, (_event, id: number) => history.thumb(id));
  ipcMain.handle(
    CH.historyAction,
    (_event, payload: { kind: HistoryActionKind; id: number }) =>
      history.runAction(payload),
  );

  // -------------------------------------------------------- 保存目录
  ipcMain.handle(CH.settingsPickDir, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } =
      win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
    return canceled ? null : (filePaths[0] ?? null);
  });

  // ---------------------------------------------------------- 截图会话
  ipcMain.handle(CH.appStartSnip, () => beginSnip());

  ipcMain.handle(CH.overlayBoot, (event) => onOverlayBoot(event.sender));
  ipcMain.handle(CH.overlayReady, (event) => onOverlayReady(event.sender));
  ipcMain.handle(CH.overlayInput, (event, payload: OverlayInput) =>
    onOverlayInput(event.sender, payload),
  );

  // ------------------------------------------------- 遮罩阶段的标注
  ipcMain.handle(CH.overlayTool, (event, payload: { tool: ToolId }) =>
    onOverlayTool(event.sender, payload.tool),
  );
  ipcMain.handle(
    CH.overlayAction,
    (event, payload: { kind: OverlayActionKind }) =>
      onOverlayAction(event.sender, payload.kind),
  );
  ipcMain.handle(CH.overlayShapes, (event, payload: { shapes: Shape[] }) =>
    onOverlayShapes(event.sender, payload.shapes),
  );
  ipcMain.handle(CH.overlayDraft, (event, payload: { draft: Shape | null }) =>
    onOverlayDraft(event.sender, payload.draft),
  );
  ipcMain.handle(
    CH.overlayInFlight,
    (event, payload: { index: number | null }) =>
      onOverlayInFlight(event.sender, payload.index),
  );
  ipcMain.handle(
    CH.overlayEditState,
    (event, payload: { textEditing: boolean }) =>
      onOverlayEditState(event.sender, payload.textEditing),
  );
  // 光标所在屏的遮罩请求前台：没有焦点的话，Ctrl+Z / C 等键盘事件会打到上一块屏的窗口
  ipcMain.handle(CH.overlayFocus, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win.isVisible()) win.focus();
  });

  // 放大镜复制颜色值
  ipcMain.handle(
    CH.overlayCopyText,
    async (_event, payload: { text: string }) => {
      try {
        await copyText(payload.text);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // 遮罩就地合成好的 PNG：进剪贴板 / 存盘，随后结束截图
  ipcMain.handle(
    CH.overlayExport,
    (event, payload: { kind: 'copy' | 'save'; png: Uint8Array }) =>
      onOverlayExport(event.sender, payload.kind, payload.png),
  );

  // ---------------------------------------------------------- 钉图窗口
  ipcMain.handle(
    CH.pinBoot,
    (event): PinBootPayload | null =>
      // 会话拼接优先；否则看是否为历史图片 / 长图创建的独立贴图
      onPinBoot(event.sender) ?? takePendingImageBoot(event.sender),
  );

  // -------------------------------------------------------- 滚动截长图
  ipcMain.handle(CH.scrollAction, (event, payload: ScrollActionPayload) =>
    onScrollAction(event.sender, payload),
  );

  ipcMain.handle(CH.pinReady, (event) => {
    if (ownsPendingPin(event.sender)) markPinReady(event.sender);
  });

  ipcMain.handle(CH.pinAction, async (event, payload: PinAction) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口已关闭' };
    // setIgnoreMouseEvents 没有查询接口，自己记账
    const mouseIgnored = mouseIgnoredPins as WeakSet<BrowserWindow>;

    try {
      switch (payload.kind) {
        case 'copy':
          await copyPng(payload.png);
          return { ok: true };
        case 'save':
          await savePng(
            win,
            payload.png,
            payload.suggestedName || defaultSnipName(),
          );
          return { ok: true };
        case 'close':
          win.close();
          return { ok: true };
        case 'zoom': {
          // 缩放时保持光标下的点不动（贴图放大的部位不跑）
          const b = win.getBounds();
          const cursor = screen.getCursorScreenPoint();
          const f = Math.min(4, Math.max(0.25, payload.factor));
          win.setBounds({
            x: Math.round(cursor.x - (cursor.x - b.x) * f),
            y: Math.round(cursor.y - (cursor.y - b.y) * f),
            width: Math.round(b.width * f),
            height: Math.round(b.height * f),
          });
          return { ok: true };
        }
        case 'opacity':
          win.setOpacity(
            Math.min(1, Math.max(0.15, win.getOpacity() + payload.delta)),
          );
          return { ok: true };
        case 'ignore': {
          const next = !mouseIgnored.has(win);
          if (next) mouseIgnored.add(win);
          else mouseIgnored.delete(win);
          win.setIgnoreMouseEvents(next, { forward: next });
          return { ok: true };
        }
        default:
          return { ok: false, error: '未知操作' };
      }
    } catch (err) {
      console.error('[pin] 操作失败', err);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/** 处于鼠标点击穿透状态的贴图窗口（isIgnoreMouseEvents 无查询接口） */
const mouseIgnoredPins = new WeakSet<BrowserWindow>();
