// window-probe —— 悬停窗口捕获的 macOS 探针。
// 用 CGWindowListCopyWindowInfo 按屏幕 z 序枚举普通窗口，stdout 输出 JSON：
//   [{"pid":123,"x":0,"y":0,"w":1440,"h":900}, ...]
// 坐标是全局显示空间的「点」（= mac 的 DIP），原点在主屏左上、y 向下，
// 与 Electron screen 坐标同系。数组顺序即 z 序（前 → 后）。
// 只取 bounds / z 序 / PID，不取窗口名 —— 因此不需要任何 TCC 授权
// （get-windows 在 mac 上要「辅助功能」权限，这里整个免掉）。
// 构建见 build-window-probe.sh；产物随 app 以 extraResource 打包。

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <stdlib.h>
#import <string.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    int excludePid = -1;
    for (int i = 1; i + 1 < argc; i += 2) {
      if (strcmp(argv[i], "--exclude-pid") == 0) excludePid = atoi(argv[i + 1]);
    }

    // OnScreenOnly：只留当前在屏上的；ExcludeDesktopElements：去掉桌面图标层
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID);
    if (!list) return 1;

    NSMutableArray<NSDictionary *> *windows = [NSMutableArray array];
    for (NSDictionary *info in (__bridge NSArray *)list) {
      // 只留普通层：菜单栏 / Dock / 系统浮层 / 灵动岛类都在非 0 层
      if ([info[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
      int pid = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
      if (pid == excludePid) continue;
      // 调用方已按 PID 过滤自家进程，这里再按激活策略兜底：只留常规 app，
      // 滤掉后台代理 / 登录项 / 代理图标类的隐形窗口
      NSRunningApplication *app =
          [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
      if (!app || app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
      // 在屏但 alpha 为 0 的窗口不可见，不该命中
      NSNumber *alpha = info[(__bridge NSString *)kCGWindowAlpha];
      if (alpha && [alpha doubleValue] < 0.01) continue;

      CGRect rect = CGRectZero;
      if (!CGRectMakeWithDictionaryRepresentation(
              (__bridge CFDictionaryRef)info[(__bridge NSString *)kCGWindowBounds],
              &rect)) {
        continue;
      }
      if (rect.size.width <= 0 || rect.size.height <= 0) continue;
      // owner 名（截图历史的「来源应用」用）：NSRunningApplication 的
      // localizedName 优先，缺了退回 CGWindowList 自带的 owner name
      NSString *name = app.localizedName;
      if (!name) name = info[(__bridge NSString *)kCGWindowOwnerName];
      [windows addObject:@{@"pid" : @(pid),
                           @"app" : name ?: @"",
                           @"x" : @(rect.origin.x),
                           @"y" : @(rect.origin.y),
                           @"w" : @(rect.size.width),
                           @"h" : @(rect.size.height)}];
    }
    CFRelease(list);

    NSData *json = [NSJSONSerialization dataWithJSONObject:windows options:0 error:nil];
    if (json) [[NSFileHandle fileHandleWithStandardOutput] writeData:json];
  }
  return 0;
}
