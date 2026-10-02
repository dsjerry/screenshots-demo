import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  // 别 watch 打包产物：`npm run make` 会往 out/ 里写几十万个文件，
  // dev watcher 会去 fs.watch 它们，Windows 上直接 EBUSY 把 Forge 打崩
  server: {
    watch: { ignored: ['**/out/**', '**/dist/**', '**/node_modules/**'] },
  },
  build: {
    rollupOptions: {
      input: path.resolve(__dirname, 'history.html'),
    },
  },
});
