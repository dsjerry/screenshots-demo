/**
 * 录屏 GIF 的颜色量化与帧处理。
 *
 * GIF 每帧只有 256 色，而屏幕截图动辄几万种颜色 —— 不量化就只能靠抖动，
 * 画面会脏得没法看。这里用**中位切分**（median cut）：把所有像素按 RGB
 * 三个通道里跨度最大的那个递归对半分，直到切出 256 个盒子，每个盒子取
 * 平均色。它比「按频率取前 256 色」更适合界面截图：大面积纯色（背景、
 * 面板）会各自占一个盒子而不被相邻的渐变色挤掉。
 *
 * 全片**共用一个调色板**（GIF 全局色表）：
 * - 每帧换盘会让静态区域在帧间轻微变色，看起来像在闪；
 * - 共用一张表也能省掉每帧 768 字节的局部色表。
 */

/** 量化结果：全局调色板 + 每像素的索引图 */
export interface QuantizedFrame {
  /** 索引图，长度 = width × height */
  indices: Uint8Array;
}

export interface QuantizeResult {
  /** 调色板大小（2 的幂，≥ 2） */
  size: number;
  /** RGB 三元组，长度 = size × 3 */
  rgb: Uint8Array;
  frames: QuantizedFrame[];
}

interface Box {
  /** 像素下标（指向共享的采样数组） */
  pixels: number[];
  /** 该盒子内每个通道的跨度，用于挑「最该切」的盒子 */
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

/**
 * 中位切分：`samples` 是 RGB 三元组连续排布的**采样色**（不必是全量像素，
 * 大图先抽稀到几千个点就足够决定调色板）。
 */
function medianCut(samples: Uint8Array, maxColors: number): { rgb: Uint8Array; size: number } {
  const count = samples.length / 3;
  const makeBox = (pixels: number[]): Box => {
    let rMin = 255,
      rMax = 0,
      gMin = 255,
      gMax = 0,
      bMin = 255,
      bMax = 0;
    for (const p of pixels) {
      const r = samples[p * 3],
        g = samples[p * 3 + 1],
        b = samples[p * 3 + 2];
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
    }
    return { pixels, rMin, rMax, gMin, gMax, bMin, bMax };
  };

  const all: number[] = [];
  for (let i = 0; i < count; i++) all.push(i);
  const boxes: Box[] = [makeBox(all)];

  while (boxes.length < maxColors) {
    // 挑跨度最大（按最宽的通道）且非空可分的盒子
    let bestIdx = -1;
    let bestSpan = 0;
    let bestChannel: 'r' | 'g' | 'b' = 'r';
    boxes.forEach((box, i) => {
      const spans = { r: box.rMax - box.rMin, g: box.gMax - box.gMin, b: box.bMax - box.bMin };
      const channel = (Object.keys(spans) as ('r' | 'g' | 'b')[]).reduce((a, b) => (spans[b] > spans[a] ? b : a));
      if (box.pixels.length < 2) return;
      if (spans[channel] > bestSpan) {
        bestSpan = spans[channel];
        bestIdx = i;
        bestChannel = channel;
      }
    });
    if (bestIdx < 0) break;

    const box = boxes[bestIdx];
    const offset = bestChannel === 'r' ? 0 : bestChannel === 'g' ? 1 : 2;
    // 按该通道排序后对半分
    const sorted = [...box.pixels].sort((a, b) => samples[a * 3 + offset] - samples[b * 3 + offset]);
    const mid = sorted.length >> 1;
    boxes.splice(bestIdx, 1, makeBox(sorted.slice(0, mid)), makeBox(sorted.slice(mid)));
  }

  // 每个盒子取平均色
  const size = Math.max(2, boxes.length);
  const rgb = new Uint8Array(size * 3);
  boxes.forEach((box, i) => {
    let r = 0,
      g = 0,
      b = 0;
    for (const p of box.pixels) {
      r += samples[p * 3];
      g += samples[p * 3 + 1];
      b += samples[p * 3 + 2];
    }
    const n = Math.max(1, box.pixels.length);
    rgb[i * 3] = Math.round(r / n);
    rgb[i * 3 + 1] = Math.round(g / n);
    rgb[i * 3 + 2] = Math.round(b / n);
  });
  return { rgb, size };
}

/** 把 RGB 量化成「每通道 5 位」的桶键，用于最近的调色板项查找缓存 */
function bucketKey(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * 把若干帧 RGBA 量化成同一套调色板。
 *
 * @param frames   每帧的 RGBA 数据（长度必须都是 width × height × 4）
 * @param maxColors 调色板上限（GIF 最多 256）
 */
export function quantize(
  frames: Uint8ClampedArray<ArrayBuffer>[],
  width: number,
  height: number,
  maxColors = 256,
): QuantizeResult {
  const pixelCount = width * height;

  // ---- ① 采样：均匀抽稀到 ≤ 20000 个点，够决定 256 色又不至于拖慢
  const totalPixels = pixelCount * frames.length;
  const step = Math.max(1, Math.floor(totalPixels / 20000));
  const sampleList: number[] = [];
  frames.forEach((frame) => {
    for (let i = 0; i < pixelCount; i += step) {
      sampleList.push(frame[i * 4], frame[i * 4 + 1], frame[i * 4 + 2]);
    }
  });
  const samples = Uint8Array.from(sampleList);

  // ---- ② 中位切分出全局调色板（大小取 2 的幂，GIF 色表要求）
  const cap = Math.max(2, Math.min(256, maxColors));
  const { rgb, size } = medianCut(samples, cap);

  // ---- ③ 建查询缓存：同一桶直接复用上次的结果（界面截图大量重复色）
  const cache = new Int16Array(1 << 15).fill(-1);
  const nearest = (r: number, g: number, b: number): number => {
    const key = bucketKey(r, g, b);
    const hit = cache[key];
    if (hit >= 0) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < size; i++) {
      const dr = r - rgb[i * 3];
      const dg = g - rgb[i * 3 + 1];
      const db = b - rgb[i * 3 + 2];
      // 人眼对绿色更敏感，按亮度权重加权
      const dist = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    cache[key] = best;
    return best;
  };

  // ---- ④ 逐帧映射成索引图
  const quantized: QuantizedFrame[] = frames.map((frame) => {
    const indices = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
      indices[i] = nearest(frame[i * 4], frame[i * 4 + 1], frame[i * 4 + 2]);
    }
    return { indices };
  });

  return { size, rgb, frames: quantized };
}

/**
 * 合并连续相同的帧：把重复帧的时长累加到前一帧上。
 *
 * 录屏里大量帧是完全静止的（用户在读、在发呆），每帧都存一遍会让 GIF
 * 体积翻几倍。合并后播放效果完全一致 —— 只是那一帧的显示时长变长。
 *
 * @returns 合并后的 { indices, delay } 序列（delay 单位毫秒）
 */
export function dedupeFrames(
  frames: QuantizedFrame[],
  /** 每帧的实际间隔（毫秒），长度与 frames 相同 */
  intervals: number[],
): { indices: Uint8Array; delay: number }[] {
  const out: { indices: Uint8Array; delay: number }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const delay = Math.max(10, intervals[i] ?? 100);
    const last = out[out.length - 1];
    if (last && sameIndices(last.indices, frames[i].indices)) {
      last.delay += delay;
      continue;
    }
    out.push({ indices: frames[i].indices, delay });
  }
  return out;
}

function sameIndices(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
