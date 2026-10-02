import {
  applyShapeHandle,
  cloneShape,
  drawDraftPath,
  drawDraftRect,
  drawSelection,
  drawShape,
  isShapeHit,
  measureTextBlock,
  shapeHandlePoints,
  translateShape,
  withColor,
} from './shapes';
import type { ShapeHandle } from './shapes';
import { HANDLE_CURSOR, HANDLE_HIT_DIP } from '../shared/selection';
import type { HandleId } from '../shared/selection';
import type { ArrowHead, MosaicMode, Point, Shape, ToolId } from '../shared/types';

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#2f6fed', '#af52de', '#ffffff', '#000000'];
/** 线宽用滑动条连续调节（替代原 2/4/6/10 预设档位） */
const WIDTH_MIN = 1;
const WIDTH_MAX = 20;
const ARROW_HEADS: ArrowHead[] = ['solid', 'open'];
/** 文字字号独立于线宽 —— 线宽对文字没有意义 */
const FONT_SIZES = [16, 24, 32, 48];
const MOSAIC_MODES: MosaicMode[] = ['region', 'brush'];

/** 宿主注入的钩子 —— 目前只有截图遮罩在用（钉图钉住后是只读贴图）。 */
export interface EditorOptions {
  /**
   * 重绘入口（**必填**）：编辑器只管标注层，底图 / 遮罩 / 选框由宿主画。
   * 遮罩传自己的 `paint()`。
   */
  repaint: () => void;
  /**
   * 手型工具按下的接管钩子，返回 true 表示宿主处理了（不再拖窗口）。
   * 遮罩用它转去调整选区：手型 = 调整选区，绘图工具 = 画标注。
   */
  onHandDown?: (event: PointerEvent) => boolean;
  /**
   * 坐标换算空间：
   * - `css`（遮罩在用）= CSS px ≡ 本屏 DIP —— 它的 ctx 按 dpr 缩放过，画的就是 DIP；
   * - `backing` = 画布 backing 像素，留给「画布 = 图像像素」的宿主
   *   （钉图若哪天重新支持编辑，就是这一档）。
   */
  coords?: 'backing' | 'css';
  /**
   * 文字输入框开合。遮罩要转告主进程 —— 打字时 Enter / Esc 归渲染进程，
   * 主进程的 before-input-event 别把「提交文字」吃成「确认截图」。
   */
  onTextEdit?: (open: boolean) => void;
}

/** 指针当前在做什么；null = 空闲。 */
type PointerMode = 'draw' | 'move' | 'handle';

/**
 * 标注编辑器（`src/annotations/`）—— 截图遮罩用它在原图上标注；
 * **钉图钉住之后是只读贴图**，不再用这个类（标注在钉住前就画完、烘进画布）。
 *
 * 坐标空间由宿主通过 `coords` 决定，遮罩是 **本屏 DIP**（本窗口 CSS px ≡ 本屏 DIP），
 * 确认 / 导出时由主进程按 `outScale` 与各屏原点换算成图像像素。
 */
export class Editor {
  readonly canvas: HTMLCanvasElement;
  readonly toolIds: ToolId[] = [
    'hand',
    'arrow',
    'line',
    'rect',
    'ellipse',
    'pen',
    'marker',
    'mosaic',
    'counter',
    'text',
  ];

  private readonly ctx: CanvasRenderingContext2D;
  private readonly textEditor: HTMLTextAreaElement;
  private readonly opts: EditorOptions;

  /** 已提交的标注（源数据，唯一真相） */
  private shapes: Shape[] = [];
  /** 撤销栈 / 重做栈：存整份快照。加、删、清空、改色、移动共用一套历史，
   *  不用为每种操作各写一遍反向命令。 */
  private past: Shape[][] = [];
  private future: Shape[][] = [];

  private draft: Shape | null = null;
  private selected: Shape | null = null;
  /** 正在拖动的图形副本；落盘前 `shapes` 里仍是原对象 */
  private editing: Shape | null = null;
  private editingOf: Shape | null = null;
  private editOrigin: Shape | null = null;
  private editStart: Point | null = null;
  private editHandle: ShapeHandle | null = null;

