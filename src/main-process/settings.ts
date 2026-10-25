import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoryRetention } from '../shared/types';

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
  /** macOS Liquid Glass 染色强度（0-100；越高越不透明） */
  glassStrength: number;
  /** 截图历史保留策略（默认仅会话内） */
  historyRetention: HistoryRetention;
}

const DEFAULTS: AppSettings = {
  hotkey: 'Ctrl+Shift+A',
  autoStart: false,
  saveDir: app.getPath('pictures'),
  saveFormat: 'png',
  glassStrength: 35,
  historyRetention: 'session',
};

const RETENTIONS: readonly HistoryRetention[] = ['off', 'session', 'persistent'];

function normalizeGlassStrength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS.glassStrength;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function normalizeRetention(value: unknown): HistoryRetention {
  return RETENTIONS.includes(value as HistoryRetention)
    ? (value as HistoryRetention)
    : DEFAULTS.historyRetention;
}

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
  cached = {
    ...DEFAULTS,
    ...loaded,
    glassStrength: normalizeGlassStrength(loaded.glassStrength),
    historyRetention: normalizeRetention(loaded.historyRetention),
  };
  return cached;
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getSettings()), ...patch };
  next.glassStrength = normalizeGlassStrength(next.glassStrength);
  next.historyRetention = normalizeRetention(next.historyRetention);
  cached = next;
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  if (patch.autoStart !== undefined) {
    // 与设置保持同步（托盘常驻应用不自启窗口）
    app.setLoginItemSettings({ openAtLogin: next.autoStart });
  }
  return next;
}
