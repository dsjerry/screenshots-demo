import type { ScrollFramePayload, ScrollSpeed } from '../shared/types';

/**
 * 滚动截长图的拼接器（控制条渲染进程）。
 *
 * 主进程每 250ms 推来一帧选区条带（RGBA），这里把它拼进累积缓冲：
 * - 行签名：每行按 64 列采样亮度，作为该行的指纹；
 * - 探针匹配：取累积缓冲**底部** PROBE_ROWS 行（当前最新内容）作探针，
 *   在新帧**任意位置**搜索对齐 —— 不能假设「帧顶对帧底」：窗口捕获
 *   整窗采纳的选区带着静止的标题栏 / 工具栏，内容在框架之下滚动。
 *   平均行差超过阈值视为没对上（滚动动画中间帧等），整帧丢弃；
 * - 追加：探针之后的行写进累积缓冲，高度增长，不渲染预览。
 *
 * 用户滚动鼠标滚轮（手动）或程序注入滚轮（自动），内容越来越长；
 * 「复制 / 保存」把累积缓冲一次性转成 PNG 交给主进程。只支持向下
 * 滚动 —— 向上滚的帧找不到探针自然丢弃。
 */

const sizeEl = document.getElementById('size') as HTMLSpanElement;
const hintEl = document.getElementById('hint') as HTMLSpanElement;

/** 行指纹的采样列数：匹配成本 O(搜索位置 × 探针行数 × 64)，几十毫秒内完成 */
const SIG_COLS = 64;
/** 平均行差超过它视为未对上（丢帧），避免把动画中间帧拼进去 */
const MATCH_THRESHOLD = 10;
/** 探针高度：从累积缓冲取 N 行指纹，到新帧里定位「已见内容」的末尾 */
const PROBE_ROWS = 24;
/**
 * 探针与帧底部的间距（帧行数）。贴底的行往往是**静止**的：
 * 窗口底边框 / 状态栏，以及（区域≈整屏时）悬在区域内的控制条——
 * 拿静止行做探针会在每一帧的同一位置「完美匹配」，永远判无新内容。
 * 探针与追加起点都越过这段，代价只是对齐锚点上移，不丢内容。
 */
const BOTTOM_MARGIN = 200;
/** 连续这么久没新内容就提示可以收手了（不自动停，用户可能只是暂停） */
const IDLE_HINT_FRAMES = 8;

/**
 * 本次探针的取行区间：[start, start + PROBE_ROWS)。
 * 边距按累积高度自适应——小区域用小边距（小区域的控制条在区域外，
 * 贴底只有几行静止边框，不需要也不容许大边距）。
 */
function probeStart(): number {
  if (!acc) return 0;
  const margin = Math.min(BOTTOM_MARGIN, Math.floor((acc.height - PROBE_ROWS) / 2));
  return acc.height - PROBE_ROWS - margin;
}

interface Accum {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  cap: number;
  /** 每行签名，与 data 的行一一对应 */
  sigs: Float32Array[];
}

let acc: Accum | null = null;
let idleFrames = 0;

/** 当前滚动方式：manual = 用户滚滚轮；auto = 主进程注入滚轮 */
let mode: 'manual' | 'auto' = 'manual';
/** 自动模式下判定「到底」的静默帧数（6 帧 ≈ 1.5s 无新内容） */
const AUTO_BOTTOM_IDLE_FRAMES = 6;
let bottomNotified = false;

const HINT_DEFAULT = '滚动鼠标滚轮追加内容';
const HINT_AUTO = '自动滚动中，移出选区即暂停';
const HINT_BOTTOM = '已到底部，可复制 / 保存';
const HINT_IDLE = '未检测到新内容，可点击复制 / 保存';

const modeManualBtn = document.getElementById('mode-manual') as HTMLButtonElement;
const modeAutoBtn = document.getElementById('mode-auto') as HTMLButtonElement;

/** 切换滚动方式；主进程负责注入 / 停止（manual 停掉进行中的自动滚动） */
function setMode(next: 'manual' | 'auto'): void {
  if (mode === next) return;
  mode = next;
  modeManualBtn.classList.toggle('is-active', mode === 'manual');
  modeAutoBtn.classList.toggle('is-active', mode === 'auto');
  bottomNotified = false;
  hintEl.textContent = mode === 'auto' ? HINT_AUTO : HINT_DEFAULT;
  void window.api.scroll
    .action({ kind: mode })
    .catch(() => {});
}

