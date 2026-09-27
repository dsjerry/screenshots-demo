import { intersect, renderOverlay } from './draw';
import { toBlob } from '../shared/bytes';
import { stitch } from '../shared/stitch';
import { HANDLE_CURSOR, hitHandleIn, pointInRect } from '../shared/selection';
import { Editor } from '../annotations/editor';
import { drawDraftPath, drawDraftRect, drawShape } from '../annotations/shapes';
import { createToolbar } from '../annotations/toolbar';
import type { ToolbarAction } from '../annotations/toolbar';
import type {
  DisplayShot,
  OverlayComposePayload,
  OverlayInitPayload,
  OverlaySelectionPayload,
  Point,
  Rect,
  Shape,
} from '../shared/types';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('无法创建 canvas 2d 上下文');

const toolbarEl = document.getElementById('toolbar') as HTMLDivElement;
const textEditorEl = document.getElementById(
  'text-editor',
) as HTMLTextAreaElement;

let shot: DisplayShot | null = null;
let payload: OverlaySelectionPayload | null = null;
let bg: ImageBitmap | null = null;
let cssWidth = 0;
let cssHeight = 0;
/** 标注编辑器（与钉图共用同一个类）；null = 尚未初始化 */
let editor: Editor | null = null;
/**
 * 其余屏的已提交标注 / 拖画草稿（虚拟屏 DIP）。本屏只负责渲染落在本屏的
 * 部分（平移到本窗口坐标后画布自然裁掉出界的），编辑权始终在来源屏。
 */
let remoteShapes: Shape[] = [];
let remoteDraft: Shape | null = null;
/** 工具条尺寸缓存 —— 每帧读 layout 太贵，而它的尺寸基本不变 */
let toolbarW = 0;
let toolbarH = 0;
let lastPointer: Point | null = null;
/** 前台切换请求进行中 —— 避免 pointermove 连发导致重复 invoke */
let focusRequesting = false;

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
  drawRemote();
  syncToolbar();
}

/**
 * 画**其余屏**的标注 / 草稿：远端坐标是虚拟屏 DIP，减去本屏原点即本窗口
 * 局部坐标。一条标注从 A 屏画到 B 屏时，A 的画布只有 A 的半截，
 * B 屏这半截就是靠这里补出来的（不广播的话 B 上永远什么都看不见）。
 */
function drawRemote(): void {
  if (!shot || (remoteShapes.length === 0 && !remoteDraft)) return;
  ctx.save();
  ctx.translate(-shot.bounds.x, -shot.bounds.y);
  for (const shape of remoteShapes) drawShape(ctx, shape);
  // 草稿与编辑器同款画法：马赛克只画半透明预览，松手才像素化
  if (remoteDraft && remoteDraft.type !== 'text') {
    if (remoteDraft.type === 'mosaic') {
      if (remoteDraft.mode === 'region') {
        drawDraftRect(ctx, remoteDraft.x, remoteDraft.y, remoteDraft.w, remoteDraft.h);
      } else {
        drawDraftPath(ctx, remoteDraft.points, remoteDraft.radius);
      }
    } else {
      drawShape(ctx, remoteDraft);
    }
  }
  ctx.restore();
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

  // 光标移到哪块屏，键盘事件就该归哪块屏。遮罩的焦点不会自动跟着光标走 ——
  // 光标跨屏且中间没点过时，焦点还留在上一块屏，此时按 C / Ctrl+Z 会作用到
  // 错误的窗口（复制到旧颜色、撤销掉别的屏的标注）。本窗口收到 pointermove
  // 却没有焦点，就是这种状态，请求主进程把自己切到前台。
  if (!document.hasFocus() && !focusRequesting) {
    focusRequesting = true;
    void window.api.overlay.focus().finally(() => {
      focusRequesting = false;
    });
  }

  updateCursor(p);
  updateMagnifier(p);
});

/**
 * 指针离开本窗口（移到别的屏幕 / 别的窗口）时收起放大镜。
 *
 * 放大镜只在 `pointermove` 里更新，光标一旦离开本屏就再也不会触发它 ——
 * 不主动隐藏就会停在原处，而目标屏幕上又会新起一个，出现两个放大镜。
 *
 * `relatedTarget === null` 才表示指针离开窗口；窗口内部元素之间移动时
 * 它指向目标元素，那种情况不该收起。
 */
