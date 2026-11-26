import { DocFileTable, SETTINGS_FILE, settingsDocSchema } from '../src/storage/settings-doc.ts'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore, STATE_DIR } from '../src/storage/sidecar.ts'
import { memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema, adviceIgnoreSchema } from '../src/governance/schema.ts'
import {
  DEFAULT_MEMORY_SETTINGS, MemorySettings, MemorySettingsError,
  applySettingsOps, createSettingsRegistry, resolveMemorySettings, validateMemorySettings,
  type SettingsPathOp,
} from '../src/governance/memory-settings.ts'

const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }

const doc = (revision: number, set: Record<string, unknown> = {}, unset: string[][] = []): {
  version: 1; revision: number; set: Record<string, unknown>; unset: string[][]
} => ({ version: 1, revision, set, unset })

describe('设置语义：叠加与路径操作', () => {
  it('出厂值：文档不存在时按出厂值运行', () => {
    expect(resolveMemorySettings(undefined)).toEqual(DEFAULT_MEMORY_SETTINGS)
    expect(resolveMemorySettings(doc(0))).toEqual(DEFAULT_MEMORY_SETTINGS)
  })

  it('set 整值覆盖、按树深合并，其余字段保持出厂值', () => {
    const resolved = resolveMemorySettings(doc(1, { template: 'coding', snapshotTokenBudget: 2500 }))
    expect(resolved.template).toBe('coding')
    expect(resolved.snapshotTokenBudget).toBe(2500)
    expect(resolved.snapshotOverflow).toBe(DEFAULT_MEMORY_SETTINGS.snapshotOverflow)
    expect(resolved.scenes).toEqual(DEFAULT_MEMORY_SETTINGS.scenes)
  })

  it('unset 删掉显式值，回落出厂值', () => {
    const base = doc(2, { template: 'coding' }, [])
    const reverted = applySettingsOps(base, [{ op: 'unset', path: ['template'] }])
    expect(reverted.ok).toBe(true)
    expect(reverted.ok && resolveMemorySettings(reverted.doc).template).toBe(DEFAULT_MEMORY_SETTINGS.template)
  })

  it('ops 落法：set 深写入 set 树，字典按键并存', () => {
    const type = { label: '词汇', description: '词', whenToSave: '新词', recall: 'search', decayDays: null, governancePriority: 'low' }
    const next = applySettingsOps(doc(1), [
      { op: 'set', path: ['template'], value: 'coding' },
      { op: 'set', path: ['customTypes', 'vocab'], value: type },
      { op: 'set', path: ['customTypes', 'glossary'], value: type },
    ])
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.doc.set).toEqual({ template: 'coding', customTypes: { vocab: type, glossary: type } })
    expect(next.doc.revision).toBe(2)
  })

  it('ops 落法：unset 剪掉 set 里的空父级，记进 unset 列表', () => {
    const base = applySettingsOps(doc(1), [{ op: 'set', path: ['customTypes', 'vocab'], value: { label: '词汇' } }])
    expect(base.ok).toBe(true)
    if (!base.ok) return
    const next = applySettingsOps(base.doc, [{ op: 'unset', path: ['customTypes', 'vocab'] }])
    expect(next.ok).toBe(true)
    if (!next.ok) return
    expect(next.doc.set).toEqual({})
    expect(next.doc.unset).toEqual([['customTypes', 'vocab']])
    expect(next.doc.revision).toBe(3)
  })

  it('unset 覆盖已有的更深条目；set 覆盖它的祖先条目', () => {
    const deeper = doc(1, {}, [['scenes', 's1', 'label']])
    const merged = applySettingsOps(deeper, [{ op: 'unset', path: ['scenes', 's1'] }])
    expect(merged.ok && merged.doc.unset).toEqual([['scenes', 's1']])
    const withUnsetScene = doc(1, { scenes: { s1: { label: '写作', types: ['profile'] } } }, [['scenes']])
    const over = applySettingsOps(withUnsetScene, [{ op: 'set', path: ['scenes', 's1'], value: { label: '翻译', types: ['preference'] } }])
    expect(over.ok && over.doc.unset).toEqual([])
    expect(over.ok && over.doc.set.scenes).toEqual({ s1: { label: '翻译', types: ['preference'] } })
  })

  it('没有实际变化时不加版本号，回原文档', () => {
    const base = doc(5, { template: 'coding' })
    expect(applySettingsOps(base, [{ op: 'set', path: ['template'], value: 'coding' }])).toEqual({ ok: true, doc: base })
  })

  it('不合法路径整批拒绝，原文档不动', () => {
    const base = doc(3, { template: 'coding' })
    const next = applySettingsOps(base, [
      { op: 'set', path: ['snapshotTokenBudget'], value: 3000 },
      { op: 'set', path: ['customTypes', '__proto__'], value: { x: 1 } },
    ] satisfies SettingsPathOp[])
    expect(next.ok).toBe(false)
    expect(next.ok === false && next.issues.length).toBe(1)
    expect(base.set).toEqual({ template: 'coding' })
    // 空段、非字符串段同样拒
    expect(applySettingsOps(base, [{ op: 'set', path: ['scenes', ''], value: 1 }]).ok).toBe(false)
    expect(applySettingsOps(base, [{ op: 'unset', path: [] } as unknown as SettingsPathOp]).ok).toBe(false)
    expect(applySettingsOps(base, [{ op: 'unset', path: ['scenes', 3] } as unknown as SettingsPathOp]).ok).toBe(false)
  })
})

