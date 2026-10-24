import { desktopCapturer, dialog, shell, systemPreferences } from 'electron';

/** 「系统设置 → 隐私与安全性 → 屏幕录制」的直达链接，旧版系统也能落到对应面板。 */
const SCREEN_CAPTURE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** 引导弹窗一次只开一个：启动提示还没关、用户又按了快捷键时别叠两层。 */
let prompting = false;

/**
 * macOS 10.15+ 抓屏受 TCC「屏幕录制」权限管，缺失时 `desktopCapturer`
 * 只能截到桌面壁纸。macOS 没有编程式申请 API，原生弹窗也只在首次真正
 * 抓屏时出现一次，被拒过就再也不会弹 —— 只能去系统设置手动勾选。
 * 未授权时弹引导框并直达设置页；非 macOS 恒放行。
 *
 * @returns 是否可以直接抓屏。
 */
export async function ensureScreenCaptureAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  console.log(`[permission] 屏幕录制权限状态：${status}`);
  if (status === 'granted') {
    return true;
  }
  // 发起一次真实抓屏请求：状态是「从未询问」时 macOS 会弹**原生**授权框，
  // 并把当前二进制自动登记进授权列表 —— 用户点「打开系统设置」开开关即可，
  // 免去手动 + 添加（选错 Electron 副本授权就粘不住）。已拒绝时此调用无害，
  // 返回的壁纸占位图直接丢弃，随后仍走手动引导。
  await desktopCapturer
    .getSources({ types: ['screen'] })
    .catch((err: unknown) => console.warn('[permission] 抓屏探测失败', err));
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') {
    console.log('[permission] 授权后状态已变为 granted');
    return true;
  }
  await promptScreenPermission();
  return false;
}

async function promptScreenPermission(): Promise<void> {
  if (prompting) return;
  prompting = true;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: '截图需要「屏幕录制」权限',
      detail:
        'macOS 要求单独授权才能捕捉屏幕内容，未授权时只能截到桌面壁纸。\n\n' +
        '请在「隐私与安全性 → 录屏与系统录音」中勾选本应用，重启后生效。\n' +
        '若是从终端启动的开发实例，macOS 会把权限归属到终端本身 —— ' +
        '需要勾选的是启动它的终端应用（如 Warp / iTerm2 / Terminal）。',
      buttons: ['打开系统设置', '暂不'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await shell.openExternal(SCREEN_CAPTURE_SETTINGS_URL);
    }
  } finally {
    prompting = false;
  }
}
