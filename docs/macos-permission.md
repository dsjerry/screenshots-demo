# macOS 屏幕录制权限指南

本文记录 macOS 上开发 / 调试截图功能时的权限处理机制与标准排障流程。
Windows 无此限制，本文内容仅适用于 macOS。

## 为什么需要

- macOS 10.15（Catalina）起，抓屏 API 受 TCC「屏幕录制」（录屏与系统录音）权限管制，
  本项目依赖的 `desktopCapturer.getSources({ types: ['screen'] })` 正在其中。
- **未授权的典型症状**：截出来的图只有桌面壁纸，看不到任何窗口内容；部分显示器可能是纯黑。
- macOS **没有提供编程式授权 API**（`systemPreferences.askForMediaAccess()` 只支持
  camera / microphone），任何截图应用都无法替用户完成授权，最终一步永远是用户在
  系统设置里点开关。
- 系统原生授权弹窗**只在「从未询问」状态下、由真实抓屏请求触发一次**。一旦被拒过，
  系统不会再弹，只能去「系统设置 → 隐私与安全性 → 录屏与系统录音」手动勾选。

## 应用内的处理

权限逻辑集中在 `src/main-process/screen-permission.ts`，所有截图触发点
（快捷键 / 托盘 / 主窗口按钮 / 延迟截图）都汇聚在 `beginSnip()`，入口处统一拦截：

- 启动时（`main.ts` 的 `whenReady`）与每次 `beginSnip()` 前，用
  `systemPreferences.getMediaAccessStatus('screen')` 检查状态；
- 未授权时**先发起一次真实抓屏探测**（`desktopCapturer.getSources`）：状态是
  「从未询问」时，macOS 会弹原生授权框并把当前二进制自动登记进授权列表，免去
  手动「+」添加（手动添加在多 Electron 项目共存的机器上容易选错副本，见下文排障）；
- 探测后仍未授权，再弹自家引导框，点「打开系统设置」经
  `x-apple.systempreferences:` 深链直达授权面板；
- 非 darwin 平台恒放行。

终端日志验证手段：每次触发检查都会打印
`[permission] 屏幕录制权限状态：granted / denied`，以此为准判断应用的真实视角。

## 标准授权流程（首次开发）

1. `npm start` 启动应用。
2. 按截图快捷键（或启动时）→ 系统原生授权框 / 应用引导框出现 → 点「打开系统设置」。
3. 在「录屏与系统录音」列表中勾选 **Electron**。dev 模式下宿主应用就是
   `node_modules/electron/dist/Electron.app`；机器上有多个 Electron 项目时，
   务必确认勾选的是**本项目**的副本（手动「+」添加时可按 `Cmd+Shift+G`
   输入完整路径定位）。
4. **完全重启应用**：Ctrl+C 停掉 `npm start` 再重新运行。授权只对
   **授权之后新启动的进程**生效，正在运行的实例永远拿不到权限 ——
   这是「勾了没效果」最常见的原因。
5. 重启后触发一次截图，终端应打出
   `[permission] 屏幕录制权限状态：granted`，即一切正常。

## 排障：勾了但没效果

按顺序排查，每步之后都要完全重启应用再验证：

1. **先完全重启**（Ctrl+C `npm start` → 重新运行）。见上，授权不追溯已运行的进程。

2. **检查代码签名是否完好**：

   ```bash
   codesign --verify --deep --strict node_modules/electron/dist/Electron.app
   ```

   签名损坏时（曾出现过的报错：`code has no resources but signature indicates
they must be present`），macOS 的 TCC 会**拒绝把授权绑定到该应用**——系统设置里
   开关显示已开，但应用永远拿不到权限。npm 分发的 Electron 是 ad-hoc 签名，
   重装依赖或升级版本后可能再次损坏。修复：

   ```bash
   codesign --force --deep --sign - node_modules/electron/dist/Electron.app
   ```

3. **重置授权记录后重新走标准流程**：

   ```bash
   tccutil reset ScreenCapture com.github.Electron
   ```

   dev 版 Electron 的 bundle id 是 `com.github.Electron`。此命令清掉该标识下
   所有授权条目（含失效的「僵尸条目」——条目还在、开关还开着，但绑定的是旧二进制
   指纹），然后从标准流程第 1 步重来。

4. **多 Electron 副本陷阱**：本机其他项目的
   `node_modules/electron/dist/Electron.app` 与本项目同名同图标，但 Electron
   版本不同（签名指纹就不同）。手动「+」添加时选错副本，授权会绑到错误的
   二进制上，本项目永远收不到。优先依赖原生弹窗自动登记；手动添加时用
   `Cmd+Shift+G` 输入本项目的完整路径。

## 速查

| 场景                   | 命令 / 操作                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| 查看应用视角的权限状态 | 触发截图，看终端 `[permission]` 日志行                                      |
| 验证签名               | `codesign --verify --deep --strict node_modules/electron/dist/Electron.app` |
| 重签（签名损坏时）     | `codesign --force --deep --sign - node_modules/electron/dist/Electron.app`  |
| 清空授权记录重走流程   | `tccutil reset ScreenCapture com.github.Electron`                           |
| 授权面板直达           | 系统设置 → 隐私与安全性 → 录屏与系统录音                                    |

注意事项：

- 签名修复打在 `node_modules` 里，重装依赖或升级 Electron 后可能复发，重跑重签
  命令 + `tccutil reset` 即可。
- 每次动过系统设置里的开关（包括 macOS 15+ 周期性要求重新确认授权），都要
  完全重启 dev 实例才生效。

## 相关

- [架构与调用逻辑](architecture.md)
- [用到的 Electron 模块](electron-api.md)
