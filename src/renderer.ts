import './index.css';
import type { HistoryRetention } from './shared/types';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const hotkeyKbd = document.getElementById('hotkey-kbd') as HTMLElement;
const hotkeyBtn = document.getElementById('hotkey') as HTMLButtonElement;
const autostartInput = document.getElementById('autostart') as HTMLInputElement;
const savedirBtn = document.getElementById('savedir') as HTMLButtonElement;
const formatSelect = document.getElementById('format') as HTMLSelectElement;
const historyRetentionSelect = document.getElementById('history-retention') as HTMLSelectElement;
const glassTransparencyRow = document.getElementById('glass-transparency-row') as HTMLDivElement;
const glassTransparencyInput = document.getElementById('glass-transparency') as HTMLInputElement;
const glassTransparencyValue = document.getElementById('glass-transparency-value') as HTMLOutputElement;

let snipping = false;

const isMac = /mac/i.test(navigator.platform);
glassTransparencyRow.hidden = !isMac;

/** 透明度 → 网页层玻璃染色：透明度低 = 烟熏加深，高 = 白色高光更亮 */
function updateGlassTransparencyPreview(transparency: number): void {
  const normalized = Math.max(0, Math.min(100, Math.round(transparency)));
  const smoke = 1 - normalized / 100;
  const root = document.documentElement;
  root.style.setProperty('--glass-wash', `rgba(10, 18, 32, ${0.04 + smoke * 0.3})`);
  root.style.setProperty('--glass-highlight', `rgba(255, 255, 255, ${0.04 + (1 - smoke) * 0.22})`);
  glassTransparencyInput.style.setProperty('--range-progress', `${normalized}%`);
  glassTransparencyValue.value = `${normalized}%`;
}

/**
 * Electron accelerator → 平台原生写法：mac 用 ⌃⌥⇧⌘ 符号（Apple 顺序），
 * 其余平台原样（Ctrl+Shift+A）。修饰键大小写与别名（Super / Cmd /
 * CommandOrControl…）统一归一后映射。
 */
function formatAccelerator(acc: string): string {
  if (!isMac) return acc;
  const SYMBOL: Record<string, string> = {
    ctrl: '⌃',
    control: '⌃',
    alt: '⌥',
    option: '⌥',
    shift: '⇧',
    super: '⌘',
    cmd: '⌘',
    command: '⌘',
    commandorcontrol: '⌘',
    cmdorctrl: '⌘',
  };
  const ORDER = ['⌃', '⌥', '⇧', '⌘'];
  const tokens = acc.split('+');
  const key = tokens.pop() ?? '';
  const syms = [...new Set(tokens.map((m) => SYMBOL[m.toLowerCase()] ?? m))].sort(
    (a, b) => ORDER.indexOf(a) - ORDER.indexOf(b),
  );
  return syms.join('') + key;
}

/** 托盘的称呼：mac 在菜单栏，Windows 在任务栏托盘 */
function applyTrayHint(): void {
  const el = document.getElementById('tray-hint');
  if (el) el.textContent = isMac ? '菜单栏图标左键' : '托盘左键';
}

function status(msg: string): void {
  statusEl.textContent = msg;
}

window.api.app.state(({ snipping: next }) => {
  snipping = next;
  startBtn.disabled = next;
  startBtn.textContent = next ? '截图中…' : '开始截图';
  status(next ? '拖动鼠标框选，松开即完成；单击选整屏（Enter 确认），Esc 取消' : '');
});

startBtn.addEventListener('click', () => {
  if (snipping) return;
  void window.api.app.startSnip();
});

// ---------------------------------------------------------------- 设置

async function loadSettings(): Promise<void> {
  const s = await window.api.settings.get();
  hotkeyBtn.textContent = formatAccelerator(s.hotkey);
  hotkeyKbd.textContent = formatAccelerator(s.hotkey);
  autostartInput.checked = s.autoStart;
  savedirBtn.textContent = s.saveDir;
  savedirBtn.title = s.saveDir;
  formatSelect.value = s.saveFormat;
  historyRetentionSelect.value = s.historyRetention;
  glassTransparencyInput.value = String(s.glassTransparency);
  updateGlassTransparencyPreview(s.glassTransparency);
}

autostartInput.addEventListener('change', () => {
  void window.api.settings.set({ autoStart: autostartInput.checked });
});

formatSelect.addEventListener('change', () => {
  void window.api.settings.set({
    saveFormat: formatSelect.value as 'png' | 'jpg',
  });
});

historyRetentionSelect.addEventListener('change', () => {
  void window.api.settings
    .set({ historyRetention: historyRetentionSelect.value as HistoryRetention })
    .catch((err: unknown) => {
      status(err instanceof Error ? err.message : String(err));
      void loadSettings();
    });
});

// ------------------------------------------------------------- 最近截图

