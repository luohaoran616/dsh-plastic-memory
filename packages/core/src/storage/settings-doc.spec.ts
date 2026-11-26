import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsDocSchema, type SettingsDoc } from './schema.ts'
import { DocFileTable, SETTINGS_FILE } from './settings-doc.ts'

const doc = (revision: number, set: Record<string, unknown> = {}): SettingsDoc => ({ version: 1, revision, set, unset: [] })

describe('设置文档表', () => {
  let dir: string
  let path: string
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  let table: DocFileTable<SettingsDoc>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pm-settings-'))
    path = join(dir, SETTINGS_FILE)
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    table = new DocFileTable(path, settingsDocSchema, { locked: fn => fn(), log })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('文件不存在时读到 missing，读不建目录', async () => {
    expect(await table.read()).toEqual({ status: 'missing' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('mutate 写出整份文档，再次读回同一份；内容相同不写、不改版本号', async () => {
    const first = await table.mutate(() => doc(1, { template: 'coding' }))
    expect(first).toEqual({ ok: true, doc: doc(1, { template: 'coding' }) })
    expect(await table.read()).toEqual({ status: 'ready', doc: doc(1, { template: 'coding' }) })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(doc(1, { template: 'coding' }))
    // 内容逐字相同：fn 给的新对象也当没改
    expect(await table.mutate(current => ({ ...current!, set: { template: 'coding' } }))).toEqual({ ok: true, doc: doc(1, { template: 'coding' }) })
    expect((await table.read())).toEqual({ status: 'ready', doc: doc(1, { template: 'coding' }) })
  })

  it('expectedRevision 对不上回 conflict 并带上当前文档，不调 fn', async () => {
    await table.mutate(() => doc(7))
    const fn = vi.fn(() => doc(8))
    expect(await table.mutate(fn, 6)).toEqual({ ok: false, reason: 'conflict', current: doc(7) })
    expect(fn).not.toHaveBeenCalled()
    expect(await table.read()).toEqual({ status: 'ready', doc: doc(7) })
  })

  it('文件不存在时版本号按 0：带 0 能写，带别的回 conflict', async () => {
    expect(await table.mutate(() => doc(1), 0)).toEqual({ ok: true, doc: doc(1) })
    await rm(dir, { recursive: true, force: true })
    expect(await table.mutate(() => doc(1), 3)).toEqual({ ok: false, reason: 'conflict' })
  })

  it('fn 抛错时什么都不写', async () => {
    await table.mutate(() => doc(1))
    await expect(table.mutate(() => { throw new Error('不合法') }, 1)).rejects.toThrow('不合法')
    expect(await table.read()).toEqual({ status: 'ready', doc: doc(1) })
  })

  it('坏文件：读到 corrupt、报一次警，mutate 回绝、不去覆盖', async () => {
    await writeFile(path, '{ 不是 JSON', 'utf8')
    expect(await table.read()).toEqual({ status: 'corrupt', detail: expect.any(String) })
    expect(await table.read()).toEqual({ status: 'corrupt', detail: expect.any(String) })
    expect(log.warn).toHaveBeenCalledTimes(1)
    const fn = vi.fn(() => doc(1))
    expect(await table.mutate(fn)).toEqual({ ok: false, reason: 'corrupt' })
    expect(fn).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe('{ 不是 JSON')
  })

  it('形状不对的文档同样按 corrupt：版本号缺失、unset 不是路径数组', async () => {
    await writeFile(path, JSON.stringify({ version: 1, set: {} }), 'utf8')
    expect((await table.read()).status).toBe('corrupt')
    await writeFile(path, JSON.stringify({ version: 1, revision: 1, set: {}, unset: 'scenes' }), 'utf8')
    expect((await table.read()).status).toBe('corrupt')
  })

  it('别的进程写了之后读到新内容（按签名缓存，不认旧缓存）', async () => {
    await table.mutate(() => doc(1))
    await writeFile(path, JSON.stringify(doc(2, { template: 'office' })), 'utf8')
    expect(await table.read()).toEqual({ status: 'ready', doc: doc(2, { template: 'office' }) })
  })

  it('mutate 在锁内读此刻的文件：锁外缓存落后也不拿缓存的版本号去判冲突', async () => {
    await table.mutate(() => doc(1))
    expect(await table.read()).toEqual({ status: 'ready', doc: doc(1) })
    await writeFile(path, JSON.stringify(doc(5)), 'utf8')
    expect(await table.mutate(() => doc(6), 5)).toEqual({ ok: true, doc: doc(6) })
  })
})
