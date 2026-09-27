import { BrowserWindow, ipcMain } from 'electron';
import { CH } from '../shared/channels';
import type {
  OverlayActionKind,
  OverlayInput,
  PinAction,
  PinInitPayload,
  Shape,
  ToolId,
} from '../shared/types';
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
  onPinBoot,
  ownsPendingPin,
  setSnipHooks,
} from './snip-session';
import { copyPng, copyText, defaultSnipName, savePng } from './pin-window';

export interface AppContext {
  isMainWindow(win: BrowserWindow): boolean;
  broadcastAppState(snipping: boolean): void;
  focusMainWindow(): void;
}

export function registerIpc(ctx: AppContext): void {
  setSnipHooks({
    isMainWindow: (win) => ctx.isMainWindow(win),
    onSnippingChange: (snipping) => ctx.broadcastAppState(snipping),
    focusMainWindow: () => ctx.focusMainWindow(),
  });
  initSnipping();

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
  ipcMain.handle(CH.pinBoot, (event): PinInitPayload | null =>
    onPinBoot(event.sender),
  );

  ipcMain.handle(CH.pinReady, (event) => {
    if (ownsPendingPin(event.sender)) markPinReady(event.sender);
  });

  ipcMain.handle(CH.pinAction, async (event, payload: PinAction) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: '窗口已关闭' };

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
