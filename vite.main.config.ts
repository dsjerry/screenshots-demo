import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // get-windows（窗口捕获）必须保持外部化：它是「ESM + 原生二进制 +
      // 用 import.meta.url 定位 .node」的包，打迸 bundle 会丢运行时上下文，
      // 还会把它可选依赖 @mapbox/node-pre-gyp 的 require('mock-aws-s3') 等
      // 顶层 require 一起卷进来，运行时 MODULE_NOT_FOUND。
      // 外部化后运行时从 node_modules 加载（Electron 的 Node 支持 require ESM）。
      external: ['get-windows'],
    },
  },
});
