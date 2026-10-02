import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 应用设置（settings.json 存在 userData 下）。
 * 主进程持有真相并负责落地；渲染进程（主窗口设置页）经 settings:get/set 读写。
 */
export interface AppSettings {
  /** 全局截图快捷键（Electron accelerator 字符串） */
  hotkey: string;
  /** 开机自启 */
  autoStart: boolean;
  /** 保存目录 */
  saveDir: string;
  /** 默认保存格式 */
  saveFormat: 'png' | 'jpg';
}

const DEFAULTS: AppSettings = {
  hotkey: 'Ctrl+Shift+A',
  autoStart: false,
  saveDir: app.getPath('pictures'),
  saveFormat: 'png',
};

let cached: AppSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function getSettings(): Promise<AppSettings> {
  if (cached) return cached;
  let loaded: Partial<AppSettings> = {};
  try {
    loaded = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
  } catch {
    // 首次运行 / 文件损坏：回落默认值
  }
  cached = { ...DEFAULTS, ...loaded };
  return cached;
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch };
  cached = next;
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  if (patch.autoStart !== undefined) {
    // 与设置保持同步（托盘常驻应用不自启窗口）
    app.setLoginItemSettings({ openAtLogin: next.autoStart });
  }
  return next;
}
