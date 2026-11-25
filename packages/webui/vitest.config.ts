import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 页面组件与网关的 hook 都要 DOM：jsdom 环境，公共设置在 src/test-setup.ts（jest-dom 断言、每个用例后卸载）。
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
