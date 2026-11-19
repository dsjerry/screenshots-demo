import { defineConfig } from 'vitest/config';

// 宿主目前只有纯逻辑测试（长图拼接匹配等），跑在 node 环境即可。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
