import './index.css';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const hotkeyKbd = document.getElementById('hotkey-kbd') as HTMLElement;
const hotkeyBtn = document.getElementById('hotkey') as HTMLButtonElement;
const autostartInput = document.getElementById('autostart') as HTMLInputElement;
const savedirBtn = document.getElementById('savedir') as HTMLButtonElement;
const formatSelect = document.getElementById('format') as HTMLSelectElement;
const glassStrengthRow = document.getElementById('glass-strength-row') as HTMLDivElement;
const glassStrengthInput = document.getElementById('glass-strength') as HTMLInputElement;
const glassStrengthValue = document.getElementById('glass-strength-value') as HTMLOutputElement;

let snipping = false;

const isMac = /mac/i.test(navigator.platform);
glassStrengthRow.hidden = !isMac;

function updateGlassStrengthPreview(strength: number): void {
  const normalized = Math.max(0, Math.min(100, Math.round(strength)));
  const amount = normalized / 100;
  const root = document.documentElement;
  root.style.setProperty('--glass-wash', `rgba(255, 255, 255, ${0.02 + amount * 0.2})`);
  root.style.setProperty('--glass-highlight', `rgba(255, 255, 255, ${0.04 + amount * 0.26})`);
  glassStrengthInput.style.setProperty('--range-progress', `${normalized}%`);
  glassStrengthValue.value = `${normalized}%`;
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
  glassStrengthInput.value = String(s.glassStrength);
  updateGlassStrengthPreview(s.glassStrength);
}

autostartInput.addEventListener('change', () => {
  void window.api.settings.set({ autoStart: autostartInput.checked });
});

formatSelect.addEventListener('change', () => {
  void window.api.settings.set({
    saveFormat: formatSelect.value as 'png' | 'jpg',
  });
});

glassStrengthInput.addEventListener('input', () => {
  updateGlassStrengthPreview(Number(glassStrengthInput.value));
});

glassStrengthInput.addEventListener('change', () => {
  void window.api.settings.set({ glassStrength: Number(glassStrengthInput.value) }).catch((err: unknown) => {
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
