import { toBlob } from './bytes';
import type { DisplayShot, Rect } from './types';

/** 拼图只需要这三样 —— 钉图的 PinInitPayload 与遮罩的合成数据都满足它。 */
export interface StitchInput {
  shots: DisplayShot[];
  selection: Rect;
  outScale: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

async function decode(png: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(toBlob(png, 'image/png'));
}

/**
 * 把跨显示器的选区拼成一张图。
 *
 * 源矩形和目标矩形都用「四舍五入边长再相减」：
 * 相邻两屏共享的那条 DIP 边，代入的是同一个表达式 → 同一个整数 → 零缝隙。
 * （如果写成 `起点 + round(宽 * scale)`，两边算出来会差 1 像素。）
 */
export async function stitch(
  input: StitchInput,
): Promise<HTMLCanvasElement> {
  const { shots, selection, outScale } = input;
  const width = Math.max(1, Math.round(selection.width * outScale));
  const height = Math.max(1, Math.round(selection.height * outScale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建拼接画布');

  // 虚拟桌面里的空洞（显示器之间的缝隙）保持黑色
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  for (const shot of shots) {
    const b = shot.bounds;
    const ix0 = Math.max(selection.x, b.x);
    const iy0 = Math.max(selection.y, b.y);
    const ix1 = Math.min(selection.x + selection.width, b.x + b.width);
    const iy1 = Math.min(selection.y + selection.height, b.y + b.height);
    if (ix1 <= ix0 || iy1 <= iy0) continue;

    // 源：缩略图内的物理像素
    const px0 = clamp(Math.round((ix0 - b.x) * shot.scaleX), 0, shot.imageWidth);
    const px1 = clamp(Math.round((ix1 - b.x) * shot.scaleX), px0 + 1, shot.imageWidth);
    const py0 = clamp(Math.round((iy0 - b.y) * shot.scaleY), 0, shot.imageHeight);
    const py1 = clamp(Math.round((iy1 - b.y) * shot.scaleY), py0 + 1, shot.imageHeight);

    // 目标：输出像素
    const dx0 = Math.round((ix0 - selection.x) * outScale);
    const dx1 = Math.round((ix1 - selection.x) * outScale);
    const dy0 = Math.round((iy0 - selection.y) * outScale);
    const dy1 = Math.round((iy1 - selection.y) * outScale);

    if (dx1 <= dx0 || dy1 <= dy0) continue;

    const img = await decode(shot.png);
    // 只有比例不一致时才做重采样，1:1 保持像素原样
    ctx.imageSmoothingEnabled = Math.abs(shot.scaleX - outScale) > 0.001;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      img,
      px0,
      py0,
      px1 - px0,
      py1 - py0,
      dx0,
      dy0,
      dx1 - dx0,
      dy1 - dy0,
    );
    img.close();
  }

  ctx.imageSmoothingEnabled = true;
  return canvas;
}
