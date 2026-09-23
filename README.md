# screenshots

Electron 跨屏截图工具：框选截图 → 直接在图上标注 → 钉住置顶。

## 功能

- **跨显示器截屏**：选区可以拖过屏幕边界，导出为一张拼接图。支持缩放比例不同的多块屏、负坐标虚拟屏
- **放大镜**：框选前跟随光标显示 4× 放大图、虚拟屏坐标与取色 `RGB`
- **标注**：箭头 / 矩形 / 椭圆 / 画笔 / 马赛克 / 文字，配色、线宽、撤销 / 重做 / 清空；已画的标注可**点选 → 移动 / 拖手柄调整 / 改色 / 删除**
- **松手即可标注**：选区定下来的同时，选区下方**立刻浮出工具条**，直接在原图上画，选区大小/位置同时还能实时调。**没有「确定」这一步**（主流截图工具都没有）——`复制`/`保存`就地合成直接结束，`钉住`才进贴图（标注原样带过去、烘进画布）
- **钉住**：直接生成无边框置顶贴图（透明窗口 + **外阴影**，跟桌面有层次）。**没有工具条** —— 只有悬停浮现的右上角 `×`；标注在钉住前就画完了，贴图是只读的
- 单块屏也能用：单击 = 选中整屏

## 使用

| 操作 | 方式 |
| --- | --- |
| 触发截图 | `Ctrl+Shift+A` / 主窗口「开始截图」/ 托盘左键 |
| 框选 | 按住左键拖动（可跨屏），**松开后出现 8 向手柄**（拖角/边调大小、框内拖动整体移动、框外拖动重新框选），并且同刻浮出工具条；单击 = 整屏；`Enter` / 双击 = **复制**，`Esc` / 右键 = 取消 |
| 选区工具条 | 松手即出现在选区下方（贴右下，放不下翻上方/贴屏底）：工具 / 色块 / 线宽 / 撤销 / 重做 / 清空 + `钉住` `复制` `保存` `取消`（**没有「确定」**）。**手型工具或点在选区外 = 调整选区，绘图工具且在选区内 = 画标注**；`复制`/`保存`就地拼图后结束，`钉住`进贴图窗口 |
| 放大镜 | 框选前自动跟随光标（4× 放大 + 坐标 + `RGB` 取色）；一开始框选就消失 |
| 标注 | **只在选区阶段**（`src/annotations/` 引擎）：点已画的标注可选中 → 移动 / 拖控制点（矩形·椭圆 8 向、箭头两端点）/ 色块直接改这条颜色 / `Delete` 删除；钉住之后是只读贴图，不能再改 |
| 移动贴图 | 整扇窗口就是**原生拖拽区**（`app-region: drag`），按哪儿都能拖，跨 DPI 不掉帧 |
| 复制 / 保存 | 选区工具条「复制」「保存」；贴图里只剩 `Ctrl+C` 复制 |
| 快捷键 | 选区阶段：`Ctrl+Z` 撤销、`Ctrl+Shift+Z` / `Ctrl+Y` 重做、`Delete` 删选中标注、`Enter` / 双击 复制、`Esc` 取消；打字时 `Esc` 取消文字、`Ctrl+Enter` 提交。贴图：`Esc` 关闭、`Ctrl+C` 复制 |
| 关闭 | 贴图**悬停** → 右上角 `×`，或 `Esc`；「置顶」不再有开关（钉住就是置顶） |
| 退出 | 托盘右键 → 退出（关掉主窗口只是隐藏，进程还在托盘） |

## 快速开始

```bash
npm install
npm start
```

```bash
npm run typecheck   # 类型检查
npm run lint        # ESLint
npm run package     # 打包成免安装目录
npm run make        # 生成安装包（Windows 走 Squirrel）
```

没有配置测试框架，靠 `typecheck` + `lint` + 手动验证。

## 结构

```
src/
  main.ts                主进程入口：主窗口、托盘、全局快捷键
  preload.ts             contextBridge，三个窗口共用同一份
  global.d.ts            window.api 类型
  shared/
    channels.ts          IPC 通道名唯一来源（不写字符串字面量）
    types.ts             Rect / DisplayShot / Shape / 各类 payload
    pin-layout.ts        贴图窗口的阴影留白上限 / 最小尺寸（主进程与渲染进程共用）
    api.ts               ScreenshotsApi，preload 与渲染进程共用
    bytes.ts             Uint8Array → Blob
    stitch.ts            跨屏拼接（钉图与遮罩共用）
    selection.ts         选区 8 向手柄几何（主进程判定 + 遮罩绘制/光标共用）
  main-process/
    capture.ts           抓屏：按目标尺寸分组取源，回读实际尺寸算比例（可只抓指定屏）
    snip-session.ts      选区状态机：遮罩生命周期、选区、确认/取消
    overlay-window.ts    遮罩窗口（每屏一个，按 displayId 缓存复用）
    pin-window.ts        贴图窗口（透明 + 关闭）、复制、保存
    ipc.ts               ipcMain 注册
    tray.ts              托盘
    renderer-log.ts      渲染进程 console 转发到主进程
  annotations/           标注引擎（遮罩在用；钉住后是只读贴图）
    editor.ts            标注编辑器：历史、选中/调整、指针、文字
    shapes.ts            各图形绘制 + 马赛克 + 命中检测 + 包围盒/手柄
    toolbar.ts / .css    工具条（动作组由宿主注入）
  overlay/
    overlay.ts / draw.ts 遮罩渲染：截图 + 遮罩 + 选框/手柄 + 浮动工具条 + 放大镜
  pin/
    pin.ts               贴图入口：拼图 + 烘标注 + 关闭按钮 + 快捷键
    pin.css              透明窗口 / 阴影留白定位 / 关闭按钮
index.html               renderer 入口：主窗口
overlay.html             renderer 入口：遮罩
pin.html                 renderer 入口：钉图
```