  private current: ToolId = 'hand';
  private color = COLORS[0];
  private width = 4;
  private arrowHead: ArrowHead = 'solid';
  private fontSize = FONT_SIZES[0];
  private mosaicMode: MosaicMode = 'region';

  private penPoints: Point[] = [];
  private mode: PointerMode | null = null;
  /** 图像像素 / 屏幕像素，命中阈值与手柄尺寸按它放大 */
  private pxScale = 1;
  /** 当前活跃的文字输入框提交函数；同时只允许一个 */
  private closeActiveText: (() => void) | null = null;
  /** 已 setPointerCapture 的指针；null = 未捕获 */
  private capturedPointer: number | null = null;

  onToolChange?: (tool: ToolId) => void;
  /** 每次撤销 / 重做 / 新增 / 删除 / 清空 / 改色 / 落盘调整后触发 */
  onHistoryChange?: () => void;
  /**
   * 拖画中的草稿变化（含结束时的 null）。遮罩用它把草稿实时投影到
   * 其余屏 —— 否则标注画过屏幕边界时，另一块屏上永远看不到。
   */
  onDraftChange?: (draft: Shape | null) => void;
  /**
   * 拖动 / 缩放**既有**标注的在途状态：开始时给它在已提交列表里的下标，
   * 结束时给 null。宿主据此先广播「去掉它」的快照、再把拖动副本当草稿
   * 投影 —— 否则其余屏在拖动期间会旧位、新位叠着画两份。
   */
  onInFlightChange?: (index: number | null) => void;

  constructor(canvas: HTMLCanvasElement, textEditor: HTMLTextAreaElement, opts: EditorOptions) {
    this.canvas = canvas;
    this.textEditor = textEditor;
    this.opts = opts;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 2d 上下文');
    this.ctx = ctx;
    this.attach();
  }

  /** 当前已提交标注的快照（深拷贝），遮罩每次历史变化回传给主进程用。 */
  getShapes(): Shape[] {
    return this.snapshot();
  }

  /** 直接把标注层画进宿主的画布（遮罩用：它自己负责底图 / 遮罩 / 选框）。 */
  renderInto(ctx: CanvasRenderingContext2D): void {
    for (const shape of this.shapes) {
      // 正在拖的那条用副本画，原对象留在 shapes 里直到松手才替换
      if (shape === this.editingOf) continue;
      drawShape(ctx, shape);
    }
    if (this.editing) drawShape(ctx, this.editing);
    if (this.draft) {
      if (this.draft.type === 'mosaic') {
        if (this.draft.mode === 'brush') {
          drawDraftPath(ctx, this.draft.points, this.draft.radius);
        } else {
          // 选区 / 高斯模糊：半透明矩形预览
          drawDraftRect(ctx, this.draft.x, this.draft.y, this.draft.w, this.draft.h);
        }
      } else if (this.draft.type !== 'text') {
        // 文字在输入框里实时可见，画布上先不画
        drawShape(ctx, this.draft);
      }
    }
    const focus = this.editing ?? this.selected;
    if (focus) drawSelection(ctx, focus, HANDLE_SIZE_UNIT * this.pxScale);
  }

  get currentTool(): ToolId {
    return this.current;
  }

  get colorValue(): string {
    return this.color;
  }

  get widthValue(): number {
    return this.width;
  }

  get arrowHeads(): ArrowHead[] {
    return ARROW_HEADS;
  }

  get arrowHeadValue(): ArrowHead {
    return this.arrowHead;
  }

  get fontSizes(): number[] {
    return FONT_SIZES;
  }

  get fontSizeValue(): number {
    return this.fontSize;
  }

  get mosaicModes(): MosaicMode[] {
    return MOSAIC_MODES;
  }