describe('设置语义：校验', () => {
  it('出厂值合法', () => {
    expect(validateMemorySettings(DEFAULT_MEMORY_SETTINGS)).toEqual([])
  })

  it('拒绝无意义的数值与不认识的枚举值', () => {
    expect(validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, snapshotTokenBudget: 0 })).toHaveLength(1)
    expect(validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, snapshotTokenBudget: 1.5 })).toHaveLength(1)
    expect(validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, snapshotOverflow: 'tight' })).toHaveLength(1)
    expect(validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, accent: 'crimson' })).toHaveLength(1)
    expect(validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, governance: { ...DEFAULT_MEMORY_SETTINGS.governance, health: { sensitivity: 'aggressive' } } })).toHaveLength(1)
    expect(validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, evidenceLookup: 'on' })).toHaveLength(1)
  })

  it('拒绝与内置类型重名、格式不对的自建类型', () => {
    const bad = { ...DEFAULT_MEMORY_SETTINGS, customTypes: { profile: { label: '画像', description: 'd', whenToSave: 'w', recall: 'core', decayDays: null, governancePriority: 'low' } } }
    expect(validateMemorySettings(bad)).toHaveLength(1)
    const badName = { ...DEFAULT_MEMORY_SETTINGS, customTypes: { 'My_Type': { label: 't', description: 'd', whenToSave: 'w', recall: 'core', decayDays: null, governancePriority: 'low' } } }
    expect(validateMemorySettings(badName)).toHaveLength(1)
    const missingLabel = { ...DEFAULT_MEMORY_SETTINGS, customTypes: { vocab: { label: '', description: 'd', whenToSave: 'w', recall: 'core', decayDays: null, governancePriority: 'low' } } }
    expect(validateMemorySettings(missingLabel)).toHaveLength(1)
    const badDecay = { ...DEFAULT_MEMORY_SETTINGS, customTypes: { vocab: { label: 't', description: 'd', whenToSave: 'w', recall: 'core', decayDays: 0, governancePriority: 'low' } } }
    expect(validateMemorySettings(badDecay)).toHaveLength(1)
  })

  it('拒绝保留 id 的场景与坏场景形状', () => {
    const reserved = { ...DEFAULT_MEMORY_SETTINGS, scenes: { custom: { label: '通用', types: ['profile'] } } }
    expect(validateMemorySettings(reserved)).toHaveLength(1)
    const noLabel = { ...DEFAULT_MEMORY_SETTINGS, scenes: { s1: { label: '', types: ['profile'] } } }
    expect(validateMemorySettings(noLabel)).toHaveLength(1)
    const badTypes = { ...DEFAULT_MEMORY_SETTINGS, scenes: { s1: { label: '写作', types: 'profile' } } }
    expect(validateMemorySettings(badTypes)).toHaveLength(1)
  })

  it('场景里列不存在的类型、removedPresetTypes 的陌生名字都放行（类型表警告并忽略）', () => {
    const ok = {
      ...DEFAULT_MEMORY_SETTINGS,
      scenes: { s1: { label: '写作', types: ['profile', 'no-such-type'] } },
      removedPresetTypes: ['procedure', 'no-such'],
    }
    expect(validateMemorySettings(ok)).toEqual([])
  })
})