modeManualBtn.addEventListener('click', () => setMode('manual'));
modeAutoBtn.addEventListener('click', () => setMode('auto'));

/** 自动滚动速度（点击速度按钮循环切换；主进程热更注入格数） */
const SPEED_ORDER: ScrollSpeed[] = ['normal', 'fast', 'slow'];
const SPEED_LABEL: Record<ScrollSpeed, string> = {
  slow: '慢',
  normal: '中',
  fast: '快',
};
let speed: ScrollSpeed = 'normal';
const speedBtn = document.getElementById('speed') as HTMLButtonElement;
speedBtn.textContent = SPEED_LABEL[speed];
speedBtn.addEventListener('click', () => {
  speed = SPEED_ORDER[(SPEED_ORDER.indexOf(speed) + 1) % SPEED_ORDER.length];
  speedBtn.textContent = SPEED_LABEL[speed];
  void window.api.scroll.action({ kind: 'speed', speed }).catch(() => {});
});

function updateStatus(): void {
  if (!acc) return;
  sizeEl.textContent = `${acc.width} × ${acc.height}`;
  hintEl.textContent =
    mode === 'auto' && bottomNotified
      ? HINT_BOTTOM
      : idleFrames >= IDLE_HINT_FRAMES
        ? HINT_IDLE
        : mode === 'auto'
          ? HINT_AUTO
          : HINT_DEFAULT;
}

