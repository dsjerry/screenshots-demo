import { intersect, renderOverlay } from './draw';
import { toBlob } from '../shared/bytes';
import { stitch } from '../shared/stitch';
import { HANDLE_CURSOR, hitHandleIn, pointInRect } from '../shared/selection';
import { Editor } from '../annotations/editor';
import { drawShape } from '../annotations/shapes';
import { createToolbar } from '../annotations/toolbar';
import type { ToolbarAction } from '../annotations/toolbar';
import type {
  DisplayShot,
  OverlayComposePayload,
  OverlayInitPayload,
  OverlaySelectionPayload,
  Point,
  Rect,
} from '../shared/types';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('无法创建 canvas 2d 上下文');

const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const textEditorEl = document.getElementById('text-editor') as HTMLTextAreaElement;

let shot: DisplayShot | null = null;
let payload: OverlaySelectionPayload | null = null;
let bg: ImageBitmap | null = null;
let cssWidth = 0;
let cssHeight = 0;
/** 标注编辑器（与钉图共用同一个类）；null = 尚未初始化 */
let editor: Editor | null = null;
/** 工具条尺寸缓存 —— 每帧读 layout 太贵，而它的尺寸基本不变 */
let toolbarW = 0;
let toolbarH = 0;
let lastPointer: Point | null = null;

function resize(): void {
  if (!shot) return;
  cssWidth = shot.bounds.width;
  cssHeight = shot.bounds.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  toolbarW = 0;
  toolbarH = 0;
}

/**
 * 一帧：截图 + 遮罩 + 选框/手柄（renderOverlay 自己设 transform 到 CSS px）
 * + 标注层 + 工具条定位。编辑器的 `repaint` 就指向这里。
 */
function paint(): void {
  if (!shot || !bg) return;
  renderOverlay(ctx, cssWidth, cssHeight, bg, { shot, payload });
  editor?.renderInto(ctx);
  syncToolbar();
}

async function decode(png: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(toBlob(png, 'image/png'));
}

// ---------------------------------------------------------------- 指针分流

/**
 * 选区在**本窗口**的局部矩形（拿不到选区则 null）。
 *
 * `intersect()` 给的是**虚拟屏坐标**。主屏原点恰好是 `(0,0)`，虚拟坐标与本地
 * 坐标一样，所以主屏上看不出差别；副屏（例如 `-1920,8`）不减掉原点就全错位：
 * - 判「点在不在选区内」恒为 false → 永远走「框外按下」分支 →
 *   `stopImmediatePropagation()` 挡掉编辑器 → **画笔/马赛克根本画不下去**；
 * - 算工具条 x 得到大负数 → 被夹到 8 → **条子贴死在副屏左边缘**。
 *
 * 手柄那条路不受影响：`hitHandleIn()` 内部就是按原点平移的。
 */
function selectionLocal(): Rect | null {
  if (!shot || !payload?.selection) return null;
  const r = intersect(payload.selection, shot.bounds);
  if (!r) return null;
  return {
    x: r.x - shot.bounds.x,
    y: r.y - shot.bounds.y,
    width: r.width,
    height: r.height,
  };
}

/**
 * 这一下该「调整选区」还是「画标注」。
 *
 * 返回 true = 主进程接管（本监听器负责 stopImmediatePropagation，
 * 编辑器的 pointerdown 就不会跑了）；返回 false = 放行给编辑器画。
 *
 * 规则：手型工具、或按下点不在选区内 → 调整选区（框外按下 = 重新框选）；
 * 绘图工具且在选区内 → 画标注。工具条本身在另一个元素上，点它不会进来。
 */
function routeToSelection(event: PointerEvent): boolean {
  const tool = editor?.currentTool ?? 'hand';
  const local = selectionLocal();
  const inside =
    !!local && pointInRect(local, { x: event.clientX, y: event.clientY });
  if (tool !== 'hand' && inside) return false;
  void window.api.overlay.input({ kind: 'down' });
  return true;
}

// 必须在 new Editor() **之前**注册：同一目标上，先注册的先跑，
// stopImmediatePropagation 才挡得住编辑器那个监听器。
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (routeToSelection(event)) event.stopImmediatePropagation();
});

window.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  void window.api.overlay.input({ kind: 'up' });
});
canvas.addEventListener('dblclick', () => {
  void window.api.overlay.input({ kind: 'dblclick' });
});
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  void window.api.overlay.input({ kind: 'context' });
});

