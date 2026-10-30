# 架构与调用逻辑

本文说明一次截图从触发到结束，主进程与三个 renderer 之间的调用关系。

## 文件结构

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
    stitch.ts            跨屏拼接（遮罩与贴图共用）
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

## 窗口与进程

主进程 + 三个 renderer，共用同一份 preload：

```mermaid
flowchart LR
    subgraph main["主进程"]
        MW["主窗口<br/>index.html"]
        TR["托盘 Tray / Menu"]
        SN["snip-session<br/>选区状态机"]
    end

    subgraph renderers["renderer（按需存在）"]
        O1["遮罩 · 屏 A<br/>overlay.html"]
        O2["遮罩 · 屏 B<br/>overlay.html"]
        PL["贴图（钉住时创建）<br/>pin.html"]
    end

    PRE["preload.ts<br/>contextBridge → window.api"]

    MW --- PRE
    O1 --- PRE
    O2 --- PRE
    PL --- PRE
    TR --> SN
    MW --> SN
    SN <--> O1
    SN <--> O2
    SN <--> PL
```

- **遮罩**：每块屏一个窗口（`bounds` 严格等于 `display.bounds`），不是单窗横跨多屏 —— 混合 DPI 下单窗的 `devicePixelRatio` 语义是模糊的。
- **贴图**：只有点「钉住」才创建，创建后按 `displayId` 之外的逻辑不再复用（每个贴图是独立窗口）。
- **托盘常驻**：主窗口 `close` 只 `hide()`，`window-all-closed` 不退出。

## 启动

```mermaid
flowchart TD
    A["electron-forge start（开发）<br/>打包后的 exe（发布）"] --> B["Vite 构建"]
    B --> B1["main.ts"]
    B --> B2["preload.ts"]
    B --> B3["index / overlay / pin 三个 renderer"]

    B1 --> C["app.whenReady()"]
    C --> D["registerIpc()<br/>ipcMain.handle × 16（共 22 个通道，6 个是主进程 send）"]
    C --> E["createMainWindow()<br/>close → 只 hide，常驻后台"]
    C --> F["createTray()<br/>左键 = 截图，右键 = 菜单（退出在菜单里）"]
    C --> G["globalShortcut Ctrl+Shift+A<br/>注册失败只告警，退回按钮 / 托盘"]

    G --> H["beginSnip()"]
    F --> H
    E --> H
```

## 一次截图的调用链

```mermaid
sequenceDiagram
    actor U as 用户
    participant M as 主进程 snip-session
    participant O as 遮罩 overlay（每屏一个）
    participant P as 贴图 pin

    U->>M: Ctrl+Shift+A / 托盘左键 / 按钮（invoke app:startSnip）
    M->>M: hideOwnWindows() 后抓屏（避免将本应用窗口截入画面）
    M->>M: 并行抓屏 desktopCapturer，光标所在屏优先
    M->>O: 创建遮罩窗（contentProtection）
    O->>M: invoke overlay:boot（取本屏截图）
    O->>M: invoke overlay:ready
    M->>O: send overlay:selection（首个 ready 立刻 show + 拿焦点）
    Note over M,O: 输入分流 — 手型工具或选区外按下 → 主进程；绘图工具且选区内 → 编辑器绘制标注（画布捕获指针，拖画可越过屏幕边界继续）
    loop 拖动中每 16ms
        M->>M: screen.getCursorScreenPoint()（光标唯一真相源）
        M->>O: send overlay:selection
        O->>O: 重绘选框 / 手柄 / 尺寸标签 / 浮动工具条
    end
    Note over M: 松手 → phase = adjusting（选区可实时调，工具条同刻出现）
    Note over M,O: 跨屏标注投影 — 历史变化 invoke overlay:shapes、拖画按帧 invoke overlay:draft；主进程换算成虚拟屏 DIP 后 send overlay:remoteShapes / overlay:remoteDraft 给其余遮罩，各遮罩平移到本屏坐标渲染落在本屏的部分
    alt 钉住
        M->>M: 等 pendingRest（其余屏抓完）
        M->>P: 创建贴图窗（transparent + 阴影留白）
        P->>M: invoke pin:boot（拼接数据 + 标注）
        P->>P: stitch() 拼接，标注烘进画布
        P->>M: invoke pin:ready
        M->>O: send overlay:teardown + hide
        M->>P: show（同一帧内完成，避免闪烁）
    else 复制 / 保存（Enter、双击 = 复制）
        M->>O: send overlay:compose（推合成数据）
        O->>O: stitch() + 画全部标注
        O->>M: invoke overlay:export（PNG）
        M->>M: 先 cancelSnip() 再 clipboard / showSaveDialog
    else 取消（Esc、右键、取消按钮）
        M->>O: send overlay:teardown + hide
    end
```

`boot` / `ready` / `pin:boot` 都用 `invoke` 而不是 `send`，是为了避开「主进程先发、渲染进程还没订阅」的竞态。

## 选区阶段