/** 单行指纹：64 列、每列横向取 3 像素均值的亮度。 */
function rowSig(data: Uint8ClampedArray, row: number, width: number): Float32Array {
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

/**
 * 探针（累积缓冲 [start, start+PROBE_ROWS) 行，start 越过贴底静止带）
 * 在新帧 t 行处开始对齐的平均行差。
 */
function probeDiffAt(t: number, probeStart: number, stripSigs: Float32Array[]): number {
  if (!acc) return Infinity;
  let sum = 0;
  for (let r = 0; r < PROBE_ROWS; r++) {
    const a = acc.sigs[probeStart + r];
    const b = stripSigs[t + r];
    let d = 0;
    for (let c = 0; c < SIG_COLS; c++) d += Math.abs(a[c] - b[c]);
    sum += d / SIG_COLS;
  }
  return sum / PROBE_ROWS;
}

/**
 * 探针的**实际像素**版本（逐 2 列采样，RGB 差均值）—— 行签名是均值指纹，
 * 有量化噪声；接缝处差 1 行肉眼可见，最后用它在 ±2 行内做精确定位。
 */
function probeDiffFull(t: number, probeStart: number, strip: Uint8ClampedArray): number {
  if (!acc) return Infinity;
  const rowBytes = acc.width * 4;
  let sum = 0;
  let n = 0;
  for (let r = 0; r < PROBE_ROWS; r++) {
    const aRow = (probeStart + r) * rowBytes;
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

function grow(): void {
  if (!acc) return;
  const cap = acc.cap * 2;
  const next = new Uint8ClampedArray(acc.width * cap * 4);
  next.set(acc.data.subarray(0, acc.height * acc.width * 4));
  acc.data = next;
  acc.cap = cap;
}

/** 把 strip 的 [srcRow, srcRow + count) 行追加进累积缓冲。 */
function appendStrip(strip: Uint8ClampedArray, srcRow: number, count: number): void {
  if (!acc) return;
  while (acc.height + count > acc.cap) grow();
  const rowBytes = acc.width * 4;
  acc.data.set(
    strip.subarray(srcRow * rowBytes, (srcRow + count) * rowBytes),
    acc.height * rowBytes,
  );
  for (let r = 0; r < count; r++) {
    acc.sigs.push(rowSig(strip, srcRow + r, acc.width));
  }
  acc.height += count;
}

window.api.scroll.frame((frame: ScrollFramePayload) => {
  const strip = new Uint8ClampedArray(frame.pixels);
  const { width, height } = frame;

  if (!acc) {
    acc = {
      data: new Uint8ClampedArray(width * Math.max(256, height * 4) * 4),
      width,
      height: 0,
      cap: Math.max(256, height * 4),
      sigs: [],
    };
    appendStrip(strip, 0, height);
    idleFrames = 0;
    updateStatus();
    return;
  }
  if (width !== acc.width || height <= PROBE_ROWS + 4) return;

  // 探针 = 累积缓冲里越过贴底静止带的一段（见 BOTTOM_MARGIN），在**新帧
  // 任意位置**定位它。不能用「帧顶对帧底」的重叠模型：窗口捕获整窗采纳
  // 的选区带着静止的标题栏 / 工具栏，内容在框架之下滚动，帧顶永远不变，
  // 旧模型会完全失配。探针之后（含边距）的行才是新内容；探针贴着
  // 「帧底 - 边距」= 没有新内容。
  const pStart = probeStart();
  const stripSigs: Float32Array[] = [];
  for (let r = 0; r < height; r++) stripSigs.push(rowSig(strip, r, width));

  // 第一遍：行签名找全局最小差
  const diffs: number[] = [];
  let minDiff = Infinity;
  for (let t = 0; t + PROBE_ROWS <= height; t++) {
    const d = probeDiffAt(t, pStart, stripSigs);
    diffs.push(d);
    if (d < minDiff) minDiff = d;
  }
  // 第二遍：最小差 +2 容差内取**最小** t —— 内容连续时相邻 t 的签名差
  // 极小，纯 argmin 会抖动 ±1 行造成接缝；均匀内容（全页同色）时取最小
  // t 等于多追加内容，与旧行为一致
  let pick = diffs.length - 1;
  for (let t = 0; t < diffs.length; t++) {
    if (diffs[t] <= minDiff + 2) {
      pick = t;
      break;
    }
  }
  // 第三遍：±2 行内用**实际像素**精修 —— 行签名是 64 列均值，有量化
  // 噪声，差 1 行就是肉眼可见的接缝
  let fine = pick;
  let fineBest = Infinity;
  for (let t = Math.max(0, pick - 2); t <= Math.min(pick + 2, height - PROBE_ROWS); t++) {
    const d = probeDiffFull(t, pStart, strip);
    if (d < fineBest) {
      fineBest = d;
      fine = t;
    }
  }
  const bestT = fine;
  const best = fineBest;
  // 探针起点对齐到 strip 的 bestT 后，accum 的最后一行对应 strip 的
  // bestT + (H - pStart) —— 之后才是真正的新内容（含被边距跳过的部分）
  const appendStart = bestT + (acc!.height - pStart);
  const newRows = height - appendStart;
  if (bestT < 0 || best > MATCH_THRESHOLD || newRows <= 0) {
    idleFrames++;
    // 自动模式下连续多帧无新内容 = 到底：通知主进程停止注入（只发一次）
    if (mode === 'auto' && !bottomNotified && idleFrames >= AUTO_BOTTOM_IDLE_FRAMES) {
      bottomNotified = true;
      void window.api.scroll.action({ kind: 'bottom' }).catch(() => {});
    }
    updateStatus();
    return;
  }
  idleFrames = 0;
  bottomNotified = false;
  appendStrip(strip, appendStart, newRows);
  updateStatus();
});

async function finish(kind: 'copy' | 'save' | 'edit'): Promise<void> {
  if (!acc || acc.height === 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = acc.width;
  canvas.height = acc.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const bytes = acc.data.slice(0, acc.width * acc.height * 4);
  ctx.putImageData(new ImageData(bytes, acc.width, acc.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  if (!blob) return;
  const png = new Uint8Array(await blob.arrayBuffer());
  try {
    // 主进程收到后会先销毁本窗口再导出 / 转编辑，invoke 的 Promise 可能被掐断
    await window.api.scroll.action({ kind, png });
  } catch {
    /* 忽略：导出在主进程侧继续 */
  }
}

const copyBtn = document.getElementById('copy') as HTMLButtonElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const editBtn = document.getElementById('edit') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
copyBtn.addEventListener('click', () => void finish('copy'));
saveBtn.addEventListener('click', () => void finish('save'));
editBtn.addEventListener('click', () => void finish('edit'));
const cancel = (): void => {
  void window.api.scroll.action({ kind: 'cancel' }).catch(() => {});
};
cancelBtn.addEventListener('click', cancel);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
});