window.addEventListener('resize', () => {
  resize();
  paint();
});

/**
 * 光标反馈（手柄 / 框内移动 / 重新框选）+ 放大镜。
 *
 * 两者都用本地坐标算：本窗口 CSS px ≡ 本屏 DIP，光标事件只在光标所在的
 * 那块屏的遮罩上触发，`origin + 本地坐标` 就是虚拟屏坐标 —— 不需要主进程
 * 再广播一次光标。主进程只在**按下**时判定模式，那才是选区的真相源。
 */
window.addEventListener('pointermove', (event) => {
  const p = { x: event.clientX, y: event.clientY };
  lastPointer = p;
  updateCursor(p);
  updateMagnifier(p);
});

function updateCursor(p: Point): void {
  const adjusting =
    shot && payload && payload.phase === 'adjusting' && payload.selection;
  if (!adjusting || !shot || !payload?.selection) {
    canvas.style.cursor = '';
    return;
  }
  // 绘图工具下没有「调选区」的视觉暗示 —— 手柄光标只会误导
  if (payload.activeTool !== 'hand') {
    canvas.style.cursor = 'crosshair';
    return;
  }
  const origin = shot.bounds;
  const handle = hitHandleIn(payload.selection, origin, p, {
    width: cssWidth,
    height: cssHeight,
  });
  if (handle) {
    canvas.style.cursor = HANDLE_CURSOR[handle];
    return;
  }
  const local = selectionLocal();
  canvas.style.cursor = local && pointInRect(local, p) ? 'move' : 'crosshair';
}

// ---------------------------------------------------------------- 工具条

/**
 * 显隐 + 定位：只在这块屏是「选区中心所在屏」时显示，
 * 默认贴选区右下、下方放不下翻上方、再不行贴屏底。
 */
