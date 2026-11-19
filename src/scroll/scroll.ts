import type { ScrollFramePayload, ScrollSpeed } from '../shared/types';
import { alignFrame, appendRange, MATCH_THRESHOLD, PROBE_ROWS, probeStartFor, rowSig } from './match';
import { toClamped } from 'electron-snip/utils';

/**
 * 滚动截长图的拼接器（控制条渲染进程）。
 *
 * 主进程每 250ms 推来一帧选区条带（RGBA），这里把它拼进累积缓冲：
 * - 行签名：每行按 64 列采样亮度，作为该行的指纹；
 * - 探针匹配：取累积缓冲**底部** PROBE_ROWS 行（当前最新内容）作探针，
 *   在新帧**任意位置**搜索对齐 —— 不能假设「帧顶对帧底」：窗口捕获
 *   整窗采纳的选区带着静止的标题栏 / 工具栏，内容在框架之下滚动。
 *   平均行差超过阈值视为没对上（滚动动画中间帧等），整帧丢弃；
 * - 追加：探针之后的行写进累积缓冲，同步喂给小地图的迷你缩略缓冲
 *   （见 appendStrip）。
 *
 * 用户滚动鼠标滚轮（手动）或程序注入滚轮（自动），内容越来越长；
 * 「复制 / 保存」把累积缓冲一次性转成 PNG 交给主进程。只支持向下
 * 滚动 —— 向上滚的帧找不到探针自然丢弃。
 *
 * 本入口有**两个角色**（URL hash 分发，见 `scroll-capture.ts` 的
 * loadScrollPage）：`#bar` = 控制条（拼接 + UI），`#minimap` = 贴在
 * 选区旁的小地图窗（只画快照）。拼接状态只在控制条进程里，小地图
 * 收到的现成缩略图由控制条经主进程转发（scroll:minimap）。
 */

const ROLE: 'bar' | 'minimap' = location.hash === '#minimap' ? 'minimap' : 'bar';

/** 连续这么久没新内容就提示可以收手了（不自动停，用户可能只是暂停） */
const IDLE_HINT_FRAMES = 8;
/** 探针连续失配这么多帧后提示用户放慢。失配的帧一律丢弃，不追加任何内容 */
const DESYNC_HINT_FRAMES = 2;

/** 当前探针失配的连续帧数（成功追加或完美对齐都会清零） */
let desyncFrames = 0;

