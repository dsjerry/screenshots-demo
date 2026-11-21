/**
 * IPC 通道名的唯一来源 —— 任何地方都不允许写字符串字面量。
 *
 * 覆盖层与贴图的通道已迁入 electron-snip（`snip:` 前缀，见包的 channels.ts），
 * 这里只保留应用自己的通道：设置、历史、录屏、长图、启动截图等。
 * 通道名不允许写字符串字面量。
 */
export const CH = {
  recordFrame: 'record:frame',
  recordStatus: 'record:status',
  recordExport: 'record:export',
  recordAction: 'record:action',
  recordInk: 'record:ink',
  recordInkInput: 'record:inkInput',
  recordBrush: 'record:brush',
  recordBrushSet: 'record:brushSet',
  recordShapes: 'record:shapes',
  recordClick: 'record:click',
  recordTimeline: 'record:timeline',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsPickDir: 'settings:pickDir',
  historyBoot: 'history:boot',
  historyThumb: 'history:thumb',
  historyAction: 'history:action',
  historyOpen: 'history:open',

  appState: 'app:state',
  appStartSnip: 'app:startSnip',
} as const;
