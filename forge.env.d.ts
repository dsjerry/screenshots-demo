/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

// forge-vite-env 只声明了 MAIN_*，其余 renderer 的 define 是运行时自动生成的，
// 类型声明需要在这里手工补上（保持无 import，否则本文件不再是全局 script）。
declare const OVERLAY_VITE_DEV_SERVER_URL: string;
declare const OVERLAY_VITE_NAME: string;
declare const PIN_VITE_DEV_SERVER_URL: string;
declare const PIN_VITE_NAME: string;
declare const SCROLL_VITE_DEV_SERVER_URL: string;
declare const SCROLL_VITE_NAME: string;
declare const HISTORY_VITE_DEV_SERVER_URL: string;
declare const HISTORY_VITE_NAME: string;

// Vite 的 ?raw 后缀导入：lucide-static 的图标以原始 SVG 字符串进包
declare module '*.svg?raw' {
  const svg: string;
  export default svg;
}
