import './index.css';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;
const hotkeyKbd = document.getElementById('hotkey-kbd') as HTMLElement;
const hotkeyBtn = document.getElementById('hotkey') as HTMLButtonElement;
const autostartInput = document.getElementById(
  'autostart',
) as HTMLInputElement;
const savedirBtn = document.getElementById('savedir') as HTMLButtonElement;
const formatSelect = document.getElementById('format') as HTMLSelectElement;

let snipping = false;

function status(msg: string): void {
  statusEl.textContent = msg;
}

window.api.app.state(({ snipping: next }) => {
  snipping = next;
  startBtn.disabled = next;
  startBtn.textContent = next ? '截图中…' : '开始截图';
  status(
    next ? '拖动鼠标框选，松开即完成；单击选整屏（Enter 确认），Esc 取消' : '',
  );
});

startBtn.addEventListener('click', () => {
  if (snipping) return;
  void window.api.app.startSnip();
});

// ---------------------------------------------------------------- 设置

async function loadSettings(): Promise<void> {
  const s = await window.api.settings.get();
  hotkeyBtn.textContent = s.hotkey;
  hotkeyKbd.textContent = s.hotkey;
  autostartInput.checked = s.autoStart;
  savedirBtn.textContent = s.saveDir;
  savedirBtn.title = s.saveDir;
  formatSelect.value = s.saveFormat;
}

autostartInput.addEventListener('change', () => {
  void window.api.settings.set({ autoStart: autostartInput.checked });
});

formatSelect.addEventListener('change', () => {
  void window.api.settings.set({
    saveFormat: formatSelect.value as 'png' | 'jpg',
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

hotkeyBtn.addEventListener('click', () => {
  if (hotkeyBtn.classList.contains('listening')) return;
  const old = hotkeyBtn.textContent ?? '';
  hotkeyBtn.textContent = '按下新快捷键…';
  hotkeyBtn.classList.add('listening');
  status('按下组合键（需含 Ctrl / Alt / Win），Esc 取消');

  const onKey = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      cleanup();
      return;
    }
    const acc = accelerator(e);
    if (!acc) {
      status('需包含 Ctrl / Alt / Win 修饰键');
      return;
    }
    cleanup();
    void window.api.settings
      .set({ hotkey: acc })
      .then((s) => {
        hotkeyBtn.textContent = s.hotkey;
        hotkeyKbd.textContent = s.hotkey;
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

void loadSettings();