window.addEventListener('pointerout', (event) => {
  if (!event.relatedTarget) magEl.hidden = true;
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
  toolbarEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function setupAnnotation(): void {
  // 两行式工具条（结构见 annotations/toolbar.ts），这里只注入动作组。
  // 没有「确定」步骤：复制 / 保存就地合成即结束，钉住才是主操作；
  // 动作顺序与业界一致 —— 保存类在前，取消（红）与确定（绿）收尾。
  const actions: ToolbarAction[] = [
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
    {
      id: 'pin',
      label: '钉住',
      primary: true,
      run: () => {
        void window.api.overlay.action({ kind: 'pin' });
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
    // 属性行（线宽 + 色块）随工具显隐，容器高度会变，必须让定位逻辑重新量
    toolbarW = 0;
    toolbarH = 0;
    if (lastPointer) updateCursor(lastPointer);
  };

  createToolbar(toolbarEl, instance, { actions });

  // createToolbar 已经占了 onHistoryChange（刷新撤销/重做禁用态），
  // 链上去把本屏标注回传主进程 —— 只在历史变化时发，不是每帧。
  const syncHistory = instance.onHistoryChange;
  instance.onHistoryChange = () => {
    syncHistory?.();
    void window.api.overlay.shapes({ shapes: instance.getShapes() });
  };

  // 本屏拖画中的草稿实时投影到其余屏。pointermove 每帧都变，按帧合并成
  // 一条 IPC；结束（null）则立即发 —— 要赶在提交触发的「已提交标注」
  // 广播前面，其余屏才不会把新标注和过期草稿叠着画一帧。
  let draftRaf: number | null = null;
  let draftLatest: Shape | null = null;
  instance.onDraftChange = (draft) => {
    if (draft === null) {
      if (draftRaf !== null) {
        cancelAnimationFrame(draftRaf);
        draftRaf = null;
      }
      void window.api.overlay.draft({ draft: null });
      return;
    }
    draftLatest = draft;
    if (draftRaf !== null) return;
    draftRaf = requestAnimationFrame(() => {
      draftRaf = null;
      void window.api.overlay.draft({ draft: draftLatest });
    });
  };

  // 拖动 / 缩放既有标注：把在途下标报给主进程 —— 它对内仍存全量快照
  //（导出 / 钉图用），只对其余遮罩广播时滤掉这条，其余屏改画拖动副本
  //（onDraftChange 投影）；结束时恢复全量，提交的历史广播再覆盖成新位置。
  instance.onInFlightChange = (index) => {
    void window.api.overlay.inFlight({ index });
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
    remoteShapes = [];
    remoteDraft = null;
    if (bg) {
      bg.close();
      bg = null;
    }
    magEl.hidden = true;
    toolbarEl.hidden = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  // 其余屏的标注 / 草稿广播：只更新远端状态并重绘，不参与编辑
  window.api.overlay.remoteShapes(({ fromDisplayId, shapes }) => {
    if (!shot || fromDisplayId === shot.displayId) return;
    remoteShapes = shapes;
    paint();
  });
  window.api.overlay.remoteDraft(({ fromDisplayId, draft }) => {
    if (!shot || fromDisplayId === shot.displayId) return;
    remoteDraft = draft;
    paint();
  });

  // 复制 / 保存：主进程把合成数据推过来，本窗口就地拼图后回传 PNG
  window.api.overlay.compose(({ kind, data }) => {
    void exportImage(kind, data);
  });

  paint();
  await window.api.overlay.ready();
}

// ---------------------------------------------------------------- 放大镜

/**
 * 放大镜画布尺寸 —— **唯一来源**：backing store 与 CSS 尺寸都由它决定
 * （`sizeMagnifier()` 写入 `--mag-w` / `--mag-h`，CSS 只取变量）。
 *
 * 相对初始的 100×72 放大到 180×135（面积约 2.5 倍），倍率保持 4×，
 * 即同样的放大倍数下能看到更大范围；页脚最宽的一行（RGB 格式约 94px）
 * 连同内边距仍远小于 180px。
 */
const MAG_W = 180;
const MAG_H = 135;
/**
 * 页脚高度（坐标 / 颜色 / 两行快捷键提示），跟随翻边与屏内夹紧都要用。
 *
 * **首次显示时实测** —— 文案或字号一改，硬编码值就会与真实高度不符，
 * 放大镜在屏幕底部会被夹出可视区。
 */
let footH = 0;
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

// ---------------------------------------------------------------- 取色显示

/** 颜色显示格式，Shift 切换 */
let colorFormat: 'hex' | 'rgb' = 'hex';
/** 最近一次取到的颜色，供 C 键复制 */
let lastColor: { r: number; g: number; b: number } | null = null;
/** 复制反馈展示中；非 null 时不覆盖页脚文本 */
let colorTextTimer: ReturnType<typeof setTimeout> | null = null;

function colorHex(c: { r: number; g: number; b: number }): string {
  return `#${[c.r, c.g, c.b]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** 复制到剪贴板的值，不带标签：`#AABBCC` 或 `170, 187, 204` */
function colorValue(
  c: { r: number; g: number; b: number },
  fmt: 'hex' | 'rgb',
): string {
  return fmt === 'hex' ? colorHex(c) : `${c.r}, ${c.g}, ${c.b}`;
}

/** 页脚显示的文本，带标签便于分辨当前格式 */
function colorLabel(
  c: { r: number; g: number; b: number },
  fmt: 'hex' | 'rgb',
): string {
  return fmt === 'hex' ? `HEX: ${colorHex(c)}` : `RGB: ${colorValue(c, 'rgb')}`;
}

function applyColorText(): void {
  if (!lastColor || colorTextTimer) return;
  magRgb.textContent = colorLabel(lastColor, colorFormat);
}

function flashColorText(text: string): void {
  magRgb.textContent = text;
  if (colorTextTimer) clearTimeout(colorTextTimer);
  colorTextTimer = setTimeout(() => {
    colorTextTimer = null;
    applyColorText();
  }, 1000);
}

/** 复制**当前显示格式**的颜色值，页脚短暂回显结果 */
async function copyCurrentColor(): Promise<void> {
  if (!lastColor) return;
  const value = colorValue(lastColor, colorFormat);
  try {
    const res = await window.api.overlay.copyText({ text: value });
    flashColorText(res.ok ? `已复制 ${value}` : '复制失败');
  } catch {
    flashColorText('复制失败');
  }
}

function sizeMagnifier(): void {
  const dpr = window.devicePixelRatio || 1;
  magCanvas.width = Math.max(1, Math.round(MAG_W * dpr));
  magCanvas.height = Math.max(1, Math.round(MAG_H * dpr));
  // 尺寸只在上面的常量里定义，CSS 通过变量取，避免两处不同步
  magEl.style.setProperty('--mag-w', `${MAG_W}px`);
  magEl.style.setProperty('--mag-h', `${MAG_H}px`);
}
sizeMagnifier();

/** 元素可见后量一次：总高 − 画布高 − 上下边框各 1px */
function measureFooter(): void {
  if (footH > 0) return;
  const total = magEl.getBoundingClientRect().height;
  if (total > MAG_H) footH = Math.round(total - MAG_H - 2);
}

function updateMagnifier(p: Point): void {
  // 只在「还没框出选区」时出现：框选中、调整中、确认后都不显示
  const show =
    !!shot && !!bg && !!magCtx && !!payload?.phase && !payload.selection;
  if (!show || !shot || !bg || !magCtx || !payload) {
    magEl.hidden = true;
    return;
  }
  magEl.hidden = false;
  measureFooter();

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
    lastColor = { r: data[0], g: data[1], b: data[2] };
    applyColorText();
  }

  // 坐标用虚拟屏 DIP —— 与选区、钉图窗口 bounds 同一坐标系
  magPos.textContent = `坐标 ${Math.round(shot.bounds.x + p.x)},${Math.round(shot.bounds.y + p.y)}`;

  // 跟随光标，右/下放不下就翻到另一侧，最后夹回窗口内
  let left = p.x + 20;
  let top = p.y + 20;
  if (left + MAG_W > cssWidth) left = p.x - MAG_W - 20;
  const fh = footH > 0 ? footH : 40;
  if (top + MAG_H + fh > cssHeight) top = p.y - MAG_H - fh - 4;
  left = Math.min(Math.max(4, left), Math.max(4, cssWidth - MAG_W - 4));
  top = Math.min(Math.max(4, top), Math.max(4, cssHeight - MAG_H - fh - 4));
  magEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/**
 * 放大镜快捷键：Shift 切换 HEX / RGB，C 复制当前显示的颜色值。
 *
 * 仅在放大镜可见时生效；文字输入中不接管（否则 `c` 会被打进文本框）。
 * Shift 走 keydown 且忽略自动重复，按住不会来回翻。
 * 无修饰键的 `C` 才复制 —— `Ctrl+C` 是工具条的复制整图，不能抢。
 */
window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLTextAreaElement) return;
  if (magEl.hidden) return;

  if (event.key === 'Shift') {
    if (event.repeat) return;
    colorFormat = colorFormat === 'hex' ? 'rgb' : 'hex';
    applyColorText();
    return;
  }
  if (event.key !== 'c' && event.key !== 'C') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (!lastColor) return;
  event.preventDefault();
  void copyCurrentColor();
});

// 必须在指针分流监听器**之后**构造，编辑器的监听器才排在它后面
setupAnnotation();

void main();
