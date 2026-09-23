@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Electron 跨屏截图工具：框选截图（可跨屏）→ **在原图上标注**（选区阶段）→ 钉住成只读的置顶贴图 / 复制 / 保存。Electron Forge + Vite + 原生 TypeScript，**无 UI 框架**，界面文案为中文。

## 相关文档

- `README.md` — 功能与使用方式（简介），详细内容都在 `docs/`
- `docs/architecture.md` — 文件结构、窗口与进程关系、启动流程、一次截图调用链、选区阶段状态机（含 mermaid 图）、IPC 通道方向
- `docs/electron-api.md` — 用到的 Electron 模块与 `webContents` 事件、Forge 的 Vite/Fuses 配置
- `AGENTS.md` — 校验规则：默认跑 `typecheck`，只有纯注释/文档/文案/CSS/常量这类白名单改动才跳过；动到类型面或构建面必须跑，打包校验只在影响打包方式时才做

## 分支与提交

分支遵循 Gitlab Flow：`master`（主干）→ `release/*` → `develop/*` → `develop/*/<name>`（个人分支），合并回上一级用 `--no-ff`。

commit message 格式 `<type>: <中文描述>`（type 取 `feat`/`fix`/`docs`/`style`/`refactor`/`perf`/`test`/`chore`）：

- 标题与正文**全部用中文**，标题不以句号结尾、不超过 72 字符
- 正文用 `-` 开头的列表，与标题空一行
- **禁止署名 trailer**（`Co-Authored-By`、`Generated with` 等一律不加）

## Commands

```bash
npm start        # electron-forge dev（主进程 + 三个 renderer HMR）
npm run typecheck
npm run lint
npm run package  # 免安装目录 → out/screenshots-win32-x64
npm run make     # 安装包（Windows 走 Squirrel）
```

- 没有测试框架：验证 = `typecheck` + `lint` + 手动跑。**什么时候必须跑、什么时候可以跳过，以 `AGENTS.md` 为准**（默认跑，白名单才跳过）。
- `npm start` 与 `npm run package` / `make` **不能并发**：`make` 写 `out/` 时 dev 的 Vite watcher 会去 `fs.watch`，Windows 上报 EBUSY 直接把 Forge 打崩；`make` 本身也会因为 Electron 进程占着 `ffmpeg.dll` 失败。
- 三份 renderer config 里的 `server.watch.ignored`（`out/`、`dist/`）即为满足上述约束而设，不得移除。
- 依赖有上限，升级会撞 Forge 插件的 peer 约束：`typescript@5`、`eslint@8`、`vite@5`、`@electron/fuses@1`。

## Architecture

### 窗口与进程

主进程 + 三个 renderer：`index.html`（主窗口）、`overlay.html`（**每块屏一个**遮罩窗口）、`pin.html`（钉图），外加托盘。

标注引擎在 `src/annotations/`（`editor.ts` / `shapes.ts` / `toolbar.ts`），**目前只有遮罩在用**（钉图钉住后是只读贴图）。宿主注入坐标空间（`coords`）、重绘入口（`repaint` 必填，编辑器只管标注层）、文字输入框回调；工具条的动作组也由宿主给。

三者共用**同一份** `src/preload.ts`（构建产物 `preload.js` 与 `main.js` 同在 `.vite/build/` —— window 的 preload 路径是 `path.join(__dirname, 'preload.js')`，写成 `../preload.js` 会静默导致 `window.api` 不存在）。全部 `contextIsolation: true`、`nodeIntegration: false`。

`window.api` 的形状只定义在 `src/shared/api.ts`，由 `src/global.d.ts` 挂到 `Window` 上。

### 截图会话 = 主进程单例状态机

核心是 `src/main-process/snip-session.ts`：全局唯一 `session`，`phase: 'selecting' | 'adjusting' | 'confirming'`（类型在 `shared/types.ts` 的 `SnipPhase`），**选区状态只存在主进程**（虚拟屏 DIP 坐标，可为负）。

