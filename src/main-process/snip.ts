import { nativeImage } from 'electron';
import type { WebContents } from 'electron';
import path from 'node:path';
import type { SnipAction, SnipActionContext, SnipExportEvent, Snipper } from 'electron-snip';
import scanTextSvg from 'lucide-static/icons/scan-text.svg?raw';
import galleryVerticalSvg from 'lucide-static/icons/gallery-vertical.svg?raw';
import videoSvg from 'lucide-static/icons/video.svg?raw';
import type { ScrollActionPayload } from '../shared/types';
import { copyPng, savePng, defaultSnipName } from './export';
import { getSettings } from './settings';
import { cancelRecording, isRecording, startRecording } from './record-capture';
import {
  beginScrollCapture,
  cropShot,
  setAutoScrollSpeed,
  startAutoScroll,
  startScrollCapture,
  stopAutoScroll,
  stopScrollCapture,
} from './scroll-capture';

/**
 * 截图模块的应用侧适配：初始化 electron-snip，并把长图 / 录屏 / OCR 注册为它的动作。
 * 包只管截图与标注；这三项依赖应用自己的模块（滚动拼接、录制、系统 OCR、历史），留在这里。
 */

export interface SnipHostHooks {
  isMainWindow(win: Electron.BrowserWindow): boolean;
  broadcastAppState(snipping: boolean): void;
  focusMainWindow(): void;
}

let snipper: Snipper | null = null;
/** 长图开始时的来源应用，导出长图时沿用（会话结束后就拿不到了） */
let scrollSourceApp: string | undefined;

/** 必须在 app ready 之后、注册 IPC 之前调用。 */
export async function initSnip(hooks: SnipHostHooks): Promise<Snipper> {
  const pkg = await import('electron-snip');
  snipper = pkg.createSnipper({
    preloadPath: require.resolve('electron-snip/preload'),
    rendererDir: path.dirname(require.resolve('electron-snip/renderer/overlay.html')),
    actions: hostActions(),
    onExport: exportSnip,
    onCancel: () => {
      // 收场时停掉应用侧的附属进程：录制控制条、长图滚动
      if (isRecording()) cancelRecording();
      stopScrollCapture();
    },
    keepHiddenAfterPin: (win) => hooks.isMainWindow(win),
    onStateChange: (snipping) => hooks.broadcastAppState(snipping),
    focusHost: () => hooks.focusMainWindow(),
  });
  return snipper;
}

export function getSnipper(): Snipper {
  if (!snipper) throw new Error('截图模块尚未初始化');
  return snipper;
}

/** 启动时引导屏幕录制权限（包的同名检查，经动态导入避免 CJS 打包时静态引用 ESM）。 */
export async function ensureScreenAccess(): Promise<boolean> {
  const { ensureScreenCaptureAccess } = await import('electron-snip');
  return ensureScreenCaptureAccess();
}

export function beginSnip(): Promise<void> {
  return getSnipper().start();
}

export function cancelSnip(reason?: string): void {
  getSnipper().cancel(reason);
}

/** 复制 / 保存：包已先收场，这里只负责进剪贴板或落盘（并写历史）。 */
async function exportSnip(e: SnipExportEvent): Promise<boolean | void> {
  if (e.kind === 'copy') {
    await copyPng(e.png, e.sourceApp);
    return;
  }
  const settings = await getSettings();
  const saved = await savePng(null, e.png, defaultSnipName(settings.saveFormat), e.sourceApp);
  return saved !== null;
}

// ---------------------------------------------------------------- 宿主动作

let ocrSeq = 0;

function hostActions(): SnipAction[] {
  return [
    { id: 'ocr', label: '提取文字', icon: scanTextSvg, run: runOcr },
    { id: 'scroll', label: '长图', icon: galleryVerticalSvg, run: runScroll },
    { id: 'record', label: '录制', icon: videoSvg, run: runRecord },
  ];
}

/**
 * OCR：识别已冻结的截图，遮罩不收起。结果经通用面板显示。
 * 不用「忙」标志：识别可能卡住，裸布尔会跨会话残留（应用曾因此「时灵时不灵」）。
 * 改用序号，只认最新一次的结果。
 */
