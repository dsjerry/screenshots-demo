import type { Editor } from './editor';
import type { ArrowHead, MosaicMode, ToolId } from '../shared/types';
import './annotations.css';

const TOOL_LABELS: Record<ToolId, string> = {
  hand: '移动',
  arrow: '箭头',
  rect: '矩形',
  ellipse: '椭圆',
  pen: '画笔',
  mosaic: '马赛克',
  text: '文字',
};

const ARROW_HEAD_LABELS: Record<ArrowHead, string> = {
  solid: '实心',
  open: '空心',
};

const MOSAIC_MODE_LABELS: Record<MosaicMode, string> = {
  region: '选区',
  brush: '涂抹',
};

/**
 * 行 2 按工具显示的属性分组。行 2 存在的意义就是「当前工具的属性」：
 * 手型没有属性（整行隐藏）、马赛克没有颜色、文字没有线宽（字号独立）。
 */
const ROW2_BY_TOOL: Record<ToolId, string[]> = {
  hand: [],
  arrow: ['head', 'width', 'color'],
  rect: ['width', 'color'],
  ellipse: ['width', 'color'],
  pen: ['width', 'color'],
  text: ['size', 'color'],
  mosaic: ['mode'],
};

/** 追加在历史组之后的动作按钮，由宿主提供。 */
export interface ToolbarAction {
  id: string;
  label: string;
  /** 危险色（取消 / 关闭） */
  danger?: boolean;
  /** 主操作强调色（确定类），对应业界通行的绿色 ✓ */
  primary?: boolean;
  /** 初始高亮 */
  active?: boolean;
  run(btn: HTMLButtonElement): void | Promise<void>;
}

export interface ToolbarOptions {
  /** 宿主动作：只有遮罩在用（钉住 / 复制 / 保存 / 取消） */
  actions?: ToolbarAction[];
}

/**
 * 标注工具条 —— 目前只有截图遮罩在用（钉图钉住后是只读贴图，只剩关闭按钮）。
 *
 * 采用业界通行的**两行式**：
 * - 行 1：工具 | 历史 | 动作（主操作绿色、取消红色收尾）
 * - 行 2：当前工具的属性（线宽 + 色块），**手型工具时隐藏** —— 调整选区不需要绘制属性
 *
 * 拆两行的直接原因是宽度：挤在一行时全量约 944px，比大多数选区还宽，会被
 * 夹到屏幕边缘、看起来与选区脱节。两行后行 1 约 700px、行 2 约 370px。
 *
 * 快捷键：`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` / `Delete` 恒定生效；
 * `Ctrl+C`、`Esc` 按宿主是否提供对应动作决定。
 */
