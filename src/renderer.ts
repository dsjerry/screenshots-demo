import './index.css';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;

let snipping = false;

window.api.app.state(({ snipping: next }) => {
  snipping = next;
  startBtn.disabled = next;
  startBtn.textContent = next ? '截图中…' : '开始截图';
  statusEl.textContent = next
    ? '拖动鼠标框选，松开即完成；单击选整屏（Enter 确认），Esc 取消'
    : '';
});

startBtn.addEventListener('click', () => {
  if (snipping) return;
  void window.api.app.startSnip();
});
