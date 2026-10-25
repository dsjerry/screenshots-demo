# 校验

默认跑 `npm run typecheck`（`tsc --noEmit`，覆盖 `src/**` + `forge.config.ts` + `vite.*.config.ts`，约 7s）。
仅当改动完全属于下列白名单时方可跳过；无法判断时一律执行。

## 可跳过校验的情形

纯注释 / 文档 / UI 文案 / CSS / 常量数值，且不新增、不删除、不改任何 `.ts` 签名。

## 必须执行 typecheck 的情形

- 动了 `src/shared/`（`types.ts` / `channels.ts` / `api.ts` / `pin-layout.ts`）
- 动了 `src/global.d.ts`、`forge.config.ts`、`vite.*.config.ts`、`forge.env.d.ts`
- 新增 / 删除 / 重命名文件，或改了函数签名、IPC payload
- 加新的 renderer 入口

## 打包校验的适用时机

只有改动影响「怎么被打包」时才跑 `npm run package`：preload 路径、HTML 入口、资源文件、forge/vite 配置、
新增含原生二进制的运行时依赖。
`npm run make` 不用于日常验证，且**不能与 `npm start` 并发**（dev watcher 会 fs.watch `out/`，Windows 上 EBUSY 直接把 Forge 打崩）。

# 项目速览

Electron + TypeScript + Vite（Forge 插件）的跨屏截图工具，托盘常驻、多窗口架构：
一个 preload + 五个渲染入口 —— `main`（HUD 控制面板）/ `overlay`（每屏一个截图遮罩）/ `pin`（贴图）/
`scroll`（长图控制条）/ `history`（历史窗口）。标注引擎（`src/annotations/`）在遮罩 / 贴图间复用；
类型与 IPC 通道契约集中在 `src/shared/`。
深度文档在 `docs/`（`architecture.md` / `electron-api.md` / `macos-permission.md`），改动前先查对应篇目。

# 不变量（违反即出 bug，改动前先读）

- **抓屏时序**：`desktopCapturer` 抓屏必须发生在自家窗口隐藏之后、遮罩窗口显示之前 —— 顺序错了要么把自己截进去、要么抓到半透明残影（macOS 移除窗口还有淡出动画）。
- **内容保护**：遮罩、HUD 面板、点击盾一律 `setContentProtection(true)`，永不进任何截图（含第三方截图工具）。
- **mac 窗口几何**：全屏遮罩必须 `enableLargerThanScreen: true` —— 否则 AppKit 在窗口首次上屏时把它钳进工作区（菜单栏以下），菜单栏区域无法框选（`docs/macos-permission.md` 有 CGWindowList 探针排查法）。
- **mac 权限归属**：dev 模式的屏幕录制权限归属「启动应用的终端」（responsible process），不是 Electron 二进制 —— 排障先看进程树顶端，详见 `docs/macos-permission.md`。
- **玻璃材质互斥**：mac 的 `electron-liquid-glass`（原生 `NSGlassEffectView`）与 `vibrancy` 不能同时启用；`transparent: true` 的窗口 `backgroundColor` 必须全透明、CSS 页面背景必须半透明，否则玻璃不可见。
- **IPC 三处同步**：新增通道 = `shared/channels.ts` + `preload.ts` + `global.d.ts` 三处一致，改完必跑 typecheck。
- **主窗口 HUD 语义**：启动不显示；托盘左键开关、点击面板外收起（点击盾实现）、Esc 收起。收起路径全部汇入 `hideMainWindow`，改动收起逻辑时三条都要过一遍。

# 常用脚本

| 命令                                    | 用途                                              |
| --------------------------------------- | ------------------------------------------------- |
| `npm start`                             | 开发模式（Forge + Vite 热更新）                   |
| `npm run typecheck` / `lint` / `format` | 校验三件套                                        |
| `npm run package`                       | 打包免安装目录 `out/`（仅在影响打包时跑）         |
| `npm run make`                          | 安装包（Windows Squirrel；不与 `npm start` 并发） |

# 其他约定

- 提交信息：Conventional Commits 中文风格（`feat:` / `fix:` / `perf:` / `docs:` …），一句话说清「做了什么 + 为什么」。
- 首次 `npm install` 后需批准 get-windows 的安装脚本：`npm install-scripts approve get-windows && npm rebuild get-windows`。
- 平台分支集中在主进程（`process.platform`）；渲染端需要平台时用 `navigator.platform`。
