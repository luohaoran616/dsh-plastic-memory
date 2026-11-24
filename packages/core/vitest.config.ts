import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // 仓库的用例目前都在根 tests/ 下（它们 import @plastic/core 的源码跑）；core 自带的用例还没搬起来，
    // 空集合不算失败，`pnpm -r test` 才不会被这条绊住。core 有 src/**/*.spec.ts 后这条自然失效。
    passWithNoTests: true,
  },
})
