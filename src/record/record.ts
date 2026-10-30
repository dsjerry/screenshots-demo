import { createToolbar } from '../annotations/toolbar';
import type { ToolbarAction } from '../annotations/toolbar';
import { Editor } from '../annotations/editor';
import { drawShape } from '../annotations/shapes';
import { toClamped } from '../shared/bytes';
import { encodeGif } from '../shared/gif';
import { dedupeFrames, quantize } from './quantize';
import type {
  Point,
  RecordFormat,
  RecordFramePayload,
  RecordInkInputPayload,
  RecordPhase,
  RecordStatusPayload,
  Shape,
  ToolId,
} from '../shared/types';
import './record.css';

/**
 * 录制控制条（`#bar`）、标注层（`#ink`）与标注工具条（`#toolbar`）——
 * **同一个 renderer 入口的三个角色**。
 *
 * 角色由 URL hash 决定（见 `record-capture.ts` 的 `loadRecordPage`）：
 * - `bar`：录制期间唯一常驻可交互的自家窗口 —— 计时、暂停 / 停止 / 取消、
 *   标注开关与导出面板；
 * - `ink`：与录制区域同形的透明覆盖层，平时整窗鼠标穿透，只把标注画在画面
 *   之上（不会被录进帧 —— 独立窗口且开了内容保护）；绘制输入见下；
 * - `toolbar`：标注工具条，贴在控制条上方的独立小窗（控制条只有一条的高度，
 *   两行工具条塞不下）。只负责改笔刷和发撤销 / 清空命令 —— 真正的编辑器
 *   状态在标注层，这里全是遥控。
 *
 * 绘制输入按平台分两路（主进程 `onRecordInk` 决定）：
 * - Windows：覆盖层保持穿透，主进程轮询全局光标 + 按键状态，合成
 *   pointer 事件喂给标注层（`recorder:inkInput`）—— 边操作边标注；
 * - macOS / Linux：没有公开的全局按键查询，改为模态 —— 标注模式开启时
 *   覆盖层收真实指针事件（窗口不抢键盘焦点），「完成」后恢复穿透。
 *
 * 两个窗口都开了 `setContentProtection`，因此**不会**出现在自己的录像里 ——
 * 这也是控件能与录制区域重叠的前提。
 *
 * 编码队列：主进程按固定帧率推 RGBA 帧，这里按到达顺序收着。首版产物是
 * PNG 序列（屏幕帧 + 当时生效的标注）；GIF / MP4 编码器接上后只需替换 `encode()`。
 */

const ROLE: 'bar' | 'ink' | 'toolbar' =
  location.hash === '#ink' ? 'ink' : location.hash === '#toolbar' ? 'toolbar' : 'bar';

/** 一帧录制画面（原始 RGBA，尺寸恒定） */
interface Frame {
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
  /** 抓帧时刻（相对录制起点毫秒，主进程时钟；暂停期间冻结） */
  at: number;
}

/** 待编码队列。掉帧好过无限堆积把内存吃光（1080p 一帧约 8MB）。 */
const queue: Frame[] = [];
const MAX_QUEUED = 600;
let dropped = 0;

let phase: RecordPhase = 'recording';
let elapsed = 0;
let status: RecordStatusPayload | null = null;

