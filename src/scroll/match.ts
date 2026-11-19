/**
 * 长图拼接的纯匹配逻辑（无 DOM / 无 IPC），便于单元测试复现重复内容。
 * 控制条（scroll.ts）只负责把帧与累积缓冲交给这里，再决定追加哪些行。
 */

/** 行指纹的采样列数：匹配成本 O(搜索位置 × 探针行数 × 64)，几十毫秒内完成 */
export const SIG_COLS = 64;
/** 平均行差超过它视为未对上（丢帧），避免把动画中间帧拼进去 */
export const MATCH_THRESHOLD = 10;
/** 探针高度：从累积缓冲取 N 行指纹，到新帧里定位「已见内容」的末尾 */
export const PROBE_ROWS = 24;
/**
 * 探针与帧底部的间距（帧行数）。贴底的行往往是**静止**的：
 * 窗口底边框 / 状态栏，以及（区域≈整屏时）悬在区域内的控制条——
 * 拿静止行做探针会在每一帧的同一位置「完美匹配」，永远判无新内容。
 * 探针与追加起点都越过这段，代价只是对齐锚点上移，不丢内容。
 */
export const BOTTOM_MARGIN = 200;

/**
 * 探针的起始行：[start, start + PROBE_ROWS)。
 * 边距按**最近一帧的高度**自适应，而不是累积高度：探针必须落在最新帧的可视范围内，
 * 否则缓冲变长后探针会被推到帧顶之上，新帧里找不到它，整段内容就被丢掉。
 * 小区域用小边距（小区域的控制条在区域外，贴底只有几行静止边框）。
 */
export function probeStartFor(accHeight: number, frameHeight: number): number {
  const margin = Math.min(BOTTOM_MARGIN, Math.max(0, Math.floor((frameHeight - PROBE_ROWS) / 2)));
  return Math.max(0, accHeight - PROBE_ROWS - margin);
}

/** 单行指纹：64 列、每列横向取 3 像素均值的亮度。 */
export function rowSig(data: Uint8ClampedArray, row: number, width: number): Float32Array {
  const sig = new Float32Array(SIG_COLS);
  const base = row * width * 4;
  const step = width / SIG_COLS;
  for (let c = 0; c < SIG_COLS; c++) {
    let sum = 0;
    for (let k = -1; k <= 1; k++) {
      const x = Math.max(0, Math.min(width - 1, Math.round((c + 0.5) * step) + k)) * 4;
      const i = base + x;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    sig[c] = sum / 3;
  }
  return sig;
}

/** 累积缓冲的只读视图：像素、宽高与每行签名。 */
export interface AccView {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  sigs: Float32Array[];
}

/** 探针（累积缓冲 [probe, probe+PROBE_ROWS) 行）在新帧 t 行处开始对齐的平均行差（签名版）。 */
export function probeDiffAt(t: number, probe: number, acc: AccView, stripSigs: Float32Array[]): number {
  let sum = 0;
  for (let r = 0; r < PROBE_ROWS; r++) {
    const a = acc.sigs[probe + r];
    const b = stripSigs[t + r];
    let d = 0;
    for (let c = 0; c < SIG_COLS; c++) d += Math.abs(a[c] - b[c]);
    sum += d / SIG_COLS;
  }
  return sum / PROBE_ROWS;
}

/**
 * 探针的实际像素版本（逐 2 列采样，RGB 差均值）—— 行签名是均值指纹，
 * 有量化噪声；接缝处差 1 行肉眼可见，最后用它在 ±2 行内做精确定位。
 */
export function probeDiffFull(t: number, probe: number, acc: AccView, strip: Uint8ClampedArray): number {
  const rowBytes = acc.width * 4;
  let sum = 0;
  let n = 0;
  for (let r = 0; r < PROBE_ROWS; r++) {
    const aRow = (probe + r) * rowBytes;
    const bRow = (t + r) * rowBytes;
    for (let x = 0; x < acc.width; x += 2) {
      const i = aRow + x * 4;
      const j = bRow + x * 4;
      sum +=
        Math.abs(acc.data[i] - strip[j]) +
        Math.abs(acc.data[i + 1] - strip[j + 1]) +
        Math.abs(acc.data[i + 2] - strip[j + 2]);
      n += 3;
    }
  }
  return n > 0 ? sum / n : Infinity;
}

/**
 * 在新帧里定位累积缓冲的探针，返回对位点 bestT（新帧的行号）与其平均行差。
 * 三遍：签名全局最小 → 最小+2 容差内取最小 t（抗抖动）→ ±2 行像素精修。
 */
export function alignFrame(
  acc: AccView,
  probe: number,
  strip: Uint8ClampedArray,
  stripSigs: Float32Array[],
  height: number,
): { bestT: number; best: number } {
  const diffs: number[] = [];
  let minDiff = Infinity;
  for (let t = 0; t + PROBE_ROWS <= height; t++) {
    const d = probeDiffAt(t, probe, acc, stripSigs);
    diffs.push(d);
    if (d < minDiff) minDiff = d;
  }
  let pick = diffs.length - 1;
  for (let t = 0; t < diffs.length; t++) {
    if (diffs[t] <= minDiff + 2) {
      pick = t;
      break;
    }
  }
  let fine = pick;
  let fineBest = Infinity;
  for (let t = Math.max(0, pick - 2); t <= Math.min(pick + 2, height - PROBE_ROWS); t++) {
    const d = probeDiffFull(t, probe, acc, strip);
    if (d < fineBest) {
      fineBest = d;
      fine = t;
    }
  }
  return { bestT: fine, best: fineBest };
}

/**
 * 新帧对位后，应从帧的哪一行起追加到累积缓冲（以及追加多少行）。
 * 探针在累积缓冲的 probe 行，在新帧的 bestT 行对上；累积缓冲的末尾对应新帧的
 * bestT + (accHeight - probe)。之后才是真正的新内容。新内容不足 0 行 = 无新内容。
 */
export function appendRange(
  accHeight: number,
  probe: number,
  bestT: number,
  frameHeight: number,
): { start: number; rows: number } {
  const start = bestT + (accHeight - probe);
  return { start, rows: frameHeight - start };
}