const recentSection = document.getElementById('recent') as HTMLDivElement;
const recentStrip = document.getElementById('recent-strip') as HTMLDivElement;
const openHistoryBtn = document.getElementById('open-history') as HTMLButtonElement;

/** 面板里展示的最近条数 —— 更多浏览走「查看全部」的历史窗口 */
const RECENT_COUNT = 4;

/**
 * 面板每次弹出（focus）都重拉一次：历史在会话外也会新增/淘汰。
 * 点缩略图 = 重钉；悬停角标 = 复制。贴图的新窗口会夺走面板焦点，
 * 面板按失焦约定自动收起 —— 动作已完成，收起是预期行为。
 */
async function refreshRecent(): Promise<void> {
  const entries = await window.api.history.boot();
  const recent = entries.slice(0, RECENT_COUNT);
  recentSection.hidden = recent.length === 0;
  recentStrip.replaceChildren(
    ...recent.map((entry) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'recent-thumb';
      cell.title = '贴到桌面';
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      void window.api.history.thumb(entry.id).then((url) => {
        img.src = url;
      });
      cell.append(img);
      const copy = document.createElement('span');
      copy.className = 'recent-copy';
      copy.textContent = '复制';
      copy.title = '复制到剪贴板';
      copy.addEventListener('click', (event) => {
        event.stopPropagation();
        void window.api.history.action({ kind: 'copy', id: entry.id });
      });
      cell.append(copy);
      cell.addEventListener('click', () => {
        void window.api.history.action({ kind: 'pin', id: entry.id });
      });
      return cell;
    }),
  );
}

openHistoryBtn.addEventListener('click', () => {
  void window.api.history.open();
});
window.addEventListener('focus', () => {
  void refreshRecent();
});
void refreshRecent();

glassTransparencyInput.addEventListener('input', () => {
  updateGlassTransparencyPreview(Number(glassTransparencyInput.value));
});

glassTransparencyInput.addEventListener('change', () => {
  void window.api.settings.set({ glassTransparency: Number(glassTransparencyInput.value) }).catch((err: unknown) => {
    status(err instanceof Error ? err.message : String(err));
    void loadSettings();
  });
});

savedirBtn.addEventListener('click', () => {
  void window.api.settings
    .pickDir()
    .then((dir) => {
      if (!dir) return;
      return window.api.settings.set({ saveDir: dir }).then(loadSettings);
    })
    .catch((err: unknown) => {
      status(err instanceof Error ? err.message : String(err));
    });
});

/** KeyboardEvent → Electron accelerator；不含修饰键返回 null */
function accelerator(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Super');
  if (e.shiftKey) parts.push('Shift');
  const named: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    ' ': 'Space',
    Plus: 'Plus',
    Minus: '-',
  };
  let key: string | null = null;
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (/^[0-9]$/.test(e.key)) key = e.key;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if (e.key in named) key = named[e.key];
  if (!key) return null;
  parts.push(key);
  // 全局快捷键必须有修饰键，裸键注册不了
  return parts.length > 1 ? parts.join('+') : null;
}

// Esc 收起 HUD 面板（window.close 会走主进程 close → hide）。
// 快捷键录制模式的 Esc 在捕获阶段 stopPropagation，不会漏到这里误关面板。
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

hotkeyBtn.addEventListener('click', () => {
  if (hotkeyBtn.classList.contains('listening')) return;
  const old = hotkeyBtn.textContent ?? '';
  hotkeyBtn.textContent = '按下新快捷键…';
  hotkeyBtn.classList.add('listening');
  status(isMac ? '按下组合键（需含 ⌘ / ⌃ / ⌥），Esc 取消' : '按下组合键（需含 Ctrl / Alt / Win），Esc 取消');

  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cleanup();
      return;
    }
    const acc = accelerator(e);
    if (!acc) {
      status(isMac ? '需包含 ⌘ / ⌃ / ⌥ 修饰键' : '需包含 Ctrl / Alt / Win 修饰键');
      return;
    }
    cleanup();
    void window.api.settings
      .set({ hotkey: acc })
      .then((s) => {
        hotkeyBtn.textContent = formatAccelerator(s.hotkey);
        hotkeyKbd.textContent = formatAccelerator(s.hotkey);
        status('');
      })
      .catch((err: unknown) => {
        hotkeyBtn.textContent = old;
        hotkeyKbd.textContent = old;
        status(err instanceof Error ? err.message : String(err));
      });
  };
  const cleanup = (): void => {
    window.removeEventListener('keydown', onKey, true);
    hotkeyBtn.classList.remove('listening');
    if (hotkeyBtn.textContent === '按下新快捷键…') hotkeyBtn.textContent = old;
    status('');
  };
  window.addEventListener('keydown', onKey, true);
});

applyTrayHint();
void loadSettings();
