import { nativeImage } from 'electron';
import type { IpcMain } from 'electron';
import path from 'node:path';
import type { SnipAction, SnipActionContext, SnipExportEvent, Snipper } from 'electron-snip';
import { installScroll, startScrollCapture, stopScrollCapture } from 'electron-snip/scroll';
import type { ScrollFinish } from 'electron-snip/scroll';
import { recognizeImagePng } from 'electron-snip/ocr';
import { cropShot } from 'electron-snip/utils';
import scanTextSvg from 'lucide-static/icons/scan-text.svg?raw';
import galleryVerticalSvg from 'lucide-static/icons/gallery-vertical.svg?raw';
import { copyPng, savePng, defaultSnipName } from './export';
import { getSettings } from './settings';
import { cancelRecording, isRecording, startRecording } from './record-capture';

/**
 * 截图模块的应用侧适配：初始化 electron-snip，并把长图 / 录屏 / OCR 注册为它的动作。
 * 长图与 OCR 的实现来自 electron-snip 子路径；录屏仍在应用内（带标注与点击涟漪，包里尚未提供）。
 * 复制 / 保存 / 历史写入 / 贴图这类应用策略留在这里。
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

/** 注册长图控制条的 IPC 通道（由 electron-snip/scroll 处理，导出结果回到这里决定去向）。 */
export function installScrollAction(ipcMain: IpcMain): () => void {
  return installScroll(ipcMain, scrollHooks);
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

// ---------------------------------------------------------------- 长图

function scrollConfig(): { preloadPath: string; rendererDir: string } {
  return {
    preloadPath: require.resolve('electron-snip/preload'),
    rendererDir: path.dirname(require.resolve('electron-snip/renderer/scroll.html')),
  };
}

/**
 * 长图结束的去向。包已先收起长图窗口；这里先结束截图会话（恢复被隐藏的窗口），
 * 再决定进剪贴板、存盘，或送进贴图编辑。
 */
const scrollHooks = {
  async onFinish({ kind, png }: ScrollFinish): Promise<void> {
    if (kind === 'edit') {
      getSnipper().cancel('scroll-edit');
      void getSnipper().pinImage(png, { editMode: true });
      return;
    }
    const sourceApp = scrollSourceApp;
    getSnipper().cancel(kind === 'copy' ? 'scroll-copy' : 'scroll-save');
    try {
      if (kind === 'copy') {
        await copyPng(png, sourceApp);
        console.log(`[scroll] 长图已复制 ${png.byteLength} 字节`);
      } else {
        const settings = await getSettings();
        await savePng(null, png, defaultSnipName(settings.saveFormat), sourceApp);
      }
    } catch (err) {
      console.error('[scroll] 导出失败', err);
    }
  },
  onCancel(reason: string): void {
    getSnipper().cancel(reason);
  },
};

/** 长图最小边长：小于它滚不出重叠区域，直接不启动。 */
const MIN_SCROLL_REGION = 64;

function runScroll(ctx: SnipActionContext): void {
  const pick = ctx.pickSingleDisplay();
  if (!pick || pick.region.width < MIN_SCROLL_REGION || pick.region.height < MIN_SCROLL_REGION) {
    console.warn('[scroll] 选区无法落在单块屏内，长图未启动');
    return;
  }
  scrollSourceApp = ctx.sourceApp;
  ctx.hideOverlays();
  if (!startScrollCapture(pick.shot, pick.region, scrollConfig())) {
    console.warn('[scroll] 启动失败（可能已在滚动中）');
  }
}

// ---------------------------------------------------------------- OCR

let ocrSeq = 0;

/**
 * OCR：识别已冻结的截图，遮罩不收起。结果经通用面板显示。
 * 不用「忙」标志：识别可能卡住，裸布尔会跨会话残留。改用序号，只认最新一次的结果。
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

// ---------------------------------------------------------------- 录屏（应用内实现）

// ---------------------------------------------------------------- 录制（框选后移交）

/**
 * 录制入口：框选后不进工具条，确认选区直接开始录制（托盘「录制」触发）。
 * 录制结束（取消或控制条被关）时释放移交的会话，恢复被隐藏的窗口。
 */
export function startRecordFlow(): void {
  if (isRecording()) {
    console.warn('[record] 已在录制中，忽略新的录制请求');
    return;
  }
  getSnipper().pick({
    onPick({ shot, region, sourceApp }) {
      const ok = startRecording({
        shot,
        region,
        format: 'png-sequence',
        sourceApp,
        onEnd: () => getSnipper().release(),
      });
      if (!ok) {
        console.warn('[record] 启动失败，结束移交');
        getSnipper().release();
      }
    },
  });
}

// ---------------------------------------------------------------- 动作注册

function hostActions(): SnipAction[] {
  return [
    { id: 'ocr', label: '提取文字', icon: scanTextSvg, run: runOcr },
    { id: 'scroll', label: '长图', icon: galleryVerticalSvg, run: runScroll },
  ];
}
