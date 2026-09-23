import type { BrowserWindow } from 'electron';

/**
 * 把渲染进程的 console / 加载失败转发到主进程日志。
 *
 * 开发时遮罩和钉图窗口没有 DevTools，出问题只能靠这里定位。
 */
export function forwardRendererLogs(win: BrowserWindow, tag: string): void {
  win.webContents.on('console-message', (details) => {
    const { level, message, lineNumber, sourceId } = details;
    if (level === 'debug') return;
    console.log(`[${tag}:${level}] ${message} (${sourceId}:${lineNumber})`);
  });
  win.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        `[${tag}] 页面加载失败 ${errorCode} ${errorDescription} ${validatedURL}`,
      );
    },
  );
}