describe('设置门面', () => {
  let root: string
  let path: string
  let warns: string[]
  let log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pm-settings-'))
    path = join(root, STATE_DIR, 'settings.json')
    warns = []
    log = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const make = (): MemorySettings => new MemorySettings(new DocFileTable(join(root, STATE_DIR, SETTINGS_FILE), settingsDocSchema, { locked: async <R>(fn: () => Promise<R>) => fn(), log: { info() {}, warn() {}, error() {} } }), log)

  it('文件不存在：快照按 ready（revision 0、出厂值、可写），current 给出厂值', async () => {
    const settings = make()
    expect(await settings.snapshot()).toEqual({ status: 'ready', revision: 0, value: DEFAULT_MEMORY_SETTINGS, writable: true })
    expect(await settings.current()).toEqual(DEFAULT_MEMORY_SETTINGS)
  })

  it('mutate 写入生效、版本号加一，落盘的是显式改动', async () => {
    const settings = make()
    const done = await settings.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    expect(done.ok).toBe(true)
    expect(done.ok && done.value.template).toBe('coding')
    expect(done.ok && done.revision).toBe(1)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(doc(1, { template: 'coding' }))
    expect(await settings.current()).toMatchObject({ template: 'coding' })
  })

  it('expectedRevision 过期回 conflict 并带当前值；重提交成功', async () => {
    const settings = make()
    await settings.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    const stale = await settings.mutate([{ op: 'set', path: ['template'], value: 'office' }], 0)
    expect(stale.ok).toBe(false)
    if (stale.ok === false && stale.reason === 'conflict') {
      expect(stale.current).toMatchObject({ revision: 1 })
      expect(stale.current?.value.template).toBe('coding')
    } else {
      expect.unreachable('应回 conflict')
    }
    const retry = await settings.mutate([{ op: 'set', path: ['template'], value: 'office' }], 1)
    expect(retry.ok).toBe(true)
    expect(retry.ok && retry.value.template).toBe('office')
    expect(retry.ok && retry.revision).toBe(2)
  })

  it('提交内容不合法回 invalid，什么都不写', async () => {
    const settings = make()
    const bad = await settings.mutate([{ op: 'set', path: ['snapshotTokenBudget'], value: 0 }])
    expect(bad).toEqual({ ok: false, reason: 'invalid', issues: expect.arrayContaining([expect.stringContaining('snapshotTokenBudget')]) })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const unsafe = await settings.mutate([{ op: 'set', path: ['customTypes', 'constructor'], value: {} }])
    expect(unsafe.ok).toBe(false)
    expect(unsafe.ok === false && unsafe.reason).toBe('invalid')
    expect(await settings.current()).toEqual(DEFAULT_MEMORY_SETTINGS)
  })

  it('坏文件：快照不可用、current 按出厂值并只报一次警、mutate 拒写、文件不被覆盖', async () => {
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(path, '{ broken')
    const settings = make()
    expect(await settings.snapshot()).toMatchObject({ status: 'unavailable', reason: 'corrupt' })
    expect(await settings.current()).toEqual(DEFAULT_MEMORY_SETTINGS)
    expect(await settings.current()).toEqual(DEFAULT_MEMORY_SETTINGS)
    expect(warns.filter(m => m.includes('设置文件读不出来'))).toHaveLength(1)
    const done = await settings.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    expect(done).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await readFile(path, 'utf8')).toBe('{ broken')
  })

  it('语义不合法：快照不可用（invalid）、current 按出厂值并报警', async () => {
    await mkdir(join(root, STATE_DIR), { recursive: true })
    await writeFile(path, `${JSON.stringify(doc(1, { snapshotTokenBudget: 0 }))}\n`)
    const settings = make()
    expect(await settings.snapshot()).toMatchObject({ status: 'unavailable', reason: 'invalid' })
    expect(await settings.current()).toEqual(DEFAULT_MEMORY_SETTINGS)
    expect(warns.some(m => m.includes('设置不合法'))).toBe(true)
  })

  it('两个进程共用一个记忆根：后建的门面读到先写的那份；旧版本号提交被拒', async () => {
    const first = make()
    await first.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    const second = make()
    expect(await second.current()).toMatchObject({ template: 'coding' })
    const snap = await second.snapshot()
    expect(snap).toMatchObject({ status: 'ready', revision: 1 })
    const stale = await second.mutate([{ op: 'set', path: ['template'], value: 'office' }], 0)
    expect(stale.ok === false && stale.reason).toBe('conflict')
    const fresh = await second.mutate([{ op: 'set', path: ['template'], value: 'office' }], 1)
    expect(fresh.ok).toBe(true)
    // 第一个进程手里的引用同样看得到（没有进程内缓存挡路）
    expect(await first.current()).toMatchObject({ template: 'office' })
  })
})

