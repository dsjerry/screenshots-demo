import path from 'node:path';
import { Menu, Tray, nativeImage, app } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';

/**
 * 托盘图标：
 * - macOS：菜单栏用**模板图标**（HIG 规范）—— 代码绘制的单色「取景框 +
 *   中心点」字形（呼应应用标识），setTemplateImage 交由系统按菜单栏外观
 *   （深/浅色、高亮）着色，无任何资源依赖；
 * - 其他平台：任务栏惯例是彩色图标，直接用应用图标 app.png 缩放（extra-
 *   Resource 随包分发，dev 走仓库路径），附 2x 表示供 hiDPI 取用。
 * 图标文件缺失 / 损坏时回退到代码绘制的位图（buildTrayImage）——
 * 空托盘图标等于看不见应用。
 */
function trayIconImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    const img = buildTemplateGlyph(1);
    img.addRepresentation({ scaleFactor: 2, buffer: buildTemplateGlyph(2).toPNG() });
    img.setTemplateImage(true);
    return img;
  }
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'app.png')
    : path.join(app.getAppPath(), 'resources', 'icons', 'app.png');
  const source = nativeImage.createFromPath(p);
  if (source.isEmpty()) return buildTrayImage();
  const img = source.resize({ width: 16, height: 16 });
  img.addRepresentation({
    scaleFactor: 2,
    buffer: source.resize({ width: 32, height: 32 }).toPNG(),
  });
  return img;
}

/**
 * mac 模板字形：**相框 + 太阳 + 山形**（图片隐喻，macOS 照片风格），白像素
 * + 透明底（模板图只取 alpha 通道，颜色由系统定）。具象剪影在 16px 下比
 * 抽象线条可读得多。用 16 网格谓词绘制，scale=2 时按同一谓词输出 hiDPI。
 */
function buildTemplateGlyph(scale: 1 | 2): Electron.NativeImage {
  const size = 16 * scale;
  const buf = Buffer.alloc(size * size * 4);
  const inside = (px: number, py: number): boolean => {
    // 像素中心映射回 16 网格
    const x = (px + 0.5) / scale;
    const y = (py + 0.5) / scale;
    const inOuter = x >= 1 && x < 15 && y >= 2 && y < 14;
    const inInner = x >= 3 && x < 13 && y >= 4 && y < 12;
    if (inOuter && !inInner) return true; // 相框（2px 描边）
    if (!inInner) return false;
    if (x >= 10 && x < 12 && y >= 5 && y < 7) return true; // 太阳
    // 山形：两条斜边围成的三角形，底边贴内框下沿
    if (y >= 5) {
      const lx = 3 + (12 - y) * (5 / 7);
      const rx = 8 + (y - 5) * (5 / 7);
      if (x >= lx && x <= rx) return true;
    }
    return false;
  };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      if (inside(px, py)) {
        buf[i] = 255;
        buf[i + 1] = 255;
        buf[i + 2] = 255;
        buf[i + 3] = 255;
      } else {
        buf[i + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/**
 * 16×16 内联图标：用 createFromBitmap 直接从 BGRA 像素生成，
 * 不需要任何资源文件（也就不存在打包路径问题）。
 * 图案是白框取景器 + 四向微光，底色 #2F6FED —— 现在只作托盘图标
 * 文件缺失时的兜底。
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
        (x < 2 && y < 2) || (x > size - 3 && y < 2) || (x < 2 && y > size - 3) || (x > size - 3 && y > size - 3);
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
  // 中心微光
  mark(7, 7);
  mark(7, 6);
  mark(8, 7);
  mark(7, 8);
  mark(6, 7);

  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export interface TrayCallbacks {
  onSnip(): void;
  /** 延迟 N 毫秒后触发截图 */
  onSnipDelay(ms: number): void;
  onShowMain(): void;
  /** 托盘左键：主窗口显示 / 隐藏开关 */
  onToggleMain(): void;
  onHistory(): void;
  /** 全部贴图恢复鼠标（解除点击穿透） */
  onRestorePins(): void;
  /** 收起（关闭）全部贴图 */
  onCloseAllPins(): void;
  /** 显示「关于」窗口 */
  onAbout(): void;
  getMainWindow(): BrowserWindow | null;
}

let tray: Tray | null = null;

export function createTray(cb: TrayCallbacks): Tray {
  tray?.destroy();
  tray = new Tray(trayIconImage());
  tray.setToolTip('截图工具');

  const menu = Menu.buildFromTemplate([
    { label: '截图', click: () => cb.onSnip() },
    { label: '5 秒后截图', click: () => cb.onSnipDelay(5000) },
    { type: 'separator' },
    { label: '截图历史', click: () => cb.onHistory() },
    { label: '收起全部贴图', click: () => cb.onCloseAllPins() },
    { label: '恢复贴图鼠标', click: () => cb.onRestorePins() },
    { type: 'separator' },
    { label: '显示主窗口', click: () => cb.onShowMain() },
    { label: '关于截图工具', click: () => cb.onAbout() },
    {
      label: '退出',
      click: () => {
        cb.getMainWindow()?.destroy();
        app.quit();
      },
    },
  ]);

  // 左键 = 主窗口显示 / 隐藏开关（两平台一致）；截图走快捷键 / 右键菜单
  tray.on('click', () => cb.onToggleMain());
  // Windows 不会自动弹右键菜单，必须显式调用
  tray.on('right-click', () => {
    tray?.popUpContextMenu(menu);
  });

  return tray;
}

/** 托盘图标的屏幕位置（主窗口 HUD 定位用）；托盘未创建时返回 null。 */
export function getTrayBounds(): Rectangle | null {
  return tray?.getBounds() ?? null;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
