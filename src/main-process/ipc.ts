import { BrowserWindow, dialog, ipcMain } from 'electron';
import { CH } from '../shared/channels';
import type {
  AppSettings,
  RecordActionPayload,
  RecordBrushPayload,
  RecordClickPayload,
  RecordExportPayload,
  HistoryActionKind,
  SettingsPatch,
  Shape,
} from '../shared/types';
import { getSettings, setSettings } from './settings';
import * as history from './history';
import { beginSnip, getSnipper, installScrollAction } from './snip';
import {
  onRecordAction,
  onRecordClick,
  onRecordExport,
  onRecordBrush,
  onRecordInk,
  onRecordShapes,
  takeTimeline,
} from './record-capture';

export interface AppContext {
  /** 应用新的全局快捷键；失败（被占用等）返回 false */
  applyHotkey(acc: string): boolean;
  /** 应用 Liquid Glass 染色强度 */
  applyGlassTransparency(transparency: number): void;
}

export function registerIpc(ctx: AppContext): void {
  getSnipper().install(ipcMain);
  installScrollAction(ipcMain);

  // ---------------------------------------------------------- 应用设置
  ipcMain.handle(CH.settingsGet, () => getSettings());
  ipcMain.handle(CH.settingsSet, async (_event, patch: SettingsPatch): Promise<AppSettings> => {
    const prev = await getSettings();
    const next = await setSettings(patch);
    if (patch.hotkey !== undefined && patch.hotkey !== prev.hotkey && !ctx.applyHotkey(next.hotkey)) {
      // 新快捷键注册失败：回滚设置并恢复旧键，渲染进程据此提示
      await setSettings({ hotkey: prev.hotkey });
      ctx.applyHotkey(prev.hotkey);
      throw new Error(`快捷键 ${patch.hotkey} 注册失败，可能已被其他程序占用`);
    }
    if (patch.glassTransparency !== undefined && patch.glassTransparency !== prev.glassTransparency) {
      ctx.applyGlassTransparency(next.glassTransparency);
    }
    if (patch.historyRetention !== undefined && patch.historyRetention !== prev.historyRetention) {
      // 切换保留策略：off/session 清盘、persistent 迁移内存条目（隐私原则见 history.ts）
      await history.applyHistoryRetention();
    }
    return next;
  });

  // -------------------------------------------------------- 截图历史
  ipcMain.handle(CH.historyBoot, () => history.listEntries());
  ipcMain.handle(CH.historyThumb, (_event, id: number) => history.thumb(id));
  ipcMain.handle(CH.historyAction, (_event, payload: { kind: HistoryActionKind; id: number }) =>
    history.runAction(payload),
  );
  ipcMain.handle(CH.historyOpen, () => history.openHistoryWindow());

  // -------------------------------------------------------- 保存目录
  ipcMain.handle(CH.settingsPickDir, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
    };
    const { canceled, filePaths } =
      win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return canceled ? null : (filePaths[0] ?? null);
  });

  // ---------------------------------------------------------- 截图会话
  ipcMain.handle(CH.appStartSnip, () => beginSnip());

  // -------------------------------------------------------- 录屏 / GIF
  // 控制条与标注层共用同一份 record.html：动作按 webContents.id 校验归属，
  // 非控制条的窗口（覆盖层）发来的动作一律拒绝
  ipcMain.handle(CH.recordAction, (event, payload: RecordActionPayload) => onRecordAction(event.sender.id, payload));
  ipcMain.handle(CH.recordInk, (event, payload: { active: boolean }) => onRecordInk(event.sender.id, payload.active));
  // 控制条改笔刷：主进程只转发给标注层，不做解释
  ipcMain.handle(CH.recordBrushSet, (_event, payload: RecordBrushPayload) => onRecordBrush(payload));
  ipcMain.handle(CH.recordShapes, (event, payload: { shapes: Shape[] }) =>
    onRecordShapes(event.sender.id, payload.shapes),
  );
  ipcMain.handle(CH.recordClick, (event, payload: RecordClickPayload) => onRecordClick(event.sender.id, payload));
  ipcMain.handle(CH.recordTimeline, (event) => takeTimeline(event.sender.id));
  ipcMain.handle(CH.recordExport, (_event, payload: RecordExportPayload) => onRecordExport(payload));

  // -------------------------------------------------------- 滚动截长图
}
