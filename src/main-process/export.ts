import { app, BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { toBlob } from '../shared/bytes';
import type { SaveFormat } from '../shared/types';
import { getSettings } from './settings';

/** 复制图片到剪贴板，并记入截图历史（按保留策略决定是否真正落盘）。 */
export async function copyPng(png: Uint8Array, sourceApp?: string): Promise<void> {
  if (png.byteLength === 0) throw new Error('图片数据为空');
  await clipboard.write([new ClipboardItem({ 'image/png': toBlob(png, 'image/png') })]);
  const { pushHistory } = await import('./history');
  pushHistory(png, sourceApp);
}

/** 写入剪贴板文本（放大镜的复制颜色值）。 */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error('文本为空');
  clipboard.writeText(text);
}

export async function savePng(
  win: BrowserWindow | null,
  png: Uint8Array,
  suggestedName: string,
  sourceApp?: string,
): Promise<string | null> {
  // 只有**可见**的置顶窗口才需要先降级（否则对话框被它盖住）；
  // 顺带也别动隐藏窗口的层级 —— 遮罩是 screen-saver，降完再恢复成
  // floating 的话，下次复用就压不住任务栏了。
  const owner = win && !win.isDestroyed() && win.isVisible() ? win : null;
  const wasOnTop = !!owner && owner.isAlwaysOnTop();
  if (owner && wasOnTop) owner.setAlwaysOnTop(false);
  try {
    const settings = await getSettings();
    const opts = {
      title: '保存截图',
      defaultPath: path.join(settings.saveDir || app.getPath('pictures'), suggestedName),
      filters: [
        { name: 'PNG 图片', extensions: ['png'] },
        { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
      ],
    };
    const { canceled, filePath } = owner ? await dialog.showSaveDialog(owner, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return null;
    let data: Buffer = Buffer.from(png);
    let target = filePath;
    if (/\.jpe?g$/i.test(target)) {
      // JPG 走原生编码器（PNG 保存原始字节，避免重编码损失）
      data = nativeImage.createFromBuffer(data).toJPEG(92);
    } else if (!/\.png$/i.test(target)) {
      target += '.png';
    }
    await fs.writeFile(target, data);
    // 保存成功后把文件路径放进剪贴板，方便直接粘贴分享
    clipboard.writeText(target);
    const { pushHistory } = await import('./history');
    pushHistory(png, sourceApp);
    return target;
  } finally {
    if (owner && wasOnTop) owner.setAlwaysOnTop(true, 'floating');
  }
}

/** 默认文件名 snip_YYYY-MM-DD_HH-mm-ss-SSS.png（毫秒级，同秒多次保存不互相覆盖） */
export function defaultSnipName(format: SaveFormat = 'png'): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return (
    `snip_${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}-${ms}.${format}`
  );
}