describe('设置驱动的类型表', () => {
  let root: string
  let warns: string[]
  let log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pm-settings-reg-'))
    warns = []
    log = { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const make = () => {
    const settings = new MemorySettings(new DocFileTable(join(root, STATE_DIR, SETTINGS_FILE), settingsDocSchema, { locked: async <R>(fn: () => Promise<R>) => fn(), log: { info() {}, warn() {}, error() {} } }), log)
    return createSettingsRegistry(settings, log)
  }

  it('出厂值下按通用场景运行；切成编码后 refresh 重建并回 true，再 refresh 回 false', async () => {
    const backed = await make()
    expect(backed.registry.has('procedure')).toBe(false)
    const settings = new MemorySettings(new DocFileTable(join(root, STATE_DIR, SETTINGS_FILE), settingsDocSchema, { locked: async <R>(fn: () => Promise<R>) => fn(), log: { info() {}, warn() {}, error() {} } }), log)
    await settings.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    expect(await backed.refresh()).toBe(true)
    expect(backed.registry.has('procedure')).toBe(true)
    expect(await backed.refresh()).toBe(false)
  })

  it('场景写错按通用场景运行并警告，refresh 照常回 true', async () => {
    const settings = new MemorySettings(new DocFileTable(join(root, STATE_DIR, SETTINGS_FILE), settingsDocSchema, { locked: async <R>(fn: () => Promise<R>) => fn(), log: { info() {}, warn() {}, error() {} } }), log)
    await settings.mutate([{ op: 'set', path: ['template'], value: 'no-such-scene' }])
    const backed = await make()
    expect(backed.registry.has('procedure')).toBe(false)
    expect(warns.some(m => m.includes('no-such-scene'))).toBe(true)
  })

  it('自建类型与场景的改动随之生效', async () => {
    const backed = await make()
    const settings = new MemorySettings(new DocFileTable(join(root, STATE_DIR, SETTINGS_FILE), settingsDocSchema, { locked: async <R>(fn: () => Promise<R>) => fn(), log: { info() {}, warn() {}, error() {} } }), log)
    await settings.mutate([
      { op: 'set', path: ['customTypes', 'vocab'], value: { label: '词汇', description: '词条', whenToSave: '新词', recall: 'search', decayDays: null, governancePriority: 'low' } },
      { op: 'set', path: ['scenes', 's1'], value: { label: '词汇工作', types: ['profile', 'knowledge', 'vocab'] } },
      { op: 'set', path: ['template'], value: 's1' },
    ])
    expect(await backed.refresh()).toBe(true)
    expect(backed.registry.has('vocab')).toBe(true)
    expect(backed.registry.get('vocab').label).toBe('词汇')
    // 通用五类照常在场
    expect(backed.registry.has('knowledge')).toBe(true)
    expect(backed.registry.renderSaveDescription()).toContain('vocab')
  })

  it('抛错的类型表不会出现：与内置类型重名的提交先被校验拦下', async () => {
    const settings = new MemorySettings(new DocFileTable(join(root, STATE_DIR, SETTINGS_FILE), settingsDocSchema, { locked: async <R>(fn: () => Promise<R>) => fn(), log: { info() {}, warn() {}, error() {} } }), log)
    const bad = await settings.mutate([{ op: 'set', path: ['customTypes', 'profile'], value: { label: '画像', description: 'd', whenToSave: 'w', recall: 'core', decayDays: null, governancePriority: 'low' } }])
    expect(bad.ok).toBe(false)
    const backed = await make()
    expect(backed.registry.has('knowledge')).toBe(true)
    expect(warns.some(m => m.includes('重名'))).toBe(false)
  })
})

// MemorySettingsError 在 resolve 里抛出（校验失败）：单独验形状
describe('MemorySettingsError', () => {
  it('带问题清单', () => {
    const err = new MemorySettingsError(['a: bad', 'b: bad'])
    expect(err.issues).toEqual(['a: bad', 'b: bad'])
    expect(err.message).toContain('a: bad')
  })
})
