<div align="center">

# Screenshots

**Electron 跨屏截图工具 —— 框选截图 · 随手标注 · 一键贴图 · 滚动长图 · OCR 提字**

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)](https://github.com/dsjerry/screenshots-demo)
[![Electron](https://img.shields.io/badge/Electron-44-47848F)](https://www.electronjs.org/)
[![Build](https://github.com/dsjerry/screenshots-demo/actions/workflows/build.yml/badge.svg)](https://github.com/dsjerry/screenshots-demo/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

</div>

---

托盘常驻，`Ctrl+Shift+A` 全局呼出：多显示器跨屏框选、悬停自动吸附窗口、松手即在原图上标注，然后钉在桌面、滚动拼长图，或一键提取文字 —— 全部离线。

> 📷 截图与 GIF 演示持续补充中（见下方各功能小节）。

## ✨ 功能特性

**截图与选区**
- 🖥️ **跨显示器截屏**：选区可拖过屏幕边界，混合 DPI、负坐标虚拟屏，导出为一张拼接图；桌面边缘碰撞贴边
- 🪟 **窗口智能吸附**：悬停自动高亮窗口，单击整窗选中，按住拖动照常自定义框选；`Tab` 在重叠窗口间轮换
- 🔍 **放大镜取色**：4× 放大 + 坐标 + `HEX` / `RGB`（`Shift` 切换、`C` 复制），选区内依然可用

**标注（十余种工具）**
- 箭头（实心/空心、头粗尾细）、直线、矩形、椭圆、画笔、**荧光笔**（半透明加粗）
- 马赛克（选区 / 涂抹 / **高斯模糊**）、**序号气泡**（点击自动递增）、文字（可二次编辑）
- 色板 / 线宽滑杆 / 字号 / 撤销重做；已画标注可点选移动、拖手柄、改色、删除
- 方向键微调选区（1px，长按加速），左下角常驻快捷键速查面板

**长图与 OCR**
- 📜 **滚动截长图**：手动滚轮或程序自动滚动（三档速度、到底自动停），行指纹探针拼接，窗口框架不影响
- 🔤 **OCR 提取文字**：Windows 内置 WinRT 引擎，离线识别中文，会话内即时出结果

**贴图（Pin）**
- 📌 一键钉在桌面置顶显示；**滚轮缩放**（光标处不动）、`Ctrl+滚轮` 调透明度、双击复制
- ✎ **二次标注**：完整工具条浮在贴图上，改完直接导出；`Ctrl+T` 点击穿透当桌面便签垫底

**效率与集成**
- 🕘 **截图历史**：最近 20 张自动收录，缩略图列表一键复制 / 贴图 / 保存
- ⚙️ **设置页**：全局快捷键自定义、开机自启、保存目录、默认格式（PNG/JPG）
- 🖱️ 多屏标注实时同步、保存自动复制文件路径、托盘常驻 + 延迟截图

## 📦 下载使用

前往 [Releases](https://github.com/dsjerry/screenshots-demo/releases) 下载免安装压缩包，解压运行 `screenshots.exe` 即可（无需安装 Node.js）。

## 🛠️ 从源码运行

```bash
git clone https://github.com/dsjerry/screenshots-demo.git
cd screenshots-demo
npm install

# npm 的 install-scripts 白名单会拦下 get-windows 的安装脚本（下载 N-API
# 预编译二进制），需要批准并补跑一次；下载走 GitHub Releases，网络受限
# 时先挂代理（如 HTTPS_PROXY=http://127.0.0.1:7890）
npm install-scripts approve get-windows
npm rebuild get-windows

npm start
```

### 常用脚本

| 命令 | 说明 |
| --- | --- |
| `npm start` | 开发模式运行（Forge + Vite 热更新） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint |
| `npm run package` | 打包成免安装目录（`out/`） |
| `npm run make` | 生成安装包（Windows 走 Squirrel） |

## 🧭 使用指南

| 操作 | 方式 |
| --- | --- |
| 触发截图 | 全局快捷键（默认 `Ctrl+Shift+A`，可在设置页改）/ 主窗口按钮 / 托盘左键 |
| 框选 | 按住左键拖动（可跨屏），松手出 8 向手柄 + 工具条；单击 = 整屏；`Enter` / 双击 = 复制，`Esc` = 取消 |
| 窗口捕获 | 悬停窗口 → 蓝框高亮，原地点击 = 整窗选区，按住拖动 = 自定义框选，`Tab` 轮换重叠窗口 |
| 标注 | 松手即可画；点选已画标注 → 移动 / 拖手柄 / 改色 / `Delete` 删除；文字点选可二次编辑 |
| 快捷键 | 选区阶段：`Ctrl+S` 保存、`Ctrl+Z` / `Ctrl+Shift+Z` 撤销重做、方向键微调（长按加速）、`Esc` 取消 |
| 贴图 | 钉住生成置顶贴图；滚轮缩放、`Ctrl+滚轮` 透明度、双击复制、`✎` 标注、`Esc` 关闭 |
| 长图 | 「长图」按钮（选区在单屏内）→ 手动滚轮 / 自动滚动 → `编辑` `复制` `保存` |
| OCR | 「提取文字」按钮 → 右上角结果面板 → 一键复制 |
| 历史 | 托盘「截图历史」→ 缩略图列表 → 复制 / 贴图 / 保存 / 删除 |

> 更多细节（多屏同步原理、标注引擎、IPC 设计）见 [docs/architecture.md](docs/architecture.md)。

## 🏗️ 技术栈与结构

- **Electron 44 + TypeScript + Vite（Forge 插件）**，UI 无框架、零运行时依赖
- 每块显示器一个遮罩窗口（规避混合 DPI 语义问题），标注引擎（`src/annotations/`）在遮罩 / 贴图 / 长图间复用
- 原生能力：窗口枚举用 [get-windows](https://github.com/sindresorhus/get-windows)、自动滚动注入用 [koffi](https://github.com/koromix/koffi)、OCR 用系统 WinRT —— 全部 N-API 预编译，无需本地编译环境

```
src/
├── main-process/   # 主进程：截图会话、滚动拼接、OCR、历史、设置、托盘
├── annotations/    # 标注引擎（遮罩 / 贴图共用）
├── overlay/        # 截图遮罩渲染进程
├── pin/            # 贴图渲染进程
├── scroll/         # 长图控制条渲染进程
├── history/        # 截图历史窗口
└── shared/         # 类型、IPC 通道、几何与拼接算法
```

## 🤝 参与贡献

Issue / PR 均欢迎。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 风格（`feat:` / `fix:` / `chore:` …），改动请确保 `npm run typecheck` 与 `npm run lint` 通过。

## 📄 许可证

[MIT](./LICENSE)

## 🙏 致谢

- [get-windows](https://github.com/sindresorhus/get-windows) — 窗口枚举与元数据
- [koffi](https://github.com/koromix/koffi) — FFI 注入滚轮（自动滚动）
- [lucide](https://lucide.dev/) — 工具条图标
- [Electron](https://www.electronjs.org/) 与 [Electron Forge](https://www.electronforge.io/)
