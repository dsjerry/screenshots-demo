/**
 * 钉图窗口的布局常量。
 *
 * 窗口 = 图像 + **每侧自适应的阴影留白**：外阴影是画在窗口里的
 * （`transparent` 窗口 + CSS `box-shadow`），所以得先给阴影留出地方。
 * 主进程算每侧留白并随 `pin:boot` 下发，渲染进程按同一个 padding 让开画布 ——
 * 两边不一致的话，画布就会压在阴影上。
 *
 * 某一侧贴着屏幕边缘时留白是 0 —— 那边本来也没地方画阴影（桌面到头了）。
 */
export const PIN_SHADOW_PAD = 16;

/** 图像区最小 DIP 尺寸（选区过小时撑一下，免得窗口退化成一条缝）。 */
export const PIN_MIN_WIDTH = 120;
export const PIN_MIN_HEIGHT = 90;

/** 窗口四边的阴影留白（虚拟屏 DIP）。 */
export interface PinPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