1. `beginSnip()`：先隐藏自家窗口再**抓屏**（每块屏的抓屏必须早于其遮罩窗口创建，且遮罩需 `setContentProtection(true)`，以避免将本应用窗口截入画面）。**光标所在屏优先完成**，其余屏与之并行抓取、就绪一块即显示一块 —— 第一个 `overlay:ready` 的窗口立即 `show()` 并获得焦点，不等待全部就绪（`READY_TIMEOUT_MS` 2.5s 仅约束首屏）。遮罩窗口按 `displayId` **缓存复用**（`acquireOverlay` → `reload()` 而非重建），收起时只 `hide()` + 发 `overlay:teardown` 释放位图。
2. 输入先在遮罩里分流：**手型工具、或按下点不在选区内 → 转主进程**（`stopImmediatePropagation`，编辑器收不到），绘图工具且在选区内 → 编辑器画标注；判定用 `shared/selection.ts`（手柄 / 整体移动 / 重新框选，误点还原旧选区）。转给主进程的部分以 `screen.getCursorScreenPoint()` 为真相源（16ms 轮询，`up` 那帧补算）。**松手不直接完成** —— `finishDrag` 把 `phase` 置为 `adjusting`，出 8 向手柄，**同时选区下方浮出工具条**（宿主 = 选区中心所在屏，`toolbarDisplayId`），此时选区大小/位置可实时调。Esc / Enter 走 `before-input-event`（渲染进程收不到、不会重复触发），但**文字输入框开合期间让位**（`session.editText`，来自 `overlay:editState`）。
3. **没有「确定」环节**，调整阶段的工具条只有三条出路：
   - **`钉住`** → `confirmSnip()`：先等待 `pendingRest`（其余屏抓取，最多 2.5s —— 否则拼接结果中该屏对应的区域为空）→ 算贴图布局（图像 + **四边阴影留白**）→ 建 pin 窗口（`transparent: true`、`hasShadow: false`）→ 等 `pin:ready`（8s 超时）→ **同一帧内**收起遮罩并显示 pin（避免闪烁）。pin renderer 自己 `pin:boot` 拉数据、`stitch()`、把 `initialShapes` **烘进画布**（只读，没有工具条），渲染完才回 `pin:ready`。
   - **`复制` / `保存`**（`Enter` / 双击也是复制）→ `runExport()`（**先等 `pendingRest`**，与 `confirmSnip` 同一个坑）把合成数据推给宿主遮罩（`overlay:compose`），遮罩**就地** `stitch()` + 画全部标注 → 回传 PNG（`overlay:export`）→ 主进程**先 `cancelSnip()` 再**进剪贴板 / 弹存盘框（否则满屏置顶的遮罩会把对话框压在下面）。全程不建钉图窗口。
   - **`取消`** → `cancelSnip('toolbar')`。
4. 标注回传与换算：遮罩只在**历史变化时**把本屏标注（本屏 DIP）推给主进程（`overlay:shapes`），不是每帧。`toImageShapes()` 按 `(本屏 DIP + 本屏原点 - 选区原点) × outScale` 换算成图像像素 —— `钉住` 走 `pin:boot.initialShapes`，`复制/保存` 走 `overlay:compose` 的 `shapes`。**存 DIP 而不提前换算**，是因为选区还在调、`outScale` 会跟着变。
5. `cancelSnip(reason)` 是唯一清理出口：收起遮罩（teardown + hide，**不销毁**）、关 pin、恢复被隐藏的自家窗口、resolve 所有 waiter、广播 `app:state`。显示分辨率变化（`display-metrics-changed` / `display-removed`）也走它；`复制/保存` 成功后也走它（所以那条路径会把窗口放回来）。
6. **`钉住`之后**主窗口**保持隐藏**（留在 `hiddenWindows` 里），只有取消才恢复 —— 见 `restoreWindows(keepHidden)`。