function fmt(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

if (ROLE === 'ink') startInkLayer();
else if (ROLE === 'toolbar') startToolbarWindow();
else startBar();

// ============================================================== 标注层窗口

/**
 * 标注层：一张透明画布 + 真正的标注引擎（与遮罩同一份 `Editor`）。
 *
 * Windows：本窗口整窗穿透、拿不到 `pointerdown` —— 压笔 / 移动 / 抬笔由主进程
 * 轮询全局光标驱动（合成的 pointer 事件）；macOS：标注模式开启时主进程把窗口
 * 切成收指针，真实 pointer 事件直达画布（画布的 `pointer-events` 由
 * `recorder:inkActive` 切换）。工具与属性由工具条窗口经 `recorder:brush` 下发。
 */
function startInkLayer(): void {
  // 控制条那套 UI 在本窗口没有意义：整块藏掉
  document.querySelector('.bar')?.setAttribute('hidden', '');
  document.querySelector('.result')?.setAttribute('hidden', '');
  const canvas = document.getElementById('ink') as HTMLCanvasElement;
  canvas.hidden = false;
  const textEditor = document.getElementById('text-editor') as HTMLTextAreaElement;
  const ctx = canvas.getContext('2d');

  let editor: Editor | null = null;
  let drawing = false;
  let lastPoint: Point = { x: 0, y: 0 };

  const paint = (): void => {
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);
    editor?.renderInto(ctx);
  };

  const syncCanvas = (): void => {
    if (!status) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(status.region.width));
    const h = Math.max(1, Math.round(status.region.height));
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width === bw && canvas.height === bh) return;
    canvas.width = bw;
    canvas.height = bh;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    paint();
  };

  window.api.recorder.status((payload) => {
    status = payload;
    phase = payload.phase;
    syncCanvas();
  });

  const pointerEvent = (point: Point, buttons: number): PointerEvent =>
    new PointerEvent('pointermove', {
      clientX: point.x,
      clientY: point.y,
      buttons,
      button: buttons ? 0 : -1,
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });

  const downEvent = (point: Point): PointerEvent =>
    new PointerEvent('pointerdown', {
      clientX: point.x,
      clientY: point.y,
      buttons: 1,
      button: 0,
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });

  const upEvent = (point: Point): PointerEvent =>
    new PointerEvent('pointerup', {
      clientX: point.x,
      clientY: point.y,
      buttons: 0,
      button: 0,
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });

  const makeEditor = (): Editor => {
    const instance = new Editor(canvas, textEditor, {
      repaint: paint,
      // 本窗口 CSS px ≡ 录制区域 DIP，与遮罩的 'css' 档一致
      coords: 'css',
      onTextEdit: () => {},
    });
    // 每次历史变化把整份快照回传主进程：导出时按时间轴把标注合进帧
    instance.onHistoryChange = () => {
      void window.api.recorder.shapes({ shapes: instance.getShapes() });
    };
    return instance;
  };

  window.api.recorder.inkInput((payload: RecordInkInputPayload) => {
    const { point, kind } = payload;
    lastPoint = point;
    if (kind === 'down') {
      editor ??= makeEditor();
      drawing = true;
      canvas.dispatchEvent(downEvent(point));
      return;
    }
    if (kind === 'move') {
      if (!drawing) return;
      canvas.dispatchEvent(pointerEvent(point, 1));
      paint();
      return;
    }
    if (kind === 'up') {
      if (!drawing) return;
      canvas.dispatchEvent(upEvent(point));
      drawing = false;
      paint();
    }
  });

  // 指针接管开关的主进程回执：mac 路径据此让画布吃得到真实点击
  window.api.recorder.inkActive(({ active }) => {
    canvas.style.pointerEvents = active ? 'auto' : 'none';
    if (!active && drawing) {
      // 模式被关掉时一笔还没画完：就地抬笔，别把草稿悬着
      canvas.dispatchEvent(upEvent(lastPoint));
      drawing = false;
      paint();
    }
  });

  // 工具 / 属性 / 历史命令由工具条窗口下发
  window.api.recorder.brush((payload) => {
    editor ??= makeEditor();
    const instance = editor;
    if (payload.cmd) {
      // 遥控：撤销 / 重做 / 清空 / 删除选中（工具条窗口的按钮与快捷键都汇到这里）
      if (payload.cmd === 'undo') instance.undo();
      else if (payload.cmd === 'redo') instance.redo();
      else if (payload.cmd === 'clear') instance.clear();
      else instance.deleteSelected();
      return;
    }
    // 值没变就别调：setTool 会清草稿与选中，每次广播都调会把正在画的笔画清掉
    if (payload.tool && instance.currentTool !== payload.tool) instance.setTool(payload.tool);
    if (payload.color && instance.colorValue !== payload.color) instance.setColor(payload.color);
    if (payload.width && instance.widthValue !== payload.width) instance.setWidth(payload.width);
    if (payload.arrowHead && instance.arrowHeadValue !== payload.arrowHead) instance.setArrowHead(payload.arrowHead);
    if (payload.fontSize && instance.fontSizeValue !== payload.fontSize) instance.setFontSize(payload.fontSize);
    if (payload.mosaicMode && instance.mosaicModeValue !== payload.mosaicMode)
      instance.setMosaicMode(payload.mosaicMode);
  });

  console.log('[record-ink] 标注层就绪');
}

