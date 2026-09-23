# 用到的 Electron 模块

本文列出项目实际引用的 Electron 模块、`webContents` 事件以及 Forge 构建配置。

| 模块                      | 用在哪                                            | 干什么                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app`                     | `src/main.ts`、`pin-window.ts`                    | `whenReady` 定启动顺序；`before-quit` / `will-quit` 收尾（注销快捷键、销毁托盘）；`window-all-closed` **不退出**（托盘常驻）；`getPath('pictures')` 作存盘默认目录                   |
| `BrowserWindow`           | `main.ts` / `overlay-window.ts` / `pin-window.ts` | 三类窗口：主窗口（`close` 只 hide）、每屏一个遮罩、贴图。另用 `getAllWindows()` 隐藏自家窗口避免被截进图里，`fromWebContents()` 反查窗口                                             |
| `Tray` + `Menu`           | `main-process/tray.ts`                            | 托盘图标用 `nativeImage.createFromBitmap` 从 BGRA 像素现场生成（**无资源文件**，也就没有打包路径问题）；左键 = 截图，右键弹菜单 —— Windows 不会自动弹，必须显式 `popUpContextMenu()` |
| `globalShortcut`          | `src/main.ts`                                     | `Ctrl+Shift+A` 全局截图；注册失败只告警、退回按钮/托盘；`will-quit` 里 `unregisterAll()`                                                                                             |
| `desktopCapturer`         | `main-process/capture.ts`                         | 抓屏：`getSources({ types: ['screen'], thumbnailSize })`；`thumbnailSize` **不保证被遵守**，一律回读 `thumbnail.getSize()` 反推比例                                                  |
| `screen`                  | `capture.ts` / `snip-session.ts`                  | `getAllDisplays()` 取屏列表与虚拟屏范围；`getCursorScreenPoint()` 是**光标唯一真相源**；`display-metrics-changed` / `display-removed` 触发取消会话                                   |
| `ipcMain` / `ipcRenderer` | `main-process/ipc.ts`、`preload.ts`               | 全部走 `handle` / `invoke`（请求-响应，没有裸 `send` 混用）；通道名只在 `shared/channels.ts`                                                                                         |
| `contextBridge`           | `src/preload.ts`                                  | 暴露 `window.api`，**三个窗口共用同一份** preload                                                                                                                                    |
| `clipboard`               | `main-process/pin-window.ts`                      | 复制 PNG：`clipboard.write([new ClipboardItem({ 'image/png': … })])`                                                                                                                 |
| `dialog`                  | `main-process/pin-window.ts`                      | `showSaveDialog`；可见的置顶窗口会**先降级再弹框**，否则对话框被自己盖住                                                                                                             |
| `nativeImage`             | `main-process/tray.ts`                            | `createFromBitmap` 生成 16×16 托盘图标                                                                                                                                               |

## webContents 事件

| 事件                  | 用在哪              | 为什么                                                                                                                                                      |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-input-event`  | `overlay-window.ts` | 在**主进程**拦 Esc / Enter：`preventDefault` 后渲染进程收不到，因此不会重复触发；渲染进程 JS 挂了也有效。文字输入框打开期间会主动让位（`session.editText`） |
| `console-message`     | `renderer-log.ts`   | 遮罩和贴图**没有 DevTools**，渲染进程的 console / 报错只能靠它转发到主进程日志                                                                              |
| `did-fail-load`       | `renderer-log.ts`   | 页面加载失败时记录错误码与 URL，便于排查窗口无内容显示的问题                                                                                                |
| `render-process-gone` | `pin-window.ts`     | 贴图渲染进程崩溃时打印 `reason` / `exitCode`                                                                                                                |
| `unresponsive`        | `pin-window.ts`     | 窗口无响应告警                                                                                                                                              |

`setContentProtection(true)` 用在遮罩窗口上，让本窗口不被别的截图工具（以及我们自己下一次）截进图里。

## Forge 侧配置

`forge.config.ts` 里两件事：

- **VitePlugin** —— 1 个 main 入口 + 1 个 preload 入口 + 3 个 renderer 入口（`main_window` / `overlay` / `pin`）。每个 renderer 必须显式指定自己的 HTML，否则会互相覆盖根目录的 `index.html`。
- **FusesPlugin** —— 关掉 `RunAsNode`、`NodeOptionsEnvironmentVariable`、`NodeCliInspectArguments`，打开 `EnableCookieEncryption`、`EnableEmbeddedAsarIntegrityValidation`、`OnlyLoadAppFromAsar`。

## 相关

- [架构与调用逻辑](architecture.md)
- [实现要点](implementation-notes.md)