  get mosaicModeValue(): MosaicMode {
    return this.mosaicMode;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get hasSelection(): boolean {
    return this.selected !== null;
  }

  // ------------------------------------------------------------ 历史

  private snapshot(): Shape[] {
    return this.shapes.map(cloneShape);
  }

  /** **变更之前**调用：把当前状态压进撤销栈并清空重做栈。 */
  private beginChange(): void {
    this.past.push(this.snapshot());
    this.future = [];
  }

  private commit(shape: Shape): void {
    this.beginChange();
    this.shapes.push(shape);
    this.onHistoryChange?.();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.snapshot());
    this.shapes = prev;
    // 快照是新对象，旧的选中引用已经对不上了
    this.selected = null;
    this.onHistoryChange?.();
    this.render();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot());
    this.shapes = next;
    this.selected = null;
    this.onHistoryChange?.();
    this.render();
  }

  /** 清空也走历史：Ctrl+Z 一次性全拿回来 */
  clear(): void {
    if (this.shapes.length === 0) return;
    this.beginChange();
    this.shapes = [];
    this.selected = null;
    if (this.draft) this.onDraftChange?.(null);
    this.draft = null;
    this.penPoints = [];
    this.onHistoryChange?.();
    this.render();
  }

  /** 删除当前选中的那条标注（可撤销）。 */
  deleteSelected(): void {
    const target = this.selected;
    if (!target) return;
    this.beginChange();
    this.shapes = this.shapes.filter((s) => s !== target);
    this.selected = null;
    this.onHistoryChange?.();
    this.render();
    console.log(`[editor] 删除标注 剩余=${this.shapes.length}`);
  }

  // ------------------------------------------------------------ 选中

  private select(shape: Shape | null): void {
    if (this.selected === shape) return;
    this.selected = shape;
    this.render();
  }

  private hitTolerance(): number {
    return Math.max(6, HANDLE_HIT_DIP * 0.75 * this.pxScale);
  }

  /** 从最上层往下找光标落在哪条标注上。 */
  private hitTest(p: Point): Shape | null {
    const tol = this.hitTolerance();
    for (let i = this.shapes.length - 1; i >= 0; i--) {
      const shape = this.shapes[i];
      if (shape === this.editingOf) continue;
      if (isShapeHit(this.canvas, shape, p, tol)) return shape;
    }
    return null;
  }

  private hitSelectedHandle(p: Point): ShapeHandle | null {
    const target = this.editing ?? this.selected;
    if (!target) return null;
    const tol = HANDLE_HIT_DIP * this.pxScale;
    for (const h of shapeHandlePoints(target, this.ctx)) {
      if (Math.hypot(h.x - p.x, h.y - p.y) <= tol) return h.id;
    }
    return null;
  }

  // ------------------------------------------------------------ 坐标

  private toImage(event: { clientX: number; clientY: number }): Point {
    const rect = this.canvas.getBoundingClientRect();
    // 'css'：本窗口 CSS px ≡ 本屏 DIP，不做换算（ctx 已按 dpr 缩放过）
    const sx = this.opts.coords === 'css' || rect.width <= 0 ? 1 : this.canvas.width / rect.width;
    const sy = this.opts.coords === 'css' || rect.height <= 0 ? 1 : this.canvas.height / rect.height;
    this.pxScale = sx;
    return {
      x: (event.clientX - rect.left) * sx,
      y: (event.clientY - rect.top) * sy,
    };
  }

  // ------------------------------------------------------------ 渲染

  private lastLog = '';

  render(): void {
    this.opts.repaint();
  }

  // ------------------------------------------------------------ 工具 / 属性

  setTool(tool: ToolId): void {
    this.current = tool;
    this.resetInteraction();
    // 换工具就取消选中：上一条标注的控制点留着只会误导
    this.selected = null;
    this.updateCursor();
    this.onToolChange?.(tool);
    this.render();
  }

  setColor(color: string): void {
    this.color = color;
    // 选中状态下点色块 = 改这条标注的颜色（主流也是这个语义）
    const target = this.selected;
    if (target && target.type !== 'mosaic') {
      const idx = this.shapes.indexOf(target);
      const next = withColor(target, color);
      if (idx >= 0 && next !== target) {
        this.beginChange();
        this.shapes[idx] = next;
        this.selected = next;
        this.onHistoryChange?.();
        console.log(`[editor] 改色 index=${idx} color=${color}`);
      }
    }
    this.render();
  }

  /** 换箭头头部样式；选中箭头时同步改这一条（与 setColor 同语义） */
  setArrowHead(head: ArrowHead): void {
    this.arrowHead = head;
    const target = this.selected;
    if (target && target.type === 'arrow' && target.head !== head) {
      const idx = this.shapes.indexOf(target);
      if (idx >= 0) {
        this.beginChange();
        const next = { ...target, head };
        this.shapes[idx] = next;
        this.selected = next;
        this.onHistoryChange?.();
        console.log(`[editor] 换箭头头部 index=${idx} head=${head}`);
      }
    }
    this.render();
  }

  /** 换字号；选中文字时同步改这一条 */
  setFontSize(size: number): void {
    this.fontSize = size;
    const target = this.selected;
    if (target && target.type === 'text' && target.size !== size) {
      const idx = this.shapes.indexOf(target);
      if (idx >= 0) {
        this.beginChange();
        const next = { ...target, size };
        this.shapes[idx] = next;
        this.selected = next;
        this.onHistoryChange?.();
        console.log(`[editor] 改字号 index=${idx} size=${size}`);
      }
    }
    this.render();
  }

  /** 切换马赛克绘制形式 —— 纯工具设置，不进历史 */
  setMosaicMode(mode: MosaicMode): void {
    if (this.mosaicMode === mode) return;
    this.mosaicMode = mode;
    this.render();
  }

  setWidth(width: number): void {
    this.width = width;
    this.render();
  }

  private updateCursor(): void {
    this.canvas.style.cursor = 'crosshair';
  }

  /** 只针对**已选中**那条：手柄给调整光标、图形本体给移动光标。 */
  private hoverCursor(event: { clientX: number; clientY: number }): void {
    if (!this.selected) {
      this.updateCursor();
      return;
    }
    const p = this.toImage(event);
    const handle = this.hitSelectedHandle(p);
    if (handle) {
      this.canvas.style.cursor = handle === 'p1' || handle === 'p2' ? 'crosshair' : HANDLE_CURSOR[handle as HandleId];
      return;
    }
    if (isShapeHit(this.canvas, this.selected, p, this.hitTolerance())) {
      this.canvas.style.cursor = 'move';
      return;
    }
    this.updateCursor();
  }

  private resetInteraction(): void {
    if (this.draft) this.onDraftChange?.(null);
    this.mode = null;
    this.draft = null;
    this.penPoints = [];
    this.editing = null;
    this.editingOf = null;
    this.editOrigin = null;
    this.editStart = null;
    this.editHandle = null;
  }

  /**
   * 按下后捕获指针：多屏截图时每块屏是**独立窗口**，不捕获的话指针一移进
   * 邻屏窗口，本窗口就再也收不到 pointermove / pointerup —— 草稿停在屏幕
   * 边界，松手落空。捕获后 OS 会把整次拖动的鼠标消息都路由给本窗口，
   * 坐标出界（负值或超出窗口宽高）也照常送达。
   */
  private capturePointer(event: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(event.pointerId);
      this.capturedPointer = event.pointerId;
    } catch {
      // 指针已失效等场景：拖动退化成「只在窗口内」的原有行为
      this.capturedPointer = null;
    }
  }

  private releasePointer(): void {
    if (this.capturedPointer === null) return;
    try {
      this.canvas.releasePointerCapture(this.capturedPointer);
    } catch {
      // pointerup 后浏览器已隐式释放，忽略即可
    }
    this.capturedPointer = null;
  }

  /** 拖动 / 缩放开始：把在途标注的下标交给宿主（遮罩据此投影到其余屏）。 */
  private beginInFlight(shape: Shape): void {
    const idx = this.shapes.indexOf(shape);
    if (idx >= 0) this.onInFlightChange?.(idx);
  }

  // ------------------------------------------------------------ 指针

  private attach(): void {
    const { canvas } = this;

    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const p = this.toImage(event);

      // 1) 已选中图形的控制点最优先：调大小 / 拖箭头端点
      const handle = this.selected ? this.hitSelectedHandle(p) : null;
      if (handle && this.selected) {
        this.mode = 'handle';
        this.capturePointer(event);
        this.editingOf = this.selected;
        this.editOrigin = cloneShape(this.selected);
        this.editStart = p;
        this.editHandle = handle;
        this.editing = cloneShape(this.selected);
        this.beginInFlight(this.selected);
        return;
      }

      // 2) 点到已有图形 → 选中它并立刻开始整体拖动
      const hit = this.hitTest(p);
      if (hit) {
        this.select(hit);
        this.mode = 'move';
        this.capturePointer(event);
        this.editingOf = hit;
        this.editOrigin = cloneShape(hit);
        this.editStart = p;
        this.editHandle = null;
        this.editing = cloneShape(hit);
        this.beginInFlight(hit);
        this.render();
        return;
      }

      // 3) 没点到任何图形：取消选中，拖窗口 / 打字 / 画新图形
      this.select(null);

      if (this.current === 'text') {
        // 不 preventDefault 的话，浏览器会在事件派发完成后把焦点
        // 放回 body —— 输入框刚 focus 上就被 blur，立刻触发空提交
        event.preventDefault();
        // 点在已有文字上 = 二次编辑（回填原文本，提交时原位替换）
        const hitText = this.hitTest(p);
        if (hitText && hitText.type === 'text') {
          this.select(hitText);
          this.openTextEditor(event, hitText);
          return;
        }
        this.openTextEditor(event);
        return;
      }

      if (this.current === 'counter') {
        // 序号：点击即落一个自动递增的气泡（数量随撤销/删除重算）
        this.commit({
          type: 'counter',
          x: p.x,
          y: p.y,
          n: this.shapes.filter((s) => s.type === 'counter').length + 1,
          color: this.color,
        });
        this.render();
        return;
      }

      this.mode = 'draw';
      this.capturePointer(event);
      this.penPoints = [p];

      if (this.current === 'arrow') {
        this.draft = {
          type: 'arrow',
          x1: p.x,
          y1: p.y,
          x2: p.x,
          y2: p.y,
          color: this.color,
          width: this.width,
          head: this.arrowHead,
        };
      } else if (this.current === 'line') {
        this.draft = {
          type: 'line',
          x1: p.x,
          y1: p.y,
          x2: p.x,
          y2: p.y,
          color: this.color,
          width: this.width,
        };
      } else if (this.current === 'pen') {
        this.draft = {
          type: 'pen',
          points: [p],
          color: this.color,
          width: this.width,
        };
      } else if (this.current === 'marker') {
        // 荧光笔 = 半透明加粗画笔（8 位 hex 的 alpha 通道）
        this.draft = {
          type: 'pen',
          points: [p],
          color: `${this.color}59`,
          width: Math.max(12, this.width * 3),
        };
      } else if (this.current === 'mosaic') {
        this.draft =
          this.mosaicMode === 'brush'
            ? {
                type: 'mosaic',
                mode: 'brush',
                points: [p],
                radius: Math.max(2, this.width),
              }
            : {
                // 选区 / 高斯模糊：都是拖矩形
                type: 'mosaic',
                mode: this.mosaicMode,
                x: p.x,
                y: p.y,
                w: 0,
                h: 0,
              };
      } else {
        this.draft = {
          type: this.current === 'rect' ? 'rect' : 'ellipse',
          x: p.x,
          y: p.y,
          w: 0,
          h: 0,
          color: this.color,
          width: this.width,
        };
      }
      this.render();
    });

    window.addEventListener('pointermove', (event) => {
      if (!this.mode) {
        this.hoverCursor(event);
        return;
      }
      const p = this.toImage(event);

      if (this.mode === 'move') {
        if (!this.editing || !this.editOrigin || !this.editStart) return;
        this.editing = translateShape(this.editOrigin, p.x - this.editStart.x, p.y - this.editStart.y);
        this.render();
        // 拖动副本当草稿投影：其余屏才能实时跟上新位置
        this.onDraftChange?.(this.editing);
        return;
      }

      if (this.mode === 'handle') {
        if (!this.editing || !this.editOrigin || !this.editHandle) return;
        this.editing = applyShapeHandle(this.editOrigin, this.editHandle, p, this.ctx);
        this.render();
        this.onDraftChange?.(this.editing);
        return;
      }

      // mode === 'draw'
      if (!this.draft) return;
      if (this.draft.type === 'arrow' || this.draft.type === 'line') {
        this.draft.x2 = p.x;
        this.draft.y2 = p.y;
      } else if (this.draft.type === 'pen') {
        this.penPoints.push(p);
        this.draft.points = [...this.penPoints];
      } else if (this.draft.type === 'rect' || this.draft.type === 'ellipse') {
        this.draft.w = p.x - this.draft.x;
        this.draft.h = p.y - this.draft.y;
      } else if (this.draft.type === 'mosaic') {
        if (this.draft.mode === 'brush') {
          // 涂抹与画笔同样累加路径点
          this.penPoints.push(p);
          this.draft.points = [...this.penPoints];
        } else {
          // 选区 / 高斯模糊：拖矩形
          const start = this.penPoints[0];
          this.draft.w = p.x - start.x;
          this.draft.h = p.y - start.y;
        }
      }
      this.render();
      this.onDraftChange?.(this.draft);
    });

    const finish = () => {
      const mode = this.mode;
      if (!mode) return;
      this.releasePointer();

      if (mode === 'draw') {
        this.mode = null;
        const finished = this.draft;
        this.draft = null;
        this.penPoints = [];
        // 先结束草稿再提交：其余屏按这个顺序处理，不会出现
        // 「已提交的标注」和「过期草稿」叠着画一帧
        this.onDraftChange?.(null);
        if (finished && !this.tooSmall(finished)) {
          this.commit(finished);
          console.log(`[editor] 新增标注 type=${finished.type} 总数=${this.shapes.length}`);
        }
        this.render();
        return;
      }

      // mode === 'move' | 'handle'：没真动过就不留一条空历史
      this.mode = null;
      const changed =
        this.editing && this.editOrigin && JSON.stringify(this.editing) !== JSON.stringify(this.editOrigin);
      // 先收草稿、再复位在途（宿主恢复全量快照）；提交的历史广播随后
      // 把新位置覆盖出去 —— 其余屏按这个顺序收敛，不会叠画两份
      this.onDraftChange?.(null);
      this.onInFlightChange?.(null);
      if (changed && this.editingOf) {
        this.beginChange();
        const idx = this.shapes.indexOf(this.editingOf);
        if (idx >= 0) this.shapes[idx] = this.editing as Shape;
        this.selected = this.editing;
        console.log(`[editor] 调整标注 index=${idx} type=${this.editing.type}`);
        this.onHistoryChange?.();
      }
      this.editing = null;
      this.editingOf = null;
      this.editOrigin = null;
      this.editStart = null;
      this.editHandle = null;
      this.render();
    };

    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    // 窗口被主进程拖走时可能丢 pointerup，blur 兜底
    window.addEventListener('blur', finish);
  }

  private tooSmall(shape: Shape): boolean {
    if (shape.type === 'arrow') {
      return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 6;
    }
    if (shape.type === 'pen') return shape.points.length < 2;
    if (shape.type === 'mosaic') {
      if (shape.mode === 'brush') return shape.points.length < 3;
      return Math.abs(shape.w) < 6 || Math.abs(shape.h) < 6;
    }
    if (shape.type === 'rect' || shape.type === 'ellipse') {
      return Math.abs(shape.w) < 3 || Math.abs(shape.h) < 3;
    }
    return false;
  }

  // ------------------------------------------------------------ 文字

  /**
   * 打开文字输入框。
   *
   * 两个坑：
   * 1. focus() 必须延到下一个宏任务，否则浏览器的默认焦点行为会立刻把
   *    焦点抢回 body，输入框刚 focus 就 blur，立刻触发一次空提交；
   * 2. 同一时刻只允许一个输入框 —— 再次点击画布时先把上一个提交掉，
   *    否则会堆叠监听器、旧文本被 value='' 清掉。
   */
  private openTextEditor(
    event: MouseEvent,
    existing?: Extract<Shape, { type: 'text' }>,
  ): void {
    console.log(`[editor] 打开文字输入框 client=${Math.round(event.clientX)},${Math.round(event.clientY)}`);
    this.closeActiveText?.();

    const ta = this.textEditor;
    const rect = this.canvas.getBoundingClientRect();
    // 字号独立于线宽（线宽对文字没有意义），二次编辑沿用原字号
    const fontSize = existing ? existing.size : this.fontSize;
    // 输入框字号要和「最终画上去的字号」在屏幕上一样大：
    // 钉图是图像像素空间（1 图像 px = 1/outScale CSS px），遮罩是 DIP 空间（1:1）
    const scale = this.opts.coords === 'css' || rect.width <= 0 ? 1 : rect.width / this.canvas.width;

    ta.value = existing?.text ?? '';
    ta.hidden = false;
    const boxW = Math.max(60, fontSize * scale * 4);
    const boxH = fontSize * scale * 1.4;
    // 输入框不能被推出窗口（否则文字根本看不见）。定位是 body 的绝对子元素、
    // 用的是 client 坐标：画布左边已经不是窗口左边缘（左侧条带），
    // 用 rect.left 相减会整体偏移，所以只跟窗口尺寸比。
    const left = Math.min(event.clientX, Math.max(0, window.innerWidth - boxW));
    const top = Math.min(event.clientY, Math.max(0, window.innerHeight - boxH));
    ta.style.left = `${left}px`;
    ta.style.top = `${top}px`;
    ta.style.fontSize = `${fontSize * scale}px`;
    ta.style.color = existing ? existing.color : this.color;
    ta.style.minWidth = `${boxW}px`;
    ta.style.minHeight = `${boxH}px`;

    // 锚点跟着夹紧后的位置走：看到哪，导出就在哪；二次编辑锚在原文字处
    const origin = existing
      ? { x: existing.x, y: existing.y }
      : this.toImage({ clientX: left, clientY: top });
    let ended = false;
    let focused = false;

    const end = (save: boolean) => {
      if (ended) return;
      ended = true;
      ta.hidden = true;
      if (save) {
        const text = ta.value.trim();
        console.log(`[editor] 文字提交 长度=${text.length}`);
        if (text) {
          const at = this.clampTextOrigin(origin, text, fontSize);
          if (existing) {
            // 二次编辑：原位替换（进历史，可撤销）
            const idx = this.shapes.indexOf(existing);
            if (idx >= 0) {
              this.beginChange();
              this.shapes[idx] = {
                ...existing,
                x: at.x,
                y: at.y,
                text,
                size: fontSize,
              };
              this.onHistoryChange?.();
              this.render();
            }
          } else {
            this.commit({
              type: 'text',
              x: at.x,
              y: at.y,
              text,
              color: this.color,
              size: fontSize,
            });
            console.log(`[editor] 新增标注 type=text 总数=${this.shapes.length}`);
            this.render();
          }
        }
      } else {
        console.log('[editor] 文字取消');
      }
      ta.removeEventListener('blur', onBlur);
      ta.removeEventListener('keydown', onKey);
      if (this.closeActiveText === handler) this.closeActiveText = null;
      this.opts.onTextEdit?.(false);
    };

    const handler = () => end(true);
    const onBlur = () => {
      if (focused) end(true);
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        end(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        end(true);
      }
    };

    ta.addEventListener('blur', onBlur);
    ta.addEventListener('keydown', onKey);
    this.closeActiveText = handler;
    this.opts.onTextEdit?.(true);

    setTimeout(() => {
      ta.focus();
      focused = true;
    }, 0);
  }

  /**
   * 把文字锚点夹进画布：点在右下角又打了很多字的话，不夹紧
   * 导出时右侧 / 下侧会被画布裁掉。测量用绘制同一套字体与行高。
   */
  private clampTextOrigin(origin: Point, text: string, size: number): Point {
    const block = measureTextBlock(this.ctx, text, size);
    // 夹紧边界必须和坐标空间一致：钉图用画布像素，遮罩用 CSS px（= DIP）
    const rect = this.canvas.getBoundingClientRect();
    const maxX = this.opts.coords === 'css' ? rect.width : this.canvas.width;
    const maxY = this.opts.coords === 'css' ? rect.height : this.canvas.height;
    return {
      x: Math.min(Math.max(origin.x, 0), Math.max(0, maxX - block.width)),
      y: Math.min(Math.max(origin.y, 0), Math.max(0, maxY - block.height)),
    };
  }

  // ------------------------------------------------------------ 工具属性

  get colors(): string[] {
    return COLORS;
  }

  get widthMin(): number {
    return WIDTH_MIN;
  }

  get widthMax(): number {
    return WIDTH_MAX;
  }
}

/** 选中态手柄的边长基准（图像像素），再按 pxScale 放大。 */
const HANDLE_SIZE_UNIT = 8;
