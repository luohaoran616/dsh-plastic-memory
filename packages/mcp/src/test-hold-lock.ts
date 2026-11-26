import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRootLock } from '@plastic/core/storage/root-lock.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import type { MemoryTools } from './tools.ts'

/**
 * 测试专用钩子（concurrency.spec 的「持锁崩溃」用例）：设了 PLASTIC_MCP_TEST_HOLD_LOCK=<信号目录> 时，
 * memory_save 落盘成功后，在同一把记忆根写锁内写 `<目录>/held` 并等 `<目录>/go` 才返回。
 * 用例据此在「子进程确实握着 core 那把跨进程写锁」时 kill -9，不靠 sleep 竞态。生产不设这个变量时 bin 不会加载本模块。
 */
export function withTestHoldLock(
  tools: MemoryTools,
  options: { root: string; dir: string; log: MemoryLogger },
): MemoryTools {
  return {
    ...tools,
    save: async (input) => {
      const result = await tools.save(input)
      const lock = createRootLock({ root: options.root, log: options.log })
      await lock.run(async () => {
        await writeFile(join(options.dir, 'held'), '')
        for (;;) {
          try {
            await access(join(options.dir, 'go'))
            return
          } catch {
            await delay(5)
          }
        }
      })
      return result
    },
  }
}
