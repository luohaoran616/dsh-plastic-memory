import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 页面组件与网关的 hook 都要 DOM：jsdom 环境，公共设置在 src/test-setup.ts（jest-dom 断言、每个用例后卸载）。
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    environment: 'jsdom',
    // 样式要能按 `?raw` 读成字符串（host-tokens.spec.ts 核对令牌定义）；默认关掉 CSS 处理时它读回来是空串。
    css: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