function syncToolbar(): void {
  const show =
    !!shot &&
    !!payload &&
    payload.phase === 'adjusting' &&
    !!payload.selection &&
    payload.toolbarDisplayId === shot.displayId;
  if (!show || !shot || !payload?.selection) {
    toolbarEl.hidden = true;
    return;
  }
  const local = selectionLocal();
  if (!local) {
    toolbarEl.hidden = true;
    return;
  }
  const wasHidden = toolbarEl.hidden;
  toolbarEl.hidden = false;
  // 刚显示出来才重新量：按钮文案会闪（「已复制」），量一次就缓存会跟着过期
  if (wasHidden || !toolbarW || !toolbarH) {
    const r = toolbarEl.getBoundingClientRect();
    toolbarW = r.width;
    toolbarH = r.height;
  }

  // 默认贴选区右下；条子比选区还宽时改成**居中**贴着选区，
  // 否则右对齐会被夹到屏的左边缘（看着像跟选区没关系）
  let x =
    local.width >= toolbarW
      ? local.x + local.width - toolbarW
      : local.x + local.width / 2 - toolbarW / 2;
  let y = local.y + local.height + 10;
  if (y + toolbarH > cssHeight) y = local.y - toolbarH - 10;
  if (y < 0) y = Math.max(8, cssHeight - toolbarH - 8);
  x = Math.min(Math.max(8, x), Math.max(8, cssWidth - toolbarW - 8));
  toolbarEl.style.transform =
    `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function setupAnnotation(): void {
  // 与钉图工具条**同一个组件、同样的四组**（工具/色块/线宽/历史），
  // 只有尾部动作不同；这里没有「确定」—— 主流截图工具都没有。
  const actions: ToolbarAction[] = [
    {
      id: 'pin',
      label: '钉住',
      run: () => {
        void window.api.overlay.action({ kind: 'pin' });
      },
    },
    {
      id: 'copy',
      label: '复制',
      run: () => {
        // 主进程推合成数据回来，本窗口就地拼图 → 回传 PNG → 剪贴板
        void window.api.overlay.action({ kind: 'copy' });
      },
    },
    {
      id: 'save',
      label: '保存',
      run: () => {
        void window.api.overlay.action({ kind: 'save' });
      },
    },
    {
      id: 'cancel',
      label: '取消',
      danger: true,
      run: () => {
        void window.api.overlay.action({ kind: 'cancel' });
      },
    },
  ];

  const instance = new Editor(canvas, textEditorEl, {
    // 重绘交给宿主：本窗口还要画截图、遮罩、选框、手柄
    repaint: paint,
    // 遮罩的坐标空间是本屏 DIP（ctx 已按 dpr 缩放），不是 backing 像素
    coords: 'css',
    // 打字时把 Enter/Esc 还给渲染进程
    onTextEdit: (open) => {
      void window.api.overlay.editState({ textEditing: open });
    },
  });
  editor = instance;

  instance.onToolChange = (tool) => {
    void window.api.overlay.tool({ tool });
    if (lastPointer) updateCursor(lastPointer);
  };

  createToolbar(toolbarEl, instance, {
    orient: 'row',
    idleHide: false,
    actions,
  });

  // createToolbar 已经占了 onHistoryChange（刷新撤销/重做禁用态），
  // 链上去把本屏标注回传主进程 —— 只在历史变化时发，不是每帧。
  const syncHistory = instance.onHistoryChange;
  instance.onHistoryChange = () => {
    syncHistory?.();
    void window.api.overlay.shapes({ shapes: instance.getShapes() });
  };
}

/**
 * 就地合成导出（复制 / 保存）：拼图 + 把**全部**标注（各屏合并、已换算成
 * 图像像素）画上去 → 回传 PNG。整个过程不建钉图窗口，跟主流一致。
 */
async function exportImage(
  kind: 'copy' | 'save',
  data: OverlayComposePayload,
): Promise<void> {
  try {
    console.log(
      `[overlay] 合成导出 kind=${kind} selection=` +
        `${Math.round(data.selection.width)}x${Math.round(data.selection.height)}` +
        ` shapes=${data.shapes.length}`,
    );
    const stitched = await stitch(data);
    const sctx = stitched.getContext('2d');
    if (sctx) for (const shape of data.shapes) drawShape(sctx, shape);

    const blob = await new Promise<Blob | null>((resolve) =>
      stitched.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('canvas.toBlob 返回空');
    const png = new Uint8Array(await blob.arrayBuffer());
    const res = await window.api.overlay.export({ kind, png });
    if (!res.ok) console.error('[overlay] 导出失败', res.error);
  } catch (err) {
    console.error('[overlay] 合成导出异常', err);
  }
}

async function main(): Promise<void> {
  const init: OverlayInitPayload | null = await window.api.overlay.boot();
  if (!init) {
    console.warn('[overlay] boot 返回 null，本窗口不参与本次截图');
    document.body.style.background = '#000';
    return;
  }
  shot = init.shot;
  resize();

  try {
    bg = await decode(shot.png);
  } catch (err) {
    console.error('[overlay] 截图解码失败', err);
    return;
  }

  // 先订阅，再 ready —— 主进程要等首屏 ready 才开始广播
  window.api.overlay.selection((next) => {
    payload = next;
    // 工具条可能在别的屏上选的工具，这边要跟上（不同才 set，
    // 否则每次广播都会把正在画的草稿清掉）
    if (editor && editor.currentTool !== next.activeTool) {
      editor.setTool(next.activeTool);
    }
    paint();
  });
  window.api.overlay.teardown(() => {
    // 窗口留着复用，但截图位图和解码后的位图都不能再占着内存
    payload = null;
    shot = null;
    if (bg) {
      bg.close();
      bg = null;
    }
    magEl.hidden = true;
    toolbarEl.hidden = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  // 复制 / 保存：主进程把合成数据推过来，本窗口就地拼图后回传 PNG
  window.api.overlay.compose(({ kind, data }) => {
    void exportImage(kind, data);
  });

  paint();
  await window.api.overlay.ready();
}

// ---------------------------------------------------------------- 放大镜

const MAG_W = 100;
const MAG_H = 72;
/** 相对屏幕的放大倍率：平时 1 CSS px 显示 scaleX 个源像素，放大镜里只显示 scaleX/ZOOM 个 */
const MAG_ZOOM = 4;

const magEl = document.getElementById('magnifier') as HTMLDivElement;
const magCanvas = document.getElementById('mag-stage') as HTMLCanvasElement;
const magCtx = magCanvas.getContext('2d');
const magPos = document.getElementById('mag-pos') as HTMLSpanElement;
const magRgb = document.getElementById('mag-rgb') as HTMLSpanElement;
/** 取色用的 1×1 采样画布（不能把整张图再复制一份） */
const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = 1;
sampleCanvas.height = 1;
const sampleCtx = sampleCanvas.getContext('2d');

function sizeMagnifier(): void {
  const dpr = window.devicePixelRatio || 1;
  magCanvas.width = Math.max(1, Math.round(MAG_W * dpr));
  magCanvas.height = Math.max(1, Math.round(MAG_H * dpr));
}
sizeMagnifier();

function updateMagnifier(p: Point): void {
  // 只在「还没框出选区」时出现：框选中、调整中、确认后都不显示
  const show =
    !!shot && !!bg && !!magCtx && !!payload?.phase && !payload.selection;
  if (!show || !shot || !bg || !magCtx || !payload) {
    magEl.hidden = true;
    return;
  }
  magEl.hidden = false;

  const dpr = window.devicePixelRatio || 1;
  const destW = magCanvas.width;
  const destH = magCanvas.height;

  // 本屏 DIP → 源图像素（与拼接用的是同一套换算）
  const sx = p.x * shot.scaleX;
  const sy = p.y * shot.scaleY;
  const srcW = (MAG_W * shot.scaleX) / MAG_ZOOM;
  const srcH = (MAG_H * shot.scaleY) / MAG_ZOOM;
  const sx0 = sx - srcW / 2;
  const sy0 = sy - srcH / 2;

  magCtx.setTransform(1, 0, 0, 1, 0, 0);
  magCtx.imageSmoothingEnabled = false;
  magCtx.fillStyle = '#000000';
  magCtx.fillRect(0, 0, destW, destH);

  // 只画落在图内的那部分，边缘对齐回原位（显示器边角处不会整块消失）
  const cx0 = Math.max(0, sx0);
  const cy0 = Math.max(0, sy0);
  const cx1 = Math.min(shot.imageWidth, sx0 + srcW);
  const cy1 = Math.min(shot.imageHeight, sy0 + srcH);
  if (cx1 > cx0 && cy1 > cy0) {
    const kx = destW / srcW;
    const ky = destH / srcH;
    magCtx.drawImage(
      bg,
      cx0,
      cy0,
      cx1 - cx0,
      cy1 - cy0,
      (cx0 - sx0) * kx,
      (cy0 - sy0) * ky,
      (cx1 - cx0) * kx,
      (cy1 - cy0) * ky,
    );
  }

  // 十字准星
  const midX = Math.round(destW / 2) + 0.5;
  const midY = Math.round(destH / 2) + 0.5;
  magCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  magCtx.lineWidth = Math.max(1, dpr);
  magCtx.beginPath();
  magCtx.moveTo(0, midY);
  magCtx.lineTo(destW, midY);
  magCtx.moveTo(midX, 0);
  magCtx.lineTo(midX, destH);
  magCtx.stroke();

  // 取色：把光标那 1 个源像素画进 1×1 采样画布
  if (sampleCtx) {
    const px = Math.min(shot.imageWidth - 1, Math.max(0, Math.round(sx)));
    const py = Math.min(shot.imageHeight - 1, Math.max(0, Math.round(sy)));
    sampleCtx.clearRect(0, 0, 1, 1);
    sampleCtx.drawImage(bg, px, py, 1, 1, 0, 0, 1, 1);
    const { data } = sampleCtx.getImageData(0, 0, 1, 1);
    const hex = [data[0], data[1], data[2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    magRgb.textContent = `RGB: #${hex}`;
  }

  // 坐标用虚拟屏 DIP —— 与选区、钉图窗口 bounds 同一坐标系
  magPos.textContent =
    `坐标 ${Math.round(shot.bounds.x + p.x)},${Math.round(shot.bounds.y + p.y)}`;

  // 跟随光标，右/下放不下就翻到另一侧，最后夹回窗口内
  let left = p.x + 20;
  let top = p.y + 20;
  if (left + MAG_W > cssWidth) left = p.x - MAG_W - 20;
  if (top + MAG_H + 22 > cssHeight) top = p.y - MAG_H - 40;
  left = Math.min(Math.max(4, left), Math.max(4, cssWidth - MAG_W - 4));
  top = Math.min(Math.max(4, top), Math.max(4, cssHeight - MAG_H - 26));
  magEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

// 必须在指针分流监听器**之后**构造，编辑器的监听器才排在它后面
setupAnnotation();

void main();