## 实现要点

- **工具条只挂一块屏**：选区中心所在屏渲染浮条（`toolbarDisplayId`），其余屏收到的广播里带同一个 `activeTool`，跨屏画图用的是一套工具
- **指针分流在遮罩里先于编辑器注册**：手型工具 / 点在选区外 → 转主进程调选区（`stopImmediatePropagation`），绘图工具且在选区内 → 放行给编辑器画。顺序反了编辑器会抢走调选区的按下事件
- **打字时主进程让出 Enter / Esc**：文字输入框开合走 `overlay:editState`，否则 `before-input-event` 会把 `Enter`（提交文字）吃成**复制**、把 `Esc`（取消文字）吃成**取消截图**
- **遮罩画布必须 setTransform 到 CSS 像素，不能用单位矩阵**：backing store 是 `cssWidth × dpr`，单位矩阵只会画进左上 `1/dpr` 的区域 —— 125%/150% 缩放的屏上会黑掉一块、选框也对不上
- **每屏一个遮罩窗口**，而不是一个窗口横跨多屏 —— 跨混合 DPI 时，单窗的 `devicePixelRatio` 语义是模糊的，还会吃 `WM_DPICHANGED` 抖动
- **抓屏分批 + 窗口复用**：光标所在屏优先落地，其余屏并行抓、抓到一块补一块（不等全部就绪）；遮罩窗口按 `displayId` 缓存，收起只 `hide()` + 释放位图，下次 `reload()` 复用 —— 首帧就绪超时因此从 6s 降到 2.5s。**确认选区前会等其余屏抓完**，否则晚到那块屏在拼接里是空的
- **遮罩每帧重画全部标注**（没有离屏缓存 —— 那套缓存只服务过钉图自带的渲染管线，钉图不再编辑后已删）。标注很多、且带马赛克时若掉帧，下一步是把标注拆成独立画布层
- **选区只在主进程存一份**（虚拟屏 DIP 坐标），光标位置一律取 `screen.getCursorScreenPoint()`，避免多个窗口各算各的坐标对不上
- **松手不直接完成**：`phase` 从 `selecting` 进 `adjusting` 才出 8 向手柄、才浮出工具条，此阶段选区可实时调；Enter / 双击 = 复制，点「钉住」才进贴图；手柄几何集中在 `shared/selection.ts`，主进程用它判定这一下是调手柄 / 整体移动 / 重新框选，遮罩用它画手柄和鼠标样式 —— 两边共用一套，否则会出现「看得见但拖不动」
- **手柄只从完整选区上取**，跨屏选区被本屏裁掉的角由那块屏的遮罩画，本屏不凭裁剪后的矩形角伪造手柄
- **拼接时对「边」四舍五入再相减**：相邻两屏共享的那条 DIP 边代入的是同一个表达式 → 同一个整数 → 零缝隙。写成 `起点 + round(宽×比例)` 会在边界差 1 像素
- **遮罩阶段的标注存本屏 DIP**，确认/导出时才换算成图像像素；贴图画布 backing = 图像像素、CSS 尺寸 = 窗口 − 四边留白，`devicePixelRatio` 不参与换算，拖到别的 DPI 屏不错位
- **输出比例取相交屏的 max**：用主屏比例会不可逆地丢掉高 DPI 屏的文字细节（放大不丢数据，缩小才丢）
- **每块屏的抓屏都发生在它自己的遮罩窗口创建之前**，并 `setContentProtection(true)`，避免把自己截进图里
- **抓屏回读实际尺寸**：`thumbnailSize` 只是请求值，比例用 `thumbnail.getSize()` 反推，不直接用 `display.scaleFactor`
- **贴图 = 图像 + 四边阴影留白**（`shared/pin-layout.ts` 的 `PIN_SHADOW_PAD` ≤16px）：`computePinLayout` 按「那侧屏幕还剩多少地方」算每侧留白（贴边就是 0，桌面到头了本来也没地方画阴影），随 `pin:boot` 下发；渲染进程按同一个 padding 让开画布位置。窗口必须 `transparent` —— 阴影画在窗口自己的留白里，不透明会被底色盖住
- **拖贴图用原生 `app-region: drag`**：条带没了，拖拽手柄就是整扇窗口；比主进程 16ms 轮询 `setBounds` 顺，跨 DPI 也不会被系统重标定时错位（`pin:move` / `startPinDrag` 已删）

## 环境

- Node 22+、Electron 44，主要在 Windows 上开发（其他平台未验证）
- 依赖有上限，升级会与 Forge 插件的 peer 约束冲突：`typescript@5.x`、`eslint@8`、`vite@5`、`@electron/fuses@1`

## 参考

- [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window)
- [screen](https://www.electronjs.org/docs/latest/api/screen)
