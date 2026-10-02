import { desktopCapturer, screen } from 'electron';
import type { Display, DesktopCapturerSource } from 'electron';
import type { DisplayShot, Rect } from '../shared/types';

function toUint8(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * `NativeImage.toBitmap()` 给的是 BGRA，`ImageData` 要 RGBA —— 原地交换 B/R。
 * 位图是刚分配的私有 Buffer，原地改没有副作用；截图不透明，无需处理 alpha。
 */
function bgraToRgba(buf: Buffer): Uint8Array {
  const px = toUint8(buf);
  for (let i = 0; i < px.length; i += 4) {
    const b = px[i];
    px[i] = px[i + 2];
    px[i + 2] = b;
  }
  return px;
}

export function unionBounds(displays: Display[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 按请求尺寸分组：thumbnailSize 一次调用只有一个值，混合 DPI 不能共用一次。 */
function groupByWant(displays: Display[]): Map<string, Display[]> {
  const groups = new Map<string, Display[]>();
  for (const d of displays) {
    const want = wantSize(d);
    const key = `${want.width}x${want.height}`;
    const list = groups.get(key);
    if (list) list.push(d);
    else groups.set(key, [d]);
  }
  return groups;
}

function wantSize(d: Display): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(d.bounds.width * d.scaleFactor)),
    height: Math.max(1, Math.round(d.bounds.height * d.scaleFactor)),
  };
}

/**
 * 在一次 getSources 的结果里找到某个显示器的 source。
 * 优先 `display_id`，为空则退化成下标。
 */
function pickSource(
  sources: DesktopCapturerSource[],
  display: Display,
  displays: Display[],
): DesktopCapturerSource | null {
  const byId = sources.find((s) => s.display_id === String(display.id));
  if (byId) return byId;

  if (sources.length !== displays.length) {
    console.warn(
      `[capture] display_id 匹配失败且数量不一致：sources=${sources.length} displays=${displays.length}`,
    );
    return null;
  }
  const idx = displays.findIndex((d) => d.id === display.id);
  console.warn(
    `[capture] display ${display.id} 的 display_id 为空，退化为下标 ${idx}`,
  );
  return sources[idx] ?? null;
}

export interface CaptureOptions {
  /** 滚动截图的帧循环等高频调用置 true，别让逐帧日志刷屏 */
  silent?: boolean;
}

/**
 * 抓取指定的显示器。
 *
 * `targets` 可以是全部屏，也可以只有光标所在那一块 —— 分批抓屏时用得上。
 * `display_id` 的下标回退始终对照**全部**显示器（sources 数量等于总屏数）。
 *
 * 关键点：
 * - `thumbnailSize` **不保证**被遵守（Electron 文档原文），所以拿到之后
 *   一律用 `thumbnail.getSize()` 回读，`scaleX/scaleY` 由实际尺寸反推；
 * - 后续所有几何都用 `scaleX/scaleY`，绝不用 `display.scaleFactor`；
 * - 必须在对应遮罩窗口存在**之前**调用，否则会把自己截进图里。
 */
export async function captureDisplays(
  targets: Display[],
  opts: CaptureOptions = {},
): Promise<DisplayShot[]> {
  const all = screen.getAllDisplays();
  const groups = groupByWant(targets);
  const shots: DisplayShot[] = [];

  for (const [, group] of groups) {
    const want = wantSize(group[0]);
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: want,
      fetchWindowIcons: false,
    });

    for (const display of group) {
      const source = pickSource(sources, display, all);
      if (!source) {
        throw new Error(`无法为显示器 ${display.id} 找到对应的截图源`);
      }
      const size = source.thumbnail.getSize();
      const scaleX = size.width / display.bounds.width;
      const scaleY = size.height / display.bounds.height;

      if (!opts.silent && Math.abs(scaleX - scaleY) > 0.02) {
        console.warn(
          `[capture] display ${display.id} 的 X/Y 比例偏差过大：` +
            `scaleX=${scaleX.toFixed(4)} scaleY=${scaleY.toFixed(4)}`,
        );
      }
      if (!opts.silent) {
        console.log(
          `[capture] display=${display.id}` +
            ` bounds=${display.bounds.x},${display.bounds.y} ${display.bounds.width}x${display.bounds.height}` +
            ` scaleFactor=${display.scaleFactor}` +
            ` want=${want.width}x${want.height}` +
            ` actual=${size.width}x${size.height}` +
            ` ratio=${scaleX.toFixed(4)}/${scaleY.toFixed(4)}` +
            ` display_id="${source.display_id}"`,
        );
      }

      // 原始位图代替 PNG：整屏 PNG 同步编码要一两百毫秒，这里是纯内存交换
      const tEncode = performance.now();
      const pixels = bgraToRgba(source.thumbnail.toBitmap());
      if (pixels.length !== size.width * size.height * 4) {
        throw new Error(
          `display ${display.id} 位图尺寸不符：${pixels.length} != ${size.width}x${size.height}x4`,
        );
      }
      if (!opts.silent) {
        console.log(
          `[capture] display=${display.id} 位图转换 ${Math.round(performance.now() - tEncode)}ms`,
        );
      }

      shots.push({
        displayId: display.id,
        bounds: { ...display.bounds },
        scaleX,
        scaleY,
        imageWidth: size.width,
        imageHeight: size.height,
        pixels,
      });
    }
  }

  if (shots.length !== targets.length) {
    throw new Error(
      `截图数量与请求的显示器数量不一致：${shots.length} != ${targets.length}`,
    );
  }

  return shots;
}

/**
 * 输出缩放：取相交屏里的最大比例。
 * 用主屏比例会**不可逆**地丢掉 150% 屏的文字像素；放大不丢数据，缩小才丢。
 */
export function resolveOutScale(
  shots: DisplayShot[],
  selection: Rect,
): number {
  let out = 0;
  for (const shot of shots) {
    if (!intersects(shot.bounds, selection)) continue;
    out = Math.max(out, shot.scaleX, shot.scaleY);
  }
  return out > 0 ? out : 1;
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
