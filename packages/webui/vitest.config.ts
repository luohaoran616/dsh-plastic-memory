import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // gateway 是纯 fetch 封装，Node 环境就能跑；页面组件不在这里测（走浏览器走查）。
    include: ['src/**/*.spec.ts'],
  },
})
