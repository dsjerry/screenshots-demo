import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // 原生 .node 模块必须保持外部化，在运行时从 node_modules 加载。
      external: ['get-windows', 'koffi', 'electron-liquid-glass'],
    },
  },
});