### 抓屏与几何（`src/main-process/capture.ts`）

- `thumbnailSize` **不保证**被遵守 → 必须回读 `thumbnail.getSize()` 反推 `scaleX/scaleY`；后续几何**永远不用 `display.scaleFactor`**。
- `thumbnailSize` 一次调用只有一个值 → 按 `round(bounds × scaleFactor)` **分组**分别发 `getSources`（混合 DPI 必须）。
- `source.display_id` 可能为空字符串 → 优先按 id 匹配，退化成下标并 warn；数量不一致直接 throw，不要猜。
- `resolveOutScale` = 与选区相交的屏里的**最大**比例（放大不丢数据，缩小才丢）。

### 拼接（`src/shared/stitch.ts`，钉图与遮罩**共用**）

源矩形和目标矩形都用「**先四舍五入各条边，再相减**」：相邻两屏共享的那条 DIP 边代入的是同一个表达式 → 同一个整数 → 零缝隙。写成 `起点 + round(宽 × 比例)` 会差 1 像素。

### 坐标系（改任何绘制/窗口代码前先认清）

| 场景                      | 空间                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 主进程的选区、窗口 bounds | 虚拟屏 DIP（可为负）                                                                                                  |
| 遮罩绘制                  | 先 `setTransform(dpr…)` 到 CSS px（本窗口 CSS px ≡ 本屏 DIP），再平移本窗口原点                                       |
| 选区手柄                  | `shared/selection.ts` 一份几何，主进程判定 + 遮罩绘制/光标共用；手柄位置从**完整选区**算，落在窗外的跳过              |
| 遮罩阶段的标注            | **本屏 DIP**（本窗口 CSS px），确认/导出时由主进程换算成图像像素                                                      |
| 贴图画布                  | backing store = **图像像素**，CSS 尺寸 = 窗口 − 四边阴影留白；`devicePixelRatio` 不参与换算，拖到别的 DPI 屏也不错位  |
| 选中标注的控制点          | 复用 `shared/selection.ts` 的 `HandleId`（矩形/椭圆 8 向、箭头两端点），命中阈值按 `pxScale`（图像 px / 屏幕 px）放大 |

### IPC

通道名只在 `src/shared/channels.ts`（`CH`），**不允许字符串字面量**；payload 类型在 `src/shared/types.ts`；`ipcMain` 注册集中在 `src/main-process/ipc.ts`。`boot` 用 `invoke` 而不是 `send`，避免「主进程先发、渲染进程还没订阅」的竞态。

### 加一个 renderer 入口要改四处（漏一处静默出错）

1. `forge.config.ts` 的 `plugins → VitePlugin → renderer` 加 entry；
2. 新建 `vite.<name>.config.ts`，**显式** `build.rollupOptions.input` 指向自己的 HTML（否则三个入口全打成根目录 `index.html` 互相覆盖）；
3. `forge.env.d.ts` 手写 `declare const <NAME>_VITE_DEV_SERVER_URL` / `_VITE_NAME`（运行时 define 自动生成，只有**类型**要手写；该文件必须保持无 `import`，否则不再是全局 script）；
4. dev 下 `loadURL(\`${…_VITE_DEV_SERVER_URL}/xxx.html\`)`**必须带文件名** ——`/`会被 Vite 的 SPA 规则解析成`index.html`（主窗口）。

## Invariants

修改代码时必须保持以下约束：

