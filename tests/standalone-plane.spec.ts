import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeRecord } from '@plastic/core/storage/frontmatter.ts'
import { KV_IMPORT_MARKER } from '@plastic/core/storage/legacy-kv-import.ts'
import { GLOBAL_DIR, STATE_DIR } from '@plastic/core/storage/paths.ts'
import type { MemoryLogger } from '@plastic/core/store.ts'
import {
  deletedViewSchema, libraryViewSchema, memoryCommandResultSchema, workspaceMapViewSchema,
} from '../src/gui/contract.ts'
import { createGuiPlane, standaloneInstructions } from '../src/standalone/plane.ts'
import { record } from './helpers/record.ts'

// 无宿主装配：真实临时目录做记忆根，/memory 命令与视图文件都走 src/standalone/plane.ts 的那一套，
// 只把宿主那一侧（模型、打开文件）换成测试桩。断言视图文件的终态与命令结果。

const PROJECT = '/tmp/pm-standalone-project'
const quiet: MemoryLogger = { info() {}, warn() {}, error() {} }

let root: string
let outside: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-standalone-plane-'))
  outside = await mkdtemp(join(tmpdir(), 'pm-standalone-outside-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

/** 直接落一条全局记忆文件（记录经 encodeRecord 写盘，同 gui-commands 里手写文件的写法）。 */
async function seed(partial: Parameters<typeof record>[0] = {}): Promise<string> {
  const memory = record({ id: 'mem_f', name: '丁', ...partial })
  await mkdir(join(root, GLOBAL_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, `${memory.id}.md`), encodeRecord(memory, {}))
  return memory.id
}

type ViewText = { status: 'ready'; text: string } | { status: 'missing' }

const readyText = (view: ViewText): string => {
  expect(view.status, '视图文件没有写出来').toBe('ready')
  if (view.status !== 'ready') throw new Error('视图文件没有写出来')
  return view.text
}

/** 命令结果的契约 JSON；处理器成功也带 text，缺了按空串解析失败处理。 */
const resultOf = (result: { kind: 'success' | 'error'; text?: string }) =>
  memoryCommandResultSchema.parse(JSON.parse(result.text ?? ''))

describe('createGuiPlane', () => {
  it('创建时写出全局视图并登记项目归属', async () => {
    const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet })
    try {
      const library = libraryViewSchema.parse(JSON.parse(readyText(await plane.readView('library'))))
      expect(library.memoryRoot).toBe(root)
      const workspaces = workspaceMapViewSchema.parse(JSON.parse(readyText(await plane.readView('workspaces'))))
      expect(workspaces.cwds[PROJECT]).toBe(PROJECT)
      // 探针语义：独立面不写「旧 KV 已结清」的标记，宿主将来还能导入
      await expect(stat(join(root, STATE_DIR, KV_IMPORT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await plane.dispose()
    }
  })

  it('命令走同一个处理器', async () => {
    const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet })
    try {
      const info = await plane.run('/memory info')
      expect(info.kind).toBe('success')
      const body = resultOf(info)
      expect(body.ok).toBe(true)
      if (!body.ok || body.info === undefined) throw new Error(`不是 info 结果：${JSON.stringify(body)}`)
      expect(body.info.memoryRoot).toBe(root)
      // 未知子命令走同一个解析器：按契约回错误结果，不是抛错
      const unknown = await plane.run('/memory 不存在的子命令')
      expect(unknown.kind).toBe('error')
      expect(resultOf(unknown).ok).toBe(false)
    } finally {
      await plane.dispose()
    }
  })

  it('model-info 反映模型有无', async () => {
    const withLlm = await createGuiPlane({
      memoryRoot: root, project: PROJECT, log: quiet,
      llm: { model: 'm', complete: async () => 'ok' },
    })
    try {
      expect(resultOf(await withLlm.run('/memory model-info'))).toMatchObject({ ok: true, cmd: 'model-info', model: 'm' })
    } finally {
      await withLlm.dispose()
    }
    const withoutLlm = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet })
    try {
      expect(resultOf(await withoutLlm.run('/memory model-info'))).toMatchObject({ ok: false, cmd: 'model-info', code: 'llm-unavailable' })
    } finally {
      await withoutLlm.dispose()
    }
  })

  it('忘记后出现在最近删除、恢复后回来', async () => {
    const memoryId = await seed()
    const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet })
    try {
      const forgot = resultOf(await plane.run(`/memory forget {"memoryId":"${memoryId}"}`))
      expect(forgot.ok, JSON.stringify(forgot)).toBe(true)
      const deleted = deletedViewSchema.parse(JSON.parse(readyText(await plane.readView('deleted'))))
      expect(deleted.items.map(i => i.memory.id)).toContain(memoryId)

      // 最近删除的恢复入口是 restore：forget 不记待决条目，undo 只撤账本里已结清的条目
      const restored = resultOf(await plane.run(`/memory restore {"memoryId":"${memoryId}"}`))
      expect(restored.ok, JSON.stringify(restored)).toBe(true)
      const library = libraryViewSchema.parse(JSON.parse(readyText(await plane.readView('library'))))
      expect(library.layers.flatMap(l => l.items.map(m => m.id))).toContain(memoryId)
      const after = deletedViewSchema.parse(JSON.parse(readyText(await plane.readView('deleted'))))
      expect(after.items.map(i => i.memory.id)).not.toContain(memoryId)
    } finally {
      await plane.dispose()
    }
  })

  it('记忆根外的文件读不到', async () => {
    await writeFile(join(root, 'inside.txt'), '根内正文')
    const outsideFile = join(outside, 'outside.txt')
    await writeFile(outsideFile, '根外正文')
    // 根内的符号链接指向根外：文件一份、目录一份
    await symlink(outsideFile, join(root, 'escape.md'))
    await symlink(outside, join(root, 'escape-dir'))
    // 和记忆根只差路径前缀字符串的邻居目录：前缀比较按路径段才行
    const sibling = `${root}-sibling`
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'passwd'), '邻居')
    const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet })
    try {
      expect(await plane.readFile(join(root, 'inside.txt'))).toBe('根内正文')
      expect(await plane.readFile(outsideFile)).toBeUndefined()
      expect(await plane.readFile(join(root, '..', '..', 'etc', 'passwd'))).toBeUndefined()
      expect(await plane.readFile(join(root, 'escape.md'))).toBeUndefined()
      expect(await plane.readFile(join(root, 'escape-dir', 'outside.txt'))).toBeUndefined()
      expect(await plane.readFile(join(sibling, 'passwd'))).toBeUndefined()
    } finally {
      await plane.dispose()
      await rm(sibling, { recursive: true, force: true })
    }
  })

  it('记忆根外的路径不打开', async () => {
    const calls: Array<{ path: string; action: 'open' | 'reveal' }> = []
    const open = async (path: string, action: 'open' | 'reveal') => {
      calls.push({ path, action })
      return true
    }
    const outsideFile = join(outside, 'outside.txt')
    await writeFile(outsideFile, '根外正文')
    await symlink(outsideFile, join(root, 'escape.md'))
    await writeFile(join(root, 'inside.txt'), '根内正文')
    // 根内的符号链接指向根内另一份：交给 opener 的是解析后的目标，不是链接本身
    await writeFile(join(root, 'alias-target.txt'), '根内目标')
    await symlink(join(root, 'alias-target.txt'), join(root, 'alias.md'))
    const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet, open })
    try {
      expect(await plane.openPath(outsideFile, 'open')).toBe(false)
      expect(await plane.openPath(join(root, 'escape.md'), 'reveal')).toBe(false)
      expect(calls).toEqual([])
      const inside = join(root, 'inside.txt')
      expect(await plane.openPath(inside, 'reveal')).toBe(true)
      expect(calls).toEqual([{ path: await realpath(inside), action: 'reveal' }])
      expect(await plane.openPath(join(root, 'alias.md'), 'open')).toBe(true)
      expect(calls[calls.length - 1]).toEqual({ path: await realpath(join(root, 'alias-target.txt')), action: 'open' })
    } finally {
      await plane.dispose()
    }
  })

  it('释放后不留计时器', async () => {
    // 只假计时器（含清理函数）：视图写入的 setImmediate 与 fs 照常走真实实现；时钟用注入的，避免替换间隔真等
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let clock = 1000
    try {
      const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet, autoCheckup: true, now: () => clock })
      // 调度器的首次检查与间隔检查都注册在注入的计时器上
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      // 时钟往前拨：dispose 重写待处理视图时不按替换间隔真等
      clock = 10_000
      await plane.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('指令文件读取不抛错', async () => {
    const scopes = [
      { kind: 'global' as const },
      { kind: 'workspace' as const, workspacePath: join(root, 'a-project') },
    ]
    for (const scope of scopes) {
      const files = await standaloneInstructions(scope)
      expect(['found', 'none', 'unavailable']).toContain(files.kind)
    }
    // 不注入 instructions 时用的就是它：平面照常创建、命令照常能跑
    const plane = await createGuiPlane({ memoryRoot: root, project: PROJECT, log: quiet })
    try {
      expect((await plane.run('/memory info')).kind).toBe('success')
    } finally {
      await plane.dispose()
    }
  })
})
