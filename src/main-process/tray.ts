import { Menu, Tray, nativeImage, app } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * 16×16 内联图标：用 createFromBitmap 直接从 BGRA 像素生成，
 * 不需要任何资源文件（也就不存在打包路径问题）。
 * 图案是白框取景器 + 中心白点，底色 #2F6FED。
 */
function buildTrayImage() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const set = (x: number, y: number, b: number, g: number, r: number, a = 255) => {
    const i = (y * size + x) * 4;
    buf[i] = b;
    buf[i + 1] = g;
    buf[i + 2] = r;
    buf[i + 3] = a;
  };
  const BG = [237, 111, 47] as const; // #2F6FED -> B,G,R
  const WHITE = [255, 255, 255] as const;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 四角切出 2px 圆角
      const corner =
        (x < 2 && y < 2) ||
        (x > size - 3 && y < 2) ||
        (x < 2 && y > size - 3) ||
        (x > size - 3 && y > size - 3);
      if (corner) set(x, y, 0, 0, 0, 0);
      else set(x, y, BG[0], BG[1], BG[2]);
    }
  }

  const mark = (x: number, y: number) => set(x, y, WHITE[0], WHITE[1], WHITE[2]);
  // 左上
  for (let i = 0; i < 4; i++) {
    mark(3 + i, 3);
    mark(3, 3 + i);
    mark(12 - i, 12);
    mark(12, 12 - i);
    mark(12 - i, 3);
    mark(12, 3 + i);
    mark(3 + i, 12);
    mark(3, 12 - i);
  }
  // 中心点
  for (let y = 7; y <= 8; y++) for (let x = 7; x <= 8; x++) mark(x, y);

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export interface TrayCallbacks {
  onSnip(): void;
  onShowMain(): void;
  getMainWindow(): BrowserWindow | null;
}

let tray: Tray | null = null;

export function createTray(cb: TrayCallbacks): Tray {
  tray?.destroy();
  tray = new Tray(buildTrayImage());
  tray.setToolTip('截图工具');

  const menu = Menu.buildFromTemplate([
    { label: '截图', click: () => cb.onSnip() },
    { label: '显示主窗口', click: () => cb.onShowMain() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        cb.getMainWindow()?.destroy();
        app.quit();
      },
    },
  ]);

  tray.on('click', () => cb.onSnip());
  // Windows 不会自动弹右键菜单，必须显式调用
  tray.on('right-click', () => {
    tray?.popUpContextMenu(menu);
  });

  return tray;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