// ============================================================== 控制条窗口

/**
 * 控制条：计时 + 动作 + 标注工具条 + 导出面板。
 *
 * 编码（首版是 PNG 序列）在这里做 —— 主进程是所有窗口的事件循环所在，
 * 一帧 PNG 编码卡在那里会让遮罩、托盘、录制一起停顿。
 */
function startBar(): void {
  const timeEl = document.getElementById('time') as HTMLSpanElement;
  const hintEl = document.getElementById('hint') as HTMLSpanElement;
  const statusEl = document.querySelector('.status') as HTMLDivElement;
  const pauseBtn = document.getElementById('pause') as HTMLButtonElement;
  const zoomBtn = document.getElementById('zoom') as HTMLButtonElement;
  const stopBtn = document.getElementById('stop') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;

  const resultEl = document.getElementById('result') as HTMLDivElement;
  const resultTitleEl = document.getElementById('result-title') as HTMLSpanElement;
  const resultInfoEl = document.getElementById('result-info') as HTMLSpanElement;
  const formatSelect = document.getElementById('format') as HTMLSelectElement;
  const copyBtn = document.getElementById('copy') as HTMLButtonElement;
  const saveBtn = document.getElementById('save') as HTMLButtonElement;
  const closeBtn = document.getElementById('close') as HTMLButtonElement;

  // ---------------------------------------------------------------- 状态

  const renderStatus = (): void => {
    timeEl.textContent = fmt(elapsed);
    statusEl.classList.toggle('is-recording', phase === 'recording');
    const size = status ? `${status.width}×${status.height}` : '';
    hintEl.textContent =
      phase === 'paused'
        ? '已暂停'
        : phase === 'stopped'
          ? '录制已停止'
          : `${size} · ${status?.frames ?? 0} 帧${dropped > 0 ? ` · 丢 ${dropped}` : ''}`;
    pauseBtn.textContent = phase === 'paused' ? '继续' : '暂停';
    pauseBtn.classList.toggle('is-on', phase === 'paused');
    pauseBtn.disabled = phase === 'stopped';
    stopBtn.disabled = phase === 'stopped';
  };

  window.api.recorder.status((payload) => {
    status = payload;
    phase = payload.phase;
    elapsed = payload.elapsed;
    renderStatus();
    if (payload.phase === 'stopped') showResult();
  });

  // ---------------------------------------------------------------- 收帧

  window.api.recorder.frame((payload: RecordFramePayload) => {
    if (phase !== 'recording') return;
    queue.push({
      // ImageData 要求可转移的 ArrayBuffer（IPC 过来是 ArrayBufferLike），复制一份最稳
      pixels: toClamped(payload.pixels),
      width: payload.width,
      height: payload.height,
      at: payload.at,
    });
    if (queue.length > MAX_QUEUED) {
      queue.shift();
      dropped += 1;
    }
  });

  // ---------------------------------------------------------------- 动作

  const act = async (payload: { kind: 'pause' | 'resume' | 'stop' | 'cancel' }): Promise<void> => {
    const res = await window.api.recorder.action(payload);
    if (!res.ok && res.error) hintEl.textContent = res.error;
  };

  pauseBtn.addEventListener('click', () => void act({ kind: phase === 'paused' ? 'resume' : 'pause' }));
  stopBtn.addEventListener('click', () => void act({ kind: 'stop' }));
  cancelBtn.addEventListener('click', () => void act({ kind: 'cancel' }));

  window.addEventListener('keydown', (event) => {
    // 文字输入框在打字时不吃快捷键（与遮罩工具条同一规则）
    if (event.target instanceof HTMLTextAreaElement) return;
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      // 标注模式开着时 Esc 只退出标注，别把整段录制一起带走
      if (inking) {
        void setInking(false);
        return;
      }
      void act({ kind: 'cancel' });
      return;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      pauseBtn.click();
      return;
    }
    if (mod && event.key === 'Enter') {
      event.preventDefault();
      if (phase !== 'stopped') stopBtn.click();
    }
  });

  // -------------------------------------------------------------- 实时标注

  /** 标注模式开关。工具条本体在另一个窗口（`#toolbar` 角色），这里只是开关。 */
  let inking = false;

  const setInking = async (next: boolean): Promise<void> => {
    inking = next;
    zoomBtn.classList.toggle('is-on', inking);
    await window.api.recorder.ink(next);
  };

  // 工具条窗口的「完成」也会关标注：主进程回发开关状态，这里跟着收敛
  window.api.recorder.inkActive(({ active }) => {
    inking = active;
    zoomBtn.classList.toggle('is-on', active);
  });

  zoomBtn.addEventListener('click', () => void setInking(!inking));

  // ------------------------------------------------------------------ 导出

  const showResult = (): void => {
    resultEl.hidden = false;
    resultTitleEl.textContent = '录制完成';
    resultInfoEl.textContent = `${status?.width ?? 0}×${status?.height ?? 0} · ${queue.length} 帧 · ${fmt(elapsed)}`;
    if (inking) void setInking(false);
  };

  /**
   * 一帧 RGBA 画进离屏画布，叠上**当时生效**的标注。
   *
   * 标注坐标是录制区域 DIP（与标注层同一空间），帧是物理像素 —— 按宽度比值
   * 缩放 ctx 后再画，retina 屏上才不会缩成一角。
   */
  const frameCanvas = (frame: Frame, shapes: Shape[], scale: number): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0);
      ctx.scale(scale, scale);
      for (const shape of shapes) drawShape(ctx, shape);
    }
    return canvas;
  };

  const canvasToPng = async (canvas: HTMLCanvasElement): Promise<Uint8Array> => {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('导出 PNG 失败');
    return new Uint8Array(await blob.arrayBuffer());
  };

  /**
   * 首版编码：每帧逐张编成 PNG 交给主进程落盘。
   *
   * 不是最终产物形态 —— GIF / MP4 编码器接上后替换这里。保留这条路径一是
   * 立刻能验证「帧序列 + 标注时间轴」整条链路，二是编码器在某平台不可用
   * 时它就是兜底（无损、零编码器依赖）。
   */
  const encode = async (): Promise<Uint8Array[]> => {
    if (queue.length === 0) throw new Error('没有采集到任何帧');
    const timeline = await window.api.recorder.timeline();
    if (!timeline) throw new Error('录制会话已结束，无法导出');
    // 标注快照按帧时刻取「已生效的最新一份」：第 5 秒画的箭头不该出现在前 5 秒
    const snapshots = timeline.snapshots;
    const scale = timeline.region.width > 0 ? queue[0].width / timeline.region.width : 1;
    const files: Uint8Array[] = [];
    let si = -1; // 当前帧之前最新快照的下标（-1 = 该帧时刻还没有任何标注）
    for (const frame of queue) {
      while (si + 1 < snapshots.length && snapshots[si + 1].at <= frame.at) si += 1;
      const shapes = si >= 0 ? snapshots[si].shapes : [];
      files.push(await canvasToPng(frameCanvas(frame, shapes, scale)));
      // 编码是 CPU 活，让出一拍，别把控制条的计时显示整个卡死
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return files;
  };

  /**
   * 把队列里的帧编成 GIF。
   *
   * 三步：① 每帧叠上「那一刻已生效的标注」画进画布 → ② 全片共用一套调色板
   * 量化（`quantize.ts`）→ ③ 合并连续相同帧再交给 `encodeGif`。
   *
   * 中间要 yield 给事件循环：量化 + 编码是纯 CPU 活，一口气跑会把控制条
   * （含计时显示与「正在导出」提示）冻住，看起来像卡死。
   */
  const encodeGifBytes = async (): Promise<Uint8Array> => {
    if (queue.length === 0) throw new Error('没有采集到任何帧');
    const timeline = await window.api.recorder.timeline();
    if (!timeline) throw new Error('录制会话已结束，无法导出');
    const snapshots = timeline.snapshots;
    const scale = timeline.region.width > 0 ? queue[0].width / timeline.region.width : 1;

    // ① 逐帧渲染成 RGBA（含当时的标注）
    const width = queue[0].width;
    const height = queue[0].height;
    const pixels: Uint8ClampedArray<ArrayBuffer>[] = [];
    const intervals: number[] = [];
    let si = -1;
    for (let i = 0; i < queue.length; i++) {
      const frame = queue[i];
      while (si + 1 < snapshots.length && snapshots[si + 1].at <= frame.at) si += 1;
      const shapes = si >= 0 ? snapshots[si].shapes : [];
      const canvas = frameCanvas(frame, shapes, scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('无法读取画布像素');
      pixels.push(toClamped(new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)));
      // 帧间隔取「下一帧时刻 - 本帧时刻」，最后一帧沿用一个平均间隔
      const next = queue[i + 1];
      intervals.push(next ? Math.max(10, next.at - frame.at) : 100);
      if (i % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    hintEl.textContent = '正在量化颜色…';
    await new Promise((resolve) => setTimeout(resolve, 0));
    const quantized = quantize(pixels, width, height, 256);
    const merged = dedupeFrames(quantized.frames, intervals);

    hintEl.textContent = `正在编码 GIF（${merged.length} 帧）…`;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const gif = encodeGif(width, height, { size: quantized.size, rgb: quantized.rgb }, merged);
    return new Uint8Array(gif.buffer, gif.byteOffset, gif.byteLength);
  };

  let exporting = false;

  const exportRecording = async (kind: 'copy' | 'save'): Promise<void> => {
    if (exporting) return;
    exporting = true;
    hintEl.textContent = kind === 'copy' ? '正在导出…' : '正在保存…';
    copyBtn.disabled = true;
    saveBtn.disabled = true;
    try {
      const format = formatSelect.value as RecordFormat;
      const res =
        format === 'gif'
          ? await window.api.recorder.export({ kind, format, data: await encodeGifBytes() })
          : await window.api.recorder.export({ kind, format: 'png-sequence', files: await encode() });
      if (res.canceled) {
        // 用户自己取消了保存对话框：不是错误，别用红字式的口吻
        resultInfoEl.textContent = '已取消，录像仍保留在内存里';
      } else if (!res.ok) {
        throw new Error(res.error ?? '导出失败');
      } else if (format === 'png-sequence' && kind === 'copy') {
        // 多文件没有单张图像形态：退化为「保存 + 复制路径」，如实告诉用户
        resultInfoEl.textContent = `帧序列已保存并复制路径：${res.path ?? ''}`;
      } else {
        resultInfoEl.textContent = `${kind === 'copy' ? '已复制' : '已保存'}：${res.path ?? ''}`;
      }
    } catch (err) {
      resultInfoEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      exporting = false;
      copyBtn.disabled = false;
      saveBtn.disabled = false;
    }
  };

  copyBtn.addEventListener('click', () => void exportRecording('copy'));
  saveBtn.addEventListener('click', () => void exportRecording('save'));
  closeBtn.addEventListener('click', () => void act({ kind: 'cancel' }));

  formatSelect.addEventListener('change', () => {
    const value = formatSelect.value as RecordFormat;
    // MP4 编码器尚未接入：置灰选项在 HTML 里，这里只兜底提示
    if (value === 'mp4') hintEl.textContent = 'MP4 编码器尚未接入，本次改为导出 GIF';
    void window.api.recorder.format({ format: value });
  });

  renderStatus();
}

// ============================================================ 工具条窗口

/** 录制标注能用的工具：剔除 hand / text / mosaic（原因见 toolbar.ts 的 tools 注释） */
const RECORD_TOOLS: ToolId[] = ['arrow', 'line', 'rect', 'ellipse', 'pen', 'marker', 'counter'];

/**
 * 标注工具条窗口：贴在控制条上方的独立小窗，只有标注模式开启时可见。
 *
 * 编辑器状态（标注 / 历史）全在标注层窗口里，这里是一块**遥控器**：
 * - 工具 / 颜色 / 线宽等属性变化 → `recorder:brushSet` 整份下发给标注层；
 * - 撤销 / 重做 / 清空 / 删除（按钮和快捷键）→ 覆盖掉本窗口 1×1 假编辑器的
 *   对应方法，换成发同一条命令 —— 假编辑器只是让工具条有地方挂。
 */
function startToolbarWindow(): void {
  // 控制条那套 UI 在本窗口没有意义：整块藏掉，只留工具条
  document.querySelector('.bar')?.setAttribute('hidden', '');
  document.querySelector('.result')?.setAttribute('hidden', '');
  const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
  toolbarEl.hidden = false;

  // 工具条需要一个编辑器实例；这块画布不画东西（真正的绘制在标注层）
  const scratch = document.createElement('canvas');
  scratch.width = 1;
  scratch.height = 1;
  const textEditor = document.createElement('textarea');
  const brush = new Editor(scratch, textEditor, { repaint: () => {}, coords: 'css' });

  const confirmAction: ToolbarAction = {
    id: 'confirm',
    label: '完成',
    primary: true,
    // 关标注走同一条 record:ink：主进程收工具条、恢复穿透，控制条跟着收敛高亮
    run: () => void window.api.recorder.ink(false),
  };

  const handles = createToolbar(toolbarEl, brush, { actions: [confirmAction], tools: RECORD_TOOLS });
  // 假编辑器没有历史，同步上来的按钮会一直禁用 —— 改成由标注层实际执行
  handles.undo.disabled = false;
  handles.redo.disabled = false;
  brush.undo = () => void window.api.recorder.brushSet({ cmd: 'undo' });
  brush.redo = () => void window.api.recorder.brushSet({ cmd: 'redo' });
  brush.clear = () => void window.api.recorder.brushSet({ cmd: 'clear' });
  brush.deleteSelected = () => void window.api.recorder.brushSet({ cmd: 'delete' });

  const pushBrush = (): void => {
    void window.api.recorder.brushSet({
      tool: brush.currentTool,
      color: brush.colorValue,
      width: brush.widthValue,
      arrowHead: brush.arrowHeadValue,
      fontSize: brush.fontSizeValue,
      mosaicMode: brush.mosaicModeValue,
    });
  };
  const prevTool = brush.onToolChange;
  brush.onToolChange = (tool) => {
    prevTool?.(tool);
    pushBrush();
  };
  brush.onAttrsChange = pushBrush;

  // 默认手型在录制里没有意义（无窗口可拖），落成画笔，一并把初值推给标注层
  brush.setTool('pen');
}
