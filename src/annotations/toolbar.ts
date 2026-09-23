import type { Editor } from './editor';
import type { ToolId } from '../shared/types';
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

const IDLE_HIDE_MS = 2500;

/** 追加在「撤销 / 重做 / 清空」之后的动作按钮，由宿主提供。 */
export interface ToolbarAction {
  id: string;
  label: string;
  /** 危险色（关闭 / 取消） */
  danger?: boolean;
  /** 初始高亮（置顶开着） */
  active?: boolean;
  run(btn: HTMLButtonElement): void | Promise<void>;
}

export interface ToolbarOptions {
  /** 宿主动作：只有遮罩在用（钉住 / 复制 / 保存 / 取消） */
  actions?: ToolbarAction[];
  /** 主轴方向：横条（row，选区下方）或竖条（col） */
  orient?: 'col' | 'row';
  /** 闲置 2.5s 淡出。遮罩的条随选区显隐，所以传 false 关掉 */
  idleHide?: boolean;
}

/**
 * 标注工具条 —— 两个宿主共用一套（目前只有截图遮罩在用；钉图钉住之后
 * 是只读贴图，只剩一个关闭按钮）。
 *
 * 工具 / 色块 / 线宽 / 历史四组是固定的，动作组由宿主注入。
 * 快捷键里 `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` / `Delete` 恒定生效；
 * `Ctrl+C`、`Esc` **按有没有对应动作决定**（有对应动作才接管；`Esc` 在遮罩里
 * 另有主进程的 before-input-event 兜底）。
 */
export function createToolbar(
  container: HTMLElement,
  editor: Editor,
  opts: ToolbarOptions = {},
): void {
  container.replaceChildren();
  container.dataset.orient = opts.orient ?? 'col';

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
    if (spec.active) btn.classList.add('is-active');
    btn.addEventListener('click', () => void spec.run(btn));
    actions.append(btn);
    byId.set(spec.id, btn);
  }
  const groups = [tools, colors, widths, history];
  if (extras.length > 0) groups.push(actions);
  container.append(...groups);

  // 条带/横条都用 display:contents 把四组展平，让按钮直接参与主轴排布；
  // 分隔线没有容器可挂，改画在每组第一个按钮上（第一组不留线）。
  groups.forEach((g, i) => {
    if (i > 0) g.firstElementChild?.classList.add('is-group-start');
  });

  function syncActive(): void {
    container.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.tool === editor.currentTool);
    });
    container.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.color === editor.colorValue);
    });
    container.querySelectorAll<HTMLButtonElement>('[data-width]').forEach((b) => {
      b.classList.toggle(
        'is-active',
        Number(b.dataset.width) === editor.widthValue,
      );
    });
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

  // ---------------- 闲置淡出 ----------------
  if (opts.idleHide !== false) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = () => {
      container.classList.remove('is-hidden');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // 指针还停在条带上就不淡出 —— 否则找按钮要先晃一下鼠标
        if (container.matches(':hover')) return;
        container.classList.add('is-hidden');
      }, IDLE_HIDE_MS);
    };
    window.addEventListener('pointermove', show, { passive: true });
    show();
  }
}

function group(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'group';
  return el;
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

