import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // core 自带 src/**/*.spec.ts（factory.spec.ts 等）。不开 passWithNoTests：用例被改名或移走时，
    // `pnpm -r test` 要红着报出来，而不是绿着跑零条（R9 要堵的静默漏洞）。
    include: ['src/**/*.spec.ts'],
  },
})
