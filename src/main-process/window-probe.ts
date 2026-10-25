import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import type { Rect } from '../shared/types';

/**
 * macOS 窗口探针（resources/window-probe，ObjC 小工具）与「前台应用名」。
 * 探针按 z 序给出在屏普通窗口的 bounds / PID / owner 名，零 TCC 授权；
 * Windows 侧沿用 get-windows（ESM-only，动态 import）。
 */

export interface ProbeWindow {
  pid: number;
  /** owner 应用名（历史条目的「来源应用」） */
  app?: string;
  /** 全局「点」＝ mac 的 DIP */
  rect: Rect;
}

let getWindowsModule: typeof import('get-windows') | null = null;

function windowProbePath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'window-probe')
    : path.join(app.getAppPath(), 'resources', 'window-probe');
}

function runProbe(excludePid: number): Promise<ProbeWindow[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(windowProbePath(), ['--exclude-pid', String(excludePid)]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('窗口探针超时'));
    }, 2000);
    p.stdout.on('data', (d: Buffer) => {
      out += String(d);
    });
    p.stderr.on('data', (d: Buffer) => {
      err += String(d);
    });
    p.on('error', reject);
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `窗口探针退出码 ${code}`));
        return;
      }
      try {
        const list = JSON.parse(out) as {
          pid: number;
          app?: string;
          x: number;
          y: number;
          w: number;
          h: number;
        }[];
        resolve(
          list.map((w) => ({
            pid: w.pid,
            app: w.app,
            rect: { x: w.x, y: w.y, width: w.w, height: w.h },
          })),
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/** mac：按 z 序的在屏普通窗口（已排除 excludePid），坐标即 DIP */
export async function probeWindows(excludePid: number): Promise<ProbeWindow[]> {
  return runProbe(excludePid);
}

/**
 * 采录「来源应用」：z 序最前的非自家窗口的 owner 名。
 * mac 走探针（自家 PID 已排除，第一条即最前）；win 的 activeWindow 此时
 * 多半是自家遮罩，所以也从 openWindows 的 z 序里跳过自家 PID 取第一条。
 * 失败不算错 —— 来源应用是锦上添花。
 */
export async function frontAppName(): Promise<string | undefined> {
  try {
    if (process.platform === 'darwin') {
      const wins = await runProbe(process.pid);
      return wins.find((w) => w.app)?.app;
    }
    if (!getWindowsModule) getWindowsModule = await import('get-windows');
    const wins = await getWindowsModule.openWindows();
    const mine = wins.find((w) => w.owner.processId !== process.pid);
    return mine?.owner.name || undefined;
  } catch {
    return undefined;
  }
}
