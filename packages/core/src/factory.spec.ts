import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryRecord } from './record-schema.ts'
import type { RootLock } from './root-lock.ts'
import type { MemoryLogger } from './storage/table.ts'
import { STATE_DIR } from './storage/paths.ts'
import { createMemoryCore } from './factory.ts'

/** 测试里不关心日志；jieba 缺包、锁退回进程内等降级告警在这里会出现，别污染用例输出。 */
const silentLog: MemoryLogger = { info() {}, warn() {}, error() {} }

let seq = 0
function record(partial: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1
  return {
    id: `mem_factory_${seq}`,
    name: '条目',
    type: 'knowledge',
    scope: 'global',
    tags: [],
    content: '内容',
    summary: '摘要',
    source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' },
    createdAt: 1,
    updatedAt: 1,
    lastConfirmedAt: 1,
    lastRecalledAt: null,
    recallCount: 0,
    status: 'active',
    confidence: 0.9,
    ...partial,
  }
}

describe('createMemoryCore', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'plastic-core-factory-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('store.create 落盘后 search 能按 title 命中，写入走记忆根写锁', async () => {
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      const r = record({ name: '包管理用 pnpm', summary: '包管理选型', content: '这个仓库的包管理一律用 pnpm' })
      await core.store.create(r)
      const { hits } = await core.search({ query: 'pnpm' })
      expect(hits.map(h => h.id)).toEqual([r.id])
      expect(hits[0]).toMatchObject({ title: '包管理用 pnpm', type: 'knowledge', summary: '包管理选型' })
      expect(hits[0]!.content).toContain('pnpm')
      expect(hits[0]!.path.startsWith(root)).toBe(true)
      expect((await stat(hits[0]!.path)).isFile()).toBe(true)
      // 写锁库按跨版本契约落在 .state/lock/ 下：写路径确实经工厂注入的那把锁
      expect((await stat(join(root, STATE_DIR, 'lock', 'write-lock.sqlite'))).isFile()).toBe(true)
    } finally {
      await core.close()
    }
  })

  it('中文查询按查询侧分词器命中 name', async () => {
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      const r = record({ name: '包管理用 pnpm' })
      await core.store.create(r)
      const { hits } = await core.search({ query: '包管理' })
      expect(hits.map(h => h.id)).toEqual([r.id])
    } finally {
      await core.close()
    }
  })

  it('search 缺省截断到 8 条，topK 可覆盖', async () => {
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      for (let i = 0; i < 10; i++) await core.store.create(record({ name: `alpha note ${i}` }))
      expect((await core.search({ query: 'alpha' })).hits).toHaveLength(8)
      expect((await core.search({ query: 'alpha', topK: 3 })).hits).toHaveLength(3)
    } finally {
      await core.close()
    }
  })

  it('search 按 project 限定作用域，缺省按 workspacePath 读可见集合', async () => {
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      const global = record({ name: '全局 note' })
      const a = record({ name: 'a 项目 note', scope: 'workspace', workspacePath: '/proj/a' })
      const b = record({ name: 'b 项目 note', scope: 'workspace', workspacePath: '/proj/b' })
      for (const r of [global, a, b]) await core.store.create(r)
      const ids = async (input: { project?: string; workspacePath?: string }) =>
        (await core.search({ query: 'note', ...input })).hits.map(h => h.id).sort()
      expect(await ids({ project: 'global' })).toEqual([global.id])
      expect(await ids({ project: '/proj/a' })).toEqual([a.id])
      expect(await ids({ workspacePath: '/proj/a' })).toEqual([global.id, a.id].sort())
      expect(await ids({})).toEqual([global.id])
    } finally {
      await core.close()
    }
  })

  it('search 不返回已软删与已过期的记录', async () => {
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      const live = record({ name: 'live note' })
      const expired = record({ name: 'expired note', validTo: 1 })
      const removed = record({ name: 'removed note' })
      for (const r of [live, expired, removed]) await core.store.create(r)
      expect(await core.store.softDelete({ id: removed.id, workspacePath: undefined })).toBe(true)
      const { hits } = await core.search({ query: 'note' })
      expect(hits.map(h => h.id)).toEqual([live.id])
    } finally {
      await core.close()
    }
  })

  it('召回统计写 .state/recall-stats.json，记忆文件不带统计字段', async () => {
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      const r = record({ name: 'recall note' })
      await core.store.create(r)
      await core.store.markRecalled([r.id], 42)
      const stats = JSON.parse(await readFile(join(root, STATE_DIR, 'recall-stats.json'), 'utf8')) as Record<string, unknown>
      expect(stats[r.id]).toEqual({ id: r.id, recallCount: 1, lastRecalledAt: 42 })
      expect((await core.store.get(r.id))!.recallCount).toBe(1)
      expect(await readFile((await core.search({ query: 'recall' })).hits[0]!.path, 'utf8')).not.toContain('recallCount')
    } finally {
      await core.close()
    }
  })

  it('close 幂等，关闭后同一 root 可再起一个 core（锁库不残留占用）', async () => {
    const first = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    const r1 = record({ name: 'first note' })
    await first.store.create(r1)
    await first.close()
    await first.close() // 幂等

    const second = await createMemoryCore({ root, client: 'test-client', log: silentLog })
    try {
      const r2 = record({ name: 'second note' })
      await second.store.create(r2)
      const { hits } = await second.search({ query: 'note' })
      expect(hits.map(h => h.id).sort()).toEqual([r1.id, r2.id].sort())
    } finally {
      await second.close()
    }
  })

  it('client 作为组装参数带在 core 上，供写入路径标记来源', async () => {
    const core = await createMemoryCore({ root, client: 'zcode', log: silentLog })
    try {
      expect(core.client).toBe('zcode')
    } finally {
      await core.close()
    }
  })

  it('注入的锁被写路径使用：给了锁就不再自建一把', async () => {
    // 同一进程里 core 与别的装配共用一把锁时，注入的那把就是唯一的写锁
    const calls: number[] = []
    const stub: RootLock = { run: async <T>(fn: () => Promise<T>): Promise<T> => { calls.push(1); return fn() } }
    const core = await createMemoryCore({ root, client: 'test-client', log: silentLog, lock: stub })
    try {
      await core.store.create(record({ name: '注入锁的条目' }))
      expect(calls.length).toBeGreaterThan(0)
      // 写走的是注入的锁：自建的锁库没有出现
      await expect(stat(join(root, STATE_DIR, 'lock', 'write-lock.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await core.close()
    }
  })
})
