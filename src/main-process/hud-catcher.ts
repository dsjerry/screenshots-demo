import { BrowserWindow, screen } from 'electron';

/**
 * HUD 面板打开期间的「点击盾」：每块屏一个隐身罩（workArea 范围、层级
 * pop-up-menu=101 —— 低于面板的 screen-saver=1000，高于普通窗口与程序坞），
 * 吃掉面板外的所有点击。没有它，点击会落到墙纸，触发 macOS Sequoia+ 的
 * 「点按墙纸以显示桌面」，把所有窗口掀开（用户视角 = Win 的显示桌面）。
 *
 * 关键坑：盾**不能**用 transparent:true —— macOS 上透明窗口的完全透明像素
 * 既不透传、也不向窗口派发鼠标事件（electron#1335，官方文档「You cannot
 * click through the transparent area」的另一面），点击会直接蒸发。所以盾
 * 用不透明窗口 + 窗口级 setOpacity(0.01) 隐身，像素必然接收点击。
 *
 * 盾可聚焦：点击盾 → 盾拿走 key → 面板 blur → hideMainWindow（双保险之二，
 * blur 收起路径）。语义与 NSPopover 一致：面板打开期间点其他应用窗口只
 * 收起面板、不穿透；菜单栏不在 workArea 内，不受影响。仅 darwin 启用。
 */
let catchers: BrowserWindow[] = [];

/** 面板收起回调，由 main.ts 注入（避免与主入口循环依赖）。 */
let dismiss: () => void = () => {};

export function setHudDismissCallback(fn: () => void): void {
  dismiss = fn;
}

export function showHudCatchers(): void {
  if (process.platform !== 'darwin') return;
  hideHudCatchers();
  for (const d of screen.getAllDisplays()) {
    const wa = d.workArea;
    const catcher = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: wa.width,
      height: wa.height,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#000000',
    });
    catcher.setAlwaysOnTop(true, 'pop-up-menu');
    catcher.setOpacity(0.01);
    catcher.setContentProtection(true);
    catcher.once('ready-to-show', () => {
      if (!catcher.isDestroyed()) catcher.showInactive();
    });
    // 点击盾 → 盾拿走 key → 本事件 → 收起面板（面板自己的 blur 也会触发，幂等）
    catcher.on('focus', () => dismiss());
    catcher.on('close', (event) => {
      event.preventDefault();
      dismiss();
    });
    catcher.on('closed', () => {
      catchers = catchers.filter((c) => c !== catcher);
    });
    catchers.push(catcher);
  }
}

/** 用 destroy 而非 close：不触发 close / focus 事件，不会递归调用 dismiss。 */
export function hideHudCatchers(): void {
  for (const c of catchers) {
    if (!c.isDestroyed()) c.destroy();
  }
  catchers = [];
}