- 每块屏的抓屏先于它自己的遮罩窗口创建；遮罩 `setContentProtection(true)` + `thickFrame: false`（否则会受 Aero Snap 与隐形边框影响，导致 bounds 偏移数像素）。
- 一屏一个遮罩窗口，**不要单窗横跨多屏**：混合 DPI 下单窗 `devicePixelRatio` 语义不明确，且会受到 `WM_DPICHANGED` 抖动影响。遮罩窗口按 `displayId` 缓存复用 —— **接线（`before-input-event` / `closed`）只在创建时挂一次**，每次截图再挂会堆出重复监听器。
- 层级：遮罩 `setAlwaysOnTop(true, 'screen-saver')`（要盖住任务栏），钉图 `'floating'`（在任务栏之下）。
- 贴图窗口 = 图像 + **四边阴影留白**（`PIN_SHADOW_PAD` ≤16px，贴边为 0）：`computePinLayout` 算 padding、随 `pin:boot` 下发，渲染进程按它让开画布位置（`--pad-*` + `calc`）。窗口必须 `transparent` —— 阴影画在自己的留白里，不透明会被底色盖住。
- **遮罩画布绝不能设 `app-region`**（会吞掉指针，标注画不了）；**贴图正相反**：整扇窗口是拖拽区，其中的关闭按钮必须 `no-drag`。拖贴图走原生拖拽，`pin:move` / `startPinDrag` 已删。
- 托盘应用：`close` 只 hide 主窗口，`window-all-closed` 不退出，只有托盘「退出」才 `app.quit()`。
- 遮罩/pin 窗口没有 DevTools → `src/main-process/renderer-log.ts` 把渲染进程 console 转发到主进程，排查先看这里的输出。
- 标注历史是**整份快照**（`Editor.past` / `future`），加 / 删 / 清空 / 改色 / 移动共用它；**每次变更前必须先 `beginChange()`**，否则那步不可撤销。拖动中的图形改的是 `editing` 副本，松手才替换 `shapes` 里的原对象。
- 遮罩是纯投影：选区只在主进程，实时性由 16ms 轮询 `startPoll()` → `broadcast()` 保证。**三种拖动模式（重新框选 / 整体移动 / 拖手柄）都必须启动轮询**，漏掉任一模式都会导致按住期间不刷新、仅在松手时更新。
- **光标在哪块屏，键盘事件就归哪块屏**：遮罩焦点不会自动跟随光标，`pointermove` 中 `!document.hasFocus()` 时请求 `overlay:focus` 切前台（带 `focusRequesting` 去重）—— 否则 `Ctrl+Z` / `C` 会作用到上一块屏的窗口。
- 遮罩的 `pointerdown` 分流监听器必须**先于** `new Editor()` 注册 —— 依赖 `stopImmediatePropagation()` 阻断编辑器；顺序颠倒则无法调整选区。
- 广播里的 `activeTool` 只在**与本地不同**时才 `setTool`：`setTool` 会清草稿/选中，每次广播都调会把正在画的笔画清掉。
- 改了 `shapes` 就要 `onHistoryChange`（遮罩靠它回传标注、工具条靠它刷禁用态）；`beginChange()` 之前必须先改前快照。

## Conventions

- 文件名 kebab-case；注释用**中文**，并倾向写「为什么 / 踩过的坑」——现有代码大量是这种风格，保持一致。
- 格式化用 `npm run format`（Prettier 3，配置在 `.prettierrc`：**单引号 + 分号**、trailing comma `all`、120 宽、2 空格、LF）。为本项目自身约定 —— 不得套用「双引号 + 无分号」风格，否则会导致 `src/` 全量重排。
- 加了 `.prettierrc` / `.prettierignore`；`.prettierignore` 中的 `out/` **必须保留** —— 构建产物数量巨大，`--write` 处理将造成长时间阻塞。
- **不为每次代码改动追加文档**：文档只在**结构、对外行为、约定**变化时更新。实现细节、决策理由、踩坑原因优先写在**代码注释**里（改代码的人一定会看到），不要另开条目或新建文档复述一遍。
- 日志带 `[模块]` 前缀：`[snip]`、`[capture]`、`[pin]`、`[pin-window]`、`[editor]`、`[overlay]`。
- 每个 HTML 各自带 CSP meta（`img-src` 要放 `blob:`，`connect-src` 要放 dev 的 `ws:`）。