async function runOcr(ctx: SnipActionContext): Promise<void> {
  const seq = ++ocrSeq;
  const pick = ctx.pickSingleDisplay();
  if (!pick) {
    ctx.showResult({ state: 'error', error: '选区无法落在单块屏内' });
    return;
  }
  ctx.showResult({ state: 'loading' });
  try {
    const { recognizeImagePng } = await import('./ocr');
    // cropShot 给出 RGBA；nativeImage.createFromBitmap 要 BGRA，换回来
    const frame = cropShot(pick.shot, pick.region);
    const bgra = Buffer.from(frame.pixels);
    for (let i = 0; i < bgra.length; i += 4) {
      const b = bgra[i];
      bgra[i] = bgra[i + 2];
      bgra[i + 2] = b;
    }
    const png = nativeImage.createFromBitmap(bgra, { width: frame.width, height: frame.height }).toPNG();
    const text = await recognizeImagePng(png);
    if (seq === ocrSeq) ctx.showResult({ state: 'ok', text });
  } catch (err) {
    console.error('[ocr] 识别失败', err);
    if (seq === ocrSeq) ctx.showResult({ state: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** 长图：沿竖向滚动，只能在单块屏内；最小边长不足以滚出重叠区域，直接不启动。 */
const MIN_SCROLL_REGION = 64;

function runScroll(ctx: SnipActionContext): void {
  const pick = ctx.pickSingleDisplay();
  if (!pick || pick.region.width < MIN_SCROLL_REGION || pick.region.height < MIN_SCROLL_REGION) {
    console.warn('[scroll] 选区无法落在单块屏内，长图未启动');
    return;
  }
  scrollSourceApp = ctx.sourceApp;
  ctx.hideOverlays();
  if (!startScrollCapture(pick.shot, pick.region)) {
    console.warn('[scroll] 启动失败（可能已在滚动中）');
  }
}

/** 录制：与长图同款，只录单屏内的选区。 */
function runRecord(ctx: SnipActionContext): void {
  const pick = ctx.pickSingleDisplay();
  if (!pick) {
    console.warn('[record] 选区无法落在单块屏内，录制未启动');
    return;
  }
  if (isRecording()) {
    console.warn('[record] 已在录制中');
    return;
  }
  ctx.hideOverlays();
  const ok = startRecording({
    shot: pick.shot,
    region: pick.region,
    format: 'png-sequence',
    sourceApp: ctx.sourceApp,
    // 控制条被系统关掉（Alt+F4）：收场，恢复被隐藏的窗口
    onClosed: () => getSnipper().cancel('record-closed'),
  });
  if (!ok) {
    console.warn('[record] 启动失败，回到框选');
    void getSnipper().start();
  }
}

// ---------------------------------------------------------------- 长图控制条

/** 长图控制条（scroll.html）的动作：自动 / 手动滚动、到底、编辑、复制 / 保存 / 取消。 */
export async function onScrollAction(_sender: WebContents, payload: ScrollActionPayload): Promise<void> {
  switch (payload.kind) {
    case 'start':
      beginScrollCapture();
      return;
    case 'auto':
      await startAutoScroll();
      return;
    case 'manual':
      stopAutoScroll();
      return;
    case 'speed':
      setAutoScrollSpeed(payload.speed ?? 'normal');
      return;
    case 'bottom':
      stopAutoScroll();
      console.log('[scroll] 已到底部，自动滚动停止');
      return;
    case 'edit': {
      // 长图二次编辑：转入独立贴图并直接进入标注编辑模式
      const png = payload.png;
      if (!png || png.byteLength === 0) {
        getSnipper().cancel('scroll-empty');
        return;
      }
      stopScrollCapture();
      getSnipper().cancel('scroll-edit');
      void getSnipper().pinImage(png, { editMode: true });
      return;
    }
    case 'cancel':
      getSnipper().cancel('scroll-cancel');
      return;
  }
  const png = payload.png;
  if (!png || png.byteLength === 0) {
    getSnipper().cancel('scroll-empty');
    return;
  }
  // 先收场（滚动窗口销毁、此前隐藏的窗口恢复），再进剪贴板 / 存盘对话框
  const sourceApp = scrollSourceApp;
  getSnipper().cancel(payload.kind === 'copy' ? 'scroll-copy' : 'scroll-save');
  try {
    if (payload.kind === 'copy') {
      await copyPng(png, sourceApp);
      console.log(`[scroll] 长图已复制 ${png.byteLength} 字节`);
    } else {
      const settings = await getSettings();
      await savePng(null, png, defaultSnipName(settings.saveFormat), sourceApp);
    }
  } catch (err) {
    console.error('[scroll] 导出失败', err);
  }
}
