# macOS 屏幕录制权限指南

本文记录 macOS 上开发 / 调试截图功能时的权限处理机制与标准排障流程。
Windows 无此限制，本文内容仅适用于 macOS。

## 为什么需要

- macOS 10.15（Catalina）起，抓屏 API 受 TCC「屏幕录制」（系统设置里叫
  「录屏与系统录音」）权限管制，本项目依赖的
  `desktopCapturer.getSources({ types: ['screen'] })` 正在其中。
- **未授权的典型症状**：截出来的图只有桌面壁纸，看不到任何窗口内容；部分显示器
  可能是纯黑。
- macOS **没有提供编程式授权 API**（`systemPreferences.askForMediaAccess()` 只支持
  camera / microphone），任何截图应用都无法替用户完成授权，最终一步永远是用户在
  系统设置里点开关。
- 系统原生授权弹窗**只在「从未询问」状态下、由真实抓屏请求触发一次**。一旦被拒过，
  系统不会再弹，只能去「系统设置 → 隐私与安全性 → 录屏与系统录音」手动勾选。

## 关键：dev 模式下权限归属到「启动它的终端」

macOS 对屏幕录制权限按「责任进程」（responsible process）归属：**从终端
`npm start` 启动的 Electron，真正被检查的是启动它的终端应用的授权**
（Warp / iTerm2 / Terminal / VS Code 集成终端……），而不是
`node_modules/electron/dist/Electron.app` 自己的授权条目。

实测结论（本机 macOS 27 + Warp 验证）：

- 只给 Electron.app 授权、终端没授权 → 应用依然 `denied`，怎么勾都没用；
- 给**终端**授权 → dev 实例直接 `granted`。

打包后的正式应用归属到应用自身，授权应用即可，与终端无关。部分 macOS
版本对两者都校验，dev 环境把终端和 Electron 都勾上最稳妥。

## 应用内的处理

权限逻辑集中在 `src/main-process/screen-permission.ts`，所有截图触发点
（快捷键 / 托盘 / 主窗口按钮 / 延迟截图）都汇聚在 `beginSnip()`，入口处统一拦截：

- 启动时（`main.ts` 的 `whenReady`）与每次 `beginSnip()` 前，用
  `systemPreferences.getMediaAccessStatus('screen')` 检查状态；
- 未授权时**先发起一次真实抓屏探测**（`desktopCapturer.getSources`）：状态是
  「从未询问」时，macOS 会弹原生授权框并自动登记授权条目，免去手动「+」添加；
- 探测后仍未授权，再弹自家引导框，点「打开系统设置」经
  `x-apple.systempreferences:` 深链直达授权面板；
- 非 darwin 平台恒放行。

终端日志验证手段：每次触发检查都会打印
`[permission] 屏幕录制权限状态：granted / denied`，以此为准判断应用的真实视角。

## 标准授权流程（首次开发）

1. 「系统设置 → 隐私与安全性 → 录屏与系统录音」，勾选**启动 `npm start`
   的终端应用**（dev 模式的根本解法，见上）。
2. **完全重启应用**：Ctrl+C 停掉 `npm start` 再重新运行。授权只对
   **授权之后新启动的进程**生效，正在运行的实例永远拿不到权限。
3. 触发一次截图，终端打出 `[permission] 屏幕录制权限状态：granted` 即一切正常。
4. 若仍 `denied`，按下面排障清单继续。

## 排障：勾了但没效果

按顺序排查，每步之后都要完全重启应用再验证：

1. **确认授权对象**：dev 模式查的是终端（见「关键」一节）；打包版查应用自身。
   给错了对象，勾了也没效果。

2. **先完全重启**（Ctrl+C `npm start` → 重新运行）。授权不追溯已运行的进程，
   这是「勾了没效果」最常见的原因。

3. **多 Electron 副本陷阱**（手动「+」添加时）：本机其他项目的
   `node_modules/electron/dist/Electron.app` 与本项目同名同图标，但 Electron
   版本不同（签名指纹就不同），选错副本授权会绑到错误的二进制上。优先依赖
   原生弹窗自动登记；手动添加时用 `Cmd+Shift+G` 输入本项目的完整路径。

4. **检查代码签名是否完好**：

   ```bash
   codesign --verify --deep --strict node_modules/electron/dist/Electron.app
   ```

   签名损坏时（曾出现过的报错：`code has no resources but signature indicates
they must be present`），macOS 的 TCC 无法把授权绑定到该应用——系统设置里
   开关显示已开，但应用拿不到权限。npm 分发的 Electron 是 ad-hoc 签名，
   重装依赖或升级版本后可能再次损坏。修复：

   ```bash
   codesign --force --deep --sign - node_modules/electron/dist/Electron.app
   ```

5. **重置授权记录后重新走标准流程**：

   ```bash
   tccutil reset ScreenCapture com.github.Electron
   ```

   dev 版 Electron 的 bundle id 是 `com.github.Electron`。此命令清掉该标识下
   所有授权条目（含失效的「僵尸条目」——条目还在、开关还开着，但绑定的是旧
   二进制指纹），然后从标准流程第 1 步重来。

## 速查

| 场景                   | 命令 / 操作                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| 查看应用视角的权限状态 | 触发截图，看终端 `[permission]` 日志行                                      |
| dev 模式授权           | 系统设置 → 隐私与安全性 → 录屏与系统录音 → 勾选**终端应用**                 |
| 验证签名               | `codesign --verify --deep --strict node_modules/electron/dist/Electron.app` |
| 重签（签名损坏时）     | `codesign --force --deep --sign - node_modules/electron/dist/Electron.app`  |
| 清空授权记录重走流程   | `tccutil reset ScreenCapture com.github.Electron`                           |

注意事项：

- 签名修复打在 `node_modules` 里，重装依赖或升级 Electron 后可能复发，重跑重签
  命令 + `tccutil reset` 即可。
- 每次动过系统设置里的开关（包括 macOS 15+ 周期性要求重新确认授权），都要
  完全重启 dev 实例才生效。

## 相关

- [架构与调用逻辑](architecture.md)
- [用到的 Electron 模块](electron-api.md)