interface Accum {
  /** 缓冲始终由本地 new 创建（非共享内存），导出时 subarray 零拷贝喂 ImageData */
  data: Uint8ClampedArray<ArrayBuffer>;
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
/** 「到底」已停止注入；再出现新内容时自动恢复注入（懒加载长页会误判到底） */
let autoStoppedByBottom = false;

const HINT_DEFAULT = '滚动鼠标滚轮追加内容';
const HINT_AUTO = '自动滚动中，移出选区即暂停';
const HINT_BOTTOM = '已到底部，可复制 / 保存';
const HINT_IDLE = '未检测到新内容，可点击复制 / 保存';
const HINT_DESYNC = '滚动过快没对齐，已尝试自动续接；建议放慢速度';

/**
 * 控制条角色：拼接、状态栏、滚动方式 / 速度、动作按钮、帧订阅与小地图
 * 快照推送 —— 控制条窗口的全部逻辑。纯函数与状态留在模块层，小地图
 * 角色用不到但不碍事；DOM 与事件订阅必须留在这里（小地图窗口没有这些元素）。
 */
function startBar(): void {
  const sizeEl = document.getElementById('size') as HTMLSpanElement;
  const hintEl = document.getElementById('hint') as HTMLSpanElement;

  const modeManualBtn = document.getElementById('mode-manual') as HTMLButtonElement;
  const modeAutoBtn = document.getElementById('mode-auto') as HTMLButtonElement;
  const startBtn = document.getElementById('start') as HTMLButtonElement;
  const speedEl = document.getElementById('speed') as HTMLButtonElement;
  // 确认开始之前不允许切换滚动方式（否则自动模式会在用户还没准备好时就开始注入）
  for (const el of [modeManualBtn, modeAutoBtn, speedEl]) el.disabled = true;
  startBtn.addEventListener('click', () => {
    startBtn.hidden = true;
    for (const el of [modeManualBtn, modeAutoBtn, speedEl]) el.disabled = false;
    hintEl.textContent = HINT_DEFAULT;
    void window.api.scroll.action({ kind: 'start' }).catch(() => {});
  });

  /** 切换滚动方式；主进程负责注入 / 停止（manual 停掉进行中的自动滚动） */
  function setMode(next: 'manual' | 'auto'): void {
    if (mode === next) return;
    mode = next;
    modeManualBtn.classList.toggle('is-active', mode === 'manual');
    modeAutoBtn.classList.toggle('is-active', mode === 'auto');
    bottomNotified = false;
    desyncFrames = 0;
    autoStoppedByBottom = false;
    hintEl.textContent = mode === 'auto' ? HINT_AUTO : HINT_DEFAULT;
    void window.api.scroll.action({ kind: mode }).catch(() => {});
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

  // 自动滚动依赖 Win32 滚轮注入（user32），mac 没有对应实现 —— 按钮藏掉，
  // 不然点了只是空欢喜：提示写着「自动滚动中」却什么都不会滚
  const isMac = /mac/i.test(navigator.platform);
  if (isMac) {
    modeAutoBtn.hidden = true;
    speedBtn.hidden = true;
  }

  function updateStatus(): void {
    if (!acc) return;
    sizeEl.textContent = `${acc.width} × ${acc.height}`;
    hintEl.textContent =
      mode === 'auto' && bottomNotified
        ? HINT_BOTTOM
        : desyncFrames >= DESYNC_HINT_FRAMES
          ? HINT_DESYNC
          : idleFrames >= IDLE_HINT_FRAMES
            ? HINT_IDLE
            : mode === 'auto'
              ? HINT_AUTO
              : HINT_DEFAULT;
  }

  function grow(): void {
    if (!acc) return;
    const cap = acc.cap * 2;
    const next = new Uint8ClampedArray(acc.width * cap * 4);
    next.set(acc.data.subarray(0, acc.height * acc.width * 4));
    acc.data = next;
    acc.cap = cap;
  }

  // ------------------------------------------------------------ 小地图上行

  /**
   * 小地图的增量缩略缓冲：appendStrip 是全部新行的唯一入口，在这里同步做
   * 最近邻降采样（宽 MINI_WIDTH，行映射 floor(绝对行号 × k)，落到同一目标
   * 行的源行累加取平均）。绝不做全量重采样 —— 长图几万行时全量 ImageData
   * 是上百 MB 级的分配，而增量维护每行只碰 MINI_WIDTH 个采样点。
   */
  const MINI_WIDTH = 96;
  /** 快照推送节流：小地图是给人看方向的，600ms 足够跟手 */
  const MINIMAP_PUSH_MS = 600;

  interface MiniBuffer {
    /** 已完成目标行的 RGB 均值，连续排布（行 × MINI_WIDTH × 4） */
    data: Uint8ClampedArray;
    /** data 的容量（行数），随高度翻倍 */
    cap: number;
    /** 已完成的目标行数；未满一行的部分在 sum / count 里累计 */
    height: number;
    /** 当前目标行的 RGB 累加（×3 通道连续） */
    sum: Float32Array;
    /** 当前目标行已累计的源行数 */
    count: number;
    /** 降采样比（横竖同比），acc 建立时定死 */
    k: number;
    /** 目标列 → 源列的最近邻采样表 */
    cols: Int32Array;
  }

  let mini: MiniBuffer | null = null;
  /** 当前视口（帧条带）顶部在累积缓冲里的行号；帧高 = 视口高 */
  let viewTop = 0;
  let viewHeight = 0;

  function ensureMini(width: number): void {
    if (mini) return;
    const ratio = MINI_WIDTH / width;
    const cols = new Int32Array(MINI_WIDTH);
    for (let c = 0; c < MINI_WIDTH; c++) {
      cols[c] = Math.min(width - 1, Math.floor((c + 0.5) / ratio));
    }
    mini = {
      data: new Uint8ClampedArray(MINI_WIDTH * 256 * 4),
      cap: 256,
      height: 0,
      sum: new Float32Array(MINI_WIDTH * 3),
      count: 0,
      // 行向缩放**封顶 1**：窄选区（物理宽 < 96，1x 屏 + MIN_SCROLL_REGION
      // 就会触发）ratio > 1 时行映射会跳行，miniAddRow 的兜底会把后续
      // 行全丢掉、缩略图冻结在第一帧。列向允许重复采样（放大是纯视觉），
      // 行向只许缩小。
      k: Math.min(1, ratio),
      cols,
    };
  }

  function growMini(): void {
    if (!mini) return;
    const cap = mini.cap * 2;
    const next = new Uint8ClampedArray(MINI_WIDTH * cap * 4);
    next.set(mini.data.subarray(0, mini.height * MINI_WIDTH * 4));
    mini.data = next;
    mini.cap = cap;
  }

  /** 当前累计行写入 data（按已累计源行数取均值），height 前进一行 */
  function finalizeMiniRow(): void {
    if (!mini) return;
    if (mini.height >= mini.cap) growMini();
    const row = mini.height * MINI_WIDTH * 4;
    const n = Math.max(1, mini.count);
    for (let c = 0; c < MINI_WIDTH; c++) {
      mini.data[row + c * 4] = mini.sum[c * 3] / n;
      mini.data[row + c * 4 + 1] = mini.sum[c * 3 + 1] / n;
      mini.data[row + c * 4 + 2] = mini.sum[c * 3 + 2] / n;
      mini.data[row + c * 4 + 3] = 255;
    }
    mini.height += 1;
    mini.sum.fill(0);
    mini.count = 0;
  }

  /** 单个源行（绝对行号 ar，像素取 strip 的 srcRow 行）累加进迷你缓冲 */
  function miniAddRow(strip: Uint8ClampedArray, width: number, srcRow: number, ar: number): void {
    if (!mini) return;
    const tr = Math.floor(ar * mini.k);
    // k < 1 时相邻源行的目标行最多前进 1 行；防一刀兜底
    if (tr > mini.height + 1) return;
    if (tr > mini.height) finalizeMiniRow();
    const base = srcRow * width * 4;
    for (let c = 0; c < MINI_WIDTH; c++) {
      const i = base + mini.cols[c] * 4;
      mini.sum[c * 3] += strip[i];
      mini.sum[c * 3 + 1] += strip[i + 1];
      mini.sum[c * 3 + 2] += strip[i + 2];
    }
    mini.count += 1;
  }

  /** 把 strip 的 [srcRow, srcRow + count) 行追加进累积缓冲。 */
  function appendStrip(strip: Uint8ClampedArray, srcRow: number, count: number): void {
    if (!acc) return;
    ensureMini(acc.width);
    while (acc.height + count > acc.cap) grow();
    const rowBytes = acc.width * 4;
    acc.data.set(strip.subarray(srcRow * rowBytes, (srcRow + count) * rowBytes), acc.height * rowBytes);
    for (let r = 0; r < count; r++) {
      acc.sigs.push(rowSig(strip, srcRow + r, acc.width));
      miniAddRow(strip, acc.width, srcRow + r, acc.height + r);
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
      viewTop = 0;
      viewHeight = height;
      idleFrames = 0;
      updateStatus();
      return;
    }
    if (width !== acc.width || height <= PROBE_ROWS + 4) return;
    // 极小选区：累积高度不足一个探针，无法匹配（再往下签名访问会越界）
    if (acc.height < PROBE_ROWS) return;

    // 探针 = 累积缓冲里越过贴底静止带的一段（见 BOTTOM_MARGIN），在**新帧
    // 任意位置**定位它。不能用「帧顶对帧底」的重叠模型：窗口捕获整窗采纳
    // 的选区带着静止的标题栏 / 工具栏，内容在框架之下滚动，帧顶永远不变，
    // 旧模型会完全失配。探针之后（含边距）的行才是新内容；探针贴着
    // 「帧底 - 边距」= 没有新内容。
    const pStart = probeStartFor(acc!.height, height);
    const stripSigs: Float32Array[] = [];
    for (let r = 0; r < height; r++) stripSigs.push(rowSig(strip, r, width));
    const { bestT, best } = alignFrame(acc!, pStart, strip, stripSigs, height);
    // 视口框：探针（acc 的 pStart 行）对上了 strip 的 bestT 行，所以
    // strip 第 0 行对应 acc 的 pStart - bestT 行 —— 那正是当前屏幕内容
    // 在长图里的位置（向上滚时它正确上移；bestT 是探针对位点，不是帧顶）
    viewTop = Math.max(0, pStart - bestT);
    viewHeight = height;
    // 探针起点对齐到 strip 的 bestT 后，accum 的最后一行对应 strip 的
    // bestT + (H - pStart) —— 之后才是真正的新内容（含被边距跳过的部分）
    const { start: appendStart, rows: newRows } = appendRange(acc!.height, pStart, bestT, height);
    if (best > MATCH_THRESHOLD) {
      // 探针没对上：本帧丢弃，不追加任何内容（重同步追加会把已有段落再写一遍，
      // 造成重复）。连续失配时提示用户放慢，滚动恢复对齐后会自动续接
      desyncFrames++;
      updateStatus();
      return;
    }
    desyncFrames = 0;
    if (newRows <= 0) {
      // 探针贴着帧底 = 完美对齐但没有新内容
      idleFrames++;
      // 自动模式下连续多帧无新内容 = 到底：通知主进程停止注入（只发一次）
      if (mode === 'auto' && !bottomNotified && idleFrames >= AUTO_BOTTOM_IDLE_FRAMES) {
        bottomNotified = true;
        autoStoppedByBottom = true;
        void window.api.scroll.action({ kind: 'bottom' }).catch(() => {});
      }
      updateStatus();
      return;
    }
    idleFrames = 0;
    bottomNotified = false;
    appendStrip(strip, appendStart, newRows);
    resumeAutoIfNeeded();
    updateStatus();
  });

  /** 到底停注后再次出现新内容 → 自动恢复注入（懒加载长页会先误判到底） */
  function resumeAutoIfNeeded(): void {
    if (mode !== 'auto' || !autoStoppedByBottom) return;
    autoStoppedByBottom = false;
    void window.api.scroll.action({ kind: 'auto' }).catch(() => {});
  }

  async function finish(kind: 'copy' | 'save' | 'edit'): Promise<void> {
    if (!acc || acc.height === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = acc.width;
    canvas.height = acc.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    // subarray 零拷贝视图：几万行长图 slice 一份就是 100MB+ 级分配，
    // putImageData 只读不持有，视图即可
    const bytes = acc.data.subarray(0, acc.width * acc.height * 4);
    ctx.putImageData(new ImageData(bytes, acc.width, acc.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
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

  // ---- 小地图快照推送：内容或视口动了才推（600ms 节流）。快照无状态，
  // 小地图窗口晚加载丢早包无影响；invoke 被掐断（导出中窗口销毁）忽略即可
  const pushMinimap = async (): Promise<void> => {
    if (!mini) return;
    const rows = mini.height + (mini.count > 0 ? 1 : 0);
    if (rows === 0) return;
    const snapshot = new Uint8ClampedArray(rows * MINI_WIDTH * 4);
    snapshot.set(mini.data.subarray(0, mini.height * MINI_WIDTH * 4));
    if (mini.count > 0) {
      // 未满一行的部分就地归一化成最后一行（不影响缓冲继续累计）
      const row = mini.height * MINI_WIDTH * 4;
      const n = Math.max(1, mini.count);
      for (let c = 0; c < MINI_WIDTH; c++) {
        snapshot[row + c * 4] = mini.sum[c * 3] / n;
        snapshot[row + c * 4 + 1] = mini.sum[c * 3 + 1] / n;
        snapshot[row + c * 4 + 2] = mini.sum[c * 3 + 2] / n;
        snapshot[row + c * 4 + 3] = 255;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = MINI_WIDTH;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(snapshot, MINI_WIDTH, rows), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const png = new Uint8Array(await blob.arrayBuffer());
    // 视口框折算成缩略图像素行号（payload 契约见 ScrollMinimapPayload）
    await window.api.scroll.minimap({
      png,
      viewTop: Math.max(0, Math.round(viewTop * mini.k)),
      viewHeight: Math.max(1, Math.round(viewHeight * mini.k)),
    });
  };

  let pushedRows = -1;
  let pushedViewTop = -1;
  let pushing = false;
  setInterval(() => {
    if (!mini || pushing) return;
    const rows = mini.height + (mini.count > 0 ? 1 : 0);
    if (rows === pushedRows && viewTop === pushedViewTop) return;
    pushedRows = rows;
    pushedViewTop = viewTop;
    pushing = true;
    void pushMinimap()
      .catch(() => {})
      .finally(() => {
        pushing = false;
      });
  }, MINIMAP_PUSH_MS);
}

// ============================================================== 小地图窗口

/**
 * 小地图角色（scroll.html#minimap）：贴在选区旁的竖向缩略窗，只画控制条
 * 转发来的快照 —— 缩略图 + 当前视口框。窗口整窗点击穿透且 focusable:false
 * （见 scroll-capture.ts），这里没有任何交互要处理。
 */
function startMinimap(): void {
  // 控制条那套 UI 在本窗口没有意义：整块藏掉
  document.querySelector('.bar')?.setAttribute('hidden', '');
  const panel = document.getElementById('minimap') as HTMLDivElement;
  panel.hidden = false;
  const canvas = document.getElementById('minimap-canvas') as HTMLCanvasElement;
  const emptyEl = document.getElementById('minimap-empty') as HTMLSpanElement;
  const ctx = canvas.getContext('2d');

  let bmp: ImageBitmap | null = null;
  let boxTop = 0;
  let boxHeight = 0;

  const paint = (): void => {
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!bmp || bmp.height === 0) return;
    // 等比 fit 进画布（留 6px 内边距），顶对齐 —— 内容从上往下长
    const pad = 6 * dpr;
    const scale = Math.min((canvas.width - pad * 2) / bmp.width, (canvas.height - pad * 2) / bmp.height);
    const tw = bmp.width * scale;
    const th = bmp.height * scale;
    const ox = (canvas.width - tw) / 2;
    const oy = pad;
    ctx.drawImage(bmp, ox, oy, tw, th);
    // 视口框：viewTop/viewHeight 是缩略图像素行号（png 覆盖累积缓冲全高），
    // 对 png 高度线性映射即可；超出缩略图范围的部分夹回来
    const vy = oy + (boxTop / bmp.height) * th;
    const vh = Math.max(3 * dpr, (boxHeight / bmp.height) * th);
    const y0 = Math.max(oy, vy);
    const y1 = Math.min(oy + th, vy + vh);
    if (y1 <= y0) return;
    ctx.fillStyle = 'rgba(47, 111, 237, 0.2)';
    ctx.fillRect(ox, y0, tw, y1 - y0);
    ctx.strokeStyle = '#2f6fed';
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(ox, y0, tw, y1 - y0);
  };

  const syncCanvas = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const bh = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === bw && canvas.height === bh) return;
    canvas.width = bw;
    canvas.height = bh;
    paint();
  };

  window.addEventListener('resize', syncCanvas);
  syncCanvas();

  window.api.scroll.minimapData((payload) => {
    boxTop = payload.viewTop;
    boxHeight = payload.viewHeight;
    // IPC 过来的是 ArrayBufferLike，toClamped 复制一份可转移的（record 同款）
    void createImageBitmap(new Blob([toClamped(payload.png)], { type: 'image/png' }))
      .then((next) => {
        if (bmp) bmp.close();
        bmp = next;
        emptyEl.hidden = true;
        syncCanvas();
        paint();
      })
      .catch(() => {});
  });

  console.log('[scroll-minimap] 小地图就绪');
}

if (ROLE === 'bar') startBar();
else startMinimap();