```mermaid
stateDiagram-v2
    [*] --> selecting : beginSnip，抓屏 + 首屏遮罩就绪
    selecting --> adjusting : 松手（finishDrag），出手柄 + 浮动工具条
    adjusting --> selecting : 框外按下，重新框选
    adjusting --> adjusting : 拖手柄 / 框内拖动，实时调整
    adjusting --> confirming : 点「钉住」（confirmSnip）
    confirming --> [*] : pin:ready → 收起遮罩、显示贴图
    selecting --> [*] : Esc / 右键 / 取消
    adjusting --> [*] : 复制·保存（先 cancelSnip）/ 取消
```

三个阶段的 `phase` 定义在 `src/shared/types.ts` 的 `SnipPhase`；选区状态**只存在主进程**（虚拟屏 DIP 坐标，可为负），遮罩是纯投影。

尚无选区时支持**窗口捕获**：主进程按 64ms 轮询 `get-windows` 的 `openWindowsSync()`（按 z 序返回全部窗口，物理像素坐标），过滤自家进程后取第一个包含光标的窗口，经 `screen.screenToDipPoint` 换算成 DIP 后以 `hoverRect` 随 `overlay:selection` 广播；遮罩画高亮框，此时单击直接把整窗采纳为选区。原生模块加载失败只记一次日志，功能降级为普通框选。

## IPC 通道方向

- **主 → 渲染**（`send`）：`overlay:selection`、`overlay:teardown`、`overlay:compose`、`overlay:remoteShapes`、`overlay:remoteDraft`、`app:state`
- **渲染 → 主**（`invoke`）：`overlay:boot`、`overlay:ready`、`overlay:input`、`overlay:tool`、`overlay:action`、`overlay:shapes`、`overlay:draft`、`overlay:inFlight`、`overlay:editState`、`overlay:focus`、`overlay:copyText`、`overlay:export`、`pin:boot`、`pin:ready`、`pin:action`、`app:startSnip`

共 22 个通道（16 个 `invoke` + 6 个 `send`），全部定义在 `src/shared/channels.ts` —— 任何地方都不允许写字符串字面量。

## 屏幕录制

与长图同一取舍：**只录单屏内**的选区（跨屏录制时帧尺寸会随光标移动跳变，控制条也没有自然的摆放位置）。

```mermaid
sequenceDiagram
    actor U as 用户
    participant M as 主进程 record-capture
    participant B as 控制条（record.html#bar）
    participant I as 标注层（record.html#ink）

    U->>M: 遮罩工具条「录制」
    M->>M: 收起遮罩，取选区与所在屏的最大交集
    M->>B: 创建控制条（置顶 + contentProtection）
    M->>I: 创建标注层（与录制区域同形、整窗穿透）
    loop 每 100ms
        M->>M: captureDisplays → cropShot 裁出选区
        M->>B: send record:frame（RGBA）
    end
    B->>B: 收进帧队列（上限 600 帧，超出丢旧帧）
    Note over M,I: 录制中标注 — 控制条下发笔刷（record:brush），主进程轮询全局光标<br/>+ GetAsyncKeyState 判按压，把 down/move/up 发给标注层；标注层只画不上屏
    I->>M: send record:shapes（本窗口 DIP 的标注快照）
    U->>B: 停止
    B->>B: 逐帧画进离屏画布 + 叠加标注 → PNG
    B->>M: invoke record:export（帧数组）
    M->>M: 写临时目录 + frames.json（fps / 尺寸），复制路径 / 打开目录
```

三条不变量：

- **控制条与标注层永不进画面**：两者都 `setContentProtection(true)`，这也是控件能与录制区域重叠的前提。
- **标注层整窗鼠标穿透**：它盖着录制区域，收指针就等于把用户的操作全挡住；绘制靠主进程转发的全局光标驱动。
- **encode 在渲染进程**：主进程是所有窗口的事件循环所在，一帧 PNG 编码卡住会让遮罩、托盘、录制一起停顿。

### 产物落点

与截图同一套约定，**不落临时目录**：

| 动作              | 位置                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 保存（帧序列）    | 弹「选择文件夹」（默认 `settings.saveDir`）→ 在里面新建 `record_YYYY-MM-DD_HH-mm-ss/`，写入 `frame-0000.png …` + `frames.json` |
| 保存（gif / mp4） | 弹「另存为」，默认 `settings.saveDir/record_…gif`                                                                              |
| 复制（gif / mp4） | 图片进剪贴板（`ClipboardItem` + `image/gif`），同时落一份到 `saveDir` 并把路径写进剪贴板                                       |
| 复制（帧序列）    | 多文件没有单张图像形态：退化为「保存到 `saveDir` + 路径进剪贴板」，控制条如实提示                                              |

对话框弹出前控制条会临时降级 `alwaysOnTop`，否则 screen-saver 层级的控制条会把对话框盖住。

### GIF 编码

产物支持 **GIF**（默认）与 **PNG 帧序列**；MP4 尚未接入（下拉里置灰）。

编码全在控制条渲染进程里完成，三步：

1. 每帧叠上「那一刻已生效的标注」画进离屏画布 → 取 RGBA；
2. `src/record/quantize.ts` 用**中位切分**把全片压到 256 色，全片共用一张全局色表（每帧换盘会让静态区域轻微闪色）；
3. `dedupeFrames` 合并连续相同帧（静止画面只累加显示时长），再交给 `src/shared/gif.ts` 做 LZW + 容器封装。

`src/shared/gif-decode.ts` 是配套的参考解码器，只用于自测对拍。
