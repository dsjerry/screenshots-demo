import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // get-windows / koffi 必须保持外部化：原生 .node 模块不能进 bundle
      //（get-windows 还依赖 import.meta.url 定位二进制，打进 bundle 还会
      // 卷入 node-pre-gyp 的顶层 require；koffi 是滚动截图注入滚轮用的
      // FFI 库）。运行时从 node_modules 加载。
      external: ['get-windows', 'koffi'],
    },
  },
});