export function createToolbar(container: HTMLElement, editor: Editor, opts: ToolbarOptions = {}): void {
  container.replaceChildren();

  const tools = group();
  for (const id of editor.toolIds) {
    const btn = button(TOOL_LABELS[id]);
    btn.dataset.tool = id;
    btn.classList.toggle('is-active', id === editor.currentTool);
    btn.addEventListener('click', () => {
      editor.setTool(id);
      syncActive();
    });
    tools.append(btn);
  }

  const colors = group();
  for (const c of editor.colors) {
    const btn = button('');
    btn.className = 'swatch';
    btn.style.background = c;
    btn.dataset.color = c;
    if (c === '#ffffff') btn.classList.add('is-light');
    btn.addEventListener('click', () => {
      editor.setColor(c);
      syncActive();
    });
    colors.append(btn);
  }

  const widths = group();
  for (const w of editor.widths) {
    const btn = button('');
    btn.className = 'stroke';
    btn.dataset.width = String(w);
    const dot = document.createElement('span');
    dot.style.height = `${Math.min(w, 8)}px`;
    dot.style.width = '18px';
    dot.style.background = 'currentColor';
    dot.style.borderRadius = '99px';
    btn.append(dot);
    btn.addEventListener('click', () => {
      editor.setWidth(w);
      syncActive();
    });
    widths.append(btn);
  }

  const heads = group();
  for (const h of editor.arrowHeads) {
    const btn = button(ARROW_HEAD_LABELS[h]);
    btn.dataset.head = h;
    btn.classList.toggle('is-active', h === editor.arrowHeadValue);
    btn.addEventListener('click', () => {
      editor.setArrowHead(h);
      syncActive();
    });
    heads.append(btn);
  }

  const sizes = group();
  for (const n of editor.fontSizes) {
    const btn = button(String(n));
    btn.dataset.size = String(n);
    btn.classList.toggle('is-active', n === editor.fontSizeValue);
    btn.addEventListener('click', () => {
      editor.setFontSize(n);
      syncActive();
    });
    sizes.append(btn);
  }

  const modes = group();
  for (const m of editor.mosaicModes) {
    const btn = button(MOSAIC_MODE_LABELS[m]);
    btn.dataset.mode = m;
    btn.classList.toggle('is-active', m === editor.mosaicModeValue);
    btn.addEventListener('click', () => {
      editor.setMosaicMode(m);
      syncActive();
    });
    modes.append(btn);
  }

  const history = group();
  const undo = button('撤销');
  undo.addEventListener('click', () => editor.undo());
  const redo = button('重做');
  redo.addEventListener('click', () => editor.redo());
  const clear = button('清空');
  clear.addEventListener('click', () => editor.clear());
  history.append(undo, redo, clear);

  const actions = group();
  const byId = new Map<string, HTMLButtonElement>();
  const extras = opts.actions ?? [];
  for (const spec of extras) {
    const btn = button(spec.label);
    btn.dataset.action = spec.id;
    if (spec.danger) btn.classList.add('is-danger');
    if (spec.primary) btn.classList.add('is-primary');
    if (spec.active) btn.classList.add('is-active');
    btn.addEventListener('click', () => void spec.run(btn));
    actions.append(btn);
    byId.set(spec.id, btn);
  }

  // 行 1：工具 | 历史 | 动作
  const mainRow = rowEl();
  const mainGroups = [tools, history];
  if (extras.length > 0) mainGroups.push(actions);
  mainRow.append(...mainGroups);

  // 行 2：当前工具的属性（线宽 + 色块）
  const propRow = rowEl();
  // 属性分组在前、通用分组在后：每个工具先看到自己特有的控制
  propRow.append(heads, sizes, modes, widths, colors);
  const row2Groups = new Map<string, HTMLElement>([
    ['head', heads],
    ['size', sizes],
    ['mode', modes],
    ['width', widths],
    ['color', colors],
  ]);
  const row2Order = [heads, sizes, modes, widths, colors];

  container.append(mainRow, propRow);

  // 分隔线画在每组第一个按钮上（每行的第一组不留线）
  addDividers(mainGroups);

  function syncActive(): void {
    const attr = (name: string, current: string) => {
      container
        .querySelectorAll<HTMLButtonElement>(`[data-${name}]`)
        .forEach((b) => b.classList.toggle('is-active', b.dataset[name] === current));
    };
    attr('tool', editor.currentTool);
    attr('color', editor.colorValue);
    attr('head', editor.arrowHeadValue);
    attr('mode', editor.mosaicModeValue);
    container.querySelectorAll<HTMLButtonElement>('[data-width]').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.width) === editor.widthValue);
    });
    container.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.size) === editor.fontSizeValue);
    });

    syncRow2();
  }

  /** 行 2 按当前工具决定显示哪些属性分组 */
  function syncRow2(): void {
    const show = new Set(ROW2_BY_TOOL[editor.currentTool] ?? []);
    // 涂抹下线宽是笔刷半径；选区模式没有笔刷，一并隐藏
    if (editor.currentTool === 'mosaic' && editor.mosaicModeValue === 'brush') {
      show.add('width');
    }
    row2Groups.forEach((g, key) => {
      g.hidden = !show.has(key);
    });
    propRow.hidden = show.size === 0;
    syncRow2Dividers();
  }

  /** 分隔线跟着可见分组走 —— 被隐藏的分组不能留下悬空竖线 */
  function syncRow2Dividers(): void {
    row2Order.forEach((g) => {
      g.firstElementChild?.classList.remove('is-group-start');
    });
    let first = true;
    for (const g of row2Order) {
      if (g.hidden) continue;
      if (first) {
        first = false;
        continue;
      }
      g.firstElementChild?.classList.add('is-group-start');
    }
  }
  syncActive();

  const syncHistory = () => {
    undo.disabled = !editor.canUndo;
    redo.disabled = !editor.canRedo;
  };
  editor.onHistoryChange = syncHistory;
  syncHistory();

  // ---------------- 快捷键 ----------------
  window.addEventListener('keydown', (event) => {
    // 文字输入框自己处理 Esc / Enter，撤销也要留给原生的输入框历史
    if (event.target instanceof HTMLTextAreaElement) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) editor.redo();
      else editor.undo();
    } else if (mod && key === 'y') {
      event.preventDefault();
      editor.redo();
    } else if (mod && key === 'c' && byId.has('copy')) {
      event.preventDefault();
      byId.get('copy')?.click();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      editor.deleteSelected();
    } else if (event.key === 'Escape') {
      const target = byId.get('close') ?? byId.get('cancel');
      if (target) {
        event.preventDefault();
        target.click();
      }
    }
  });
}

function group(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'group';
  return el;
}

function rowEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'toolbar-row';
  return el;
}

function addDividers(groups: HTMLElement[]): void {
  groups.forEach((g, i) => {
    if (i > 0) g.firstElementChild?.classList.add('is-group-start');
  });
}

function button(text: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = text;
  // 宿主可能是拖拽区，按钮必须显式退出，否则点不动
  el.style.setProperty('-webkit-app-region', 'no-drag');
  el.style.setProperty('app-region', 'no-drag');
  return el;
}
