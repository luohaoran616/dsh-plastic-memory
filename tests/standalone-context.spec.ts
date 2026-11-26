import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import type { MemoryLogger } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { assembleSnapshot } from '../src/snapshot.ts'
import { prereadSnapshot } from '../src/runtime.ts'
import { DEFAULT_MEMORY_SETTINGS } from '../src/governance/memory-settings.ts'
import { createContextPlane, type ContextPlane } from '../src/standalone/context.ts'
import type { AnchorAdapter, AnchorLocatorOptions, SourceAnchor } from '../src/tools/anchor.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { record } from './helpers/record.ts'

// 上下文平面：真实临时目录做记忆根与项目目录。断言设置热更新、快照接线、写入管线与项目解析。

const quiet: MemoryLogger = { info() {}, warn() {}, error() {} }

let root: string
let project: string
let plane: ContextPlane
/** 来源锚用例另建的临时记忆根（主 plane 的根在 beforeEach 里清）。 */
const anchorRoots: string[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-context-root-'))
  project = await mkdtemp(join(tmpdir(), 'pm-context-proj-'))
  plane = await createContextPlane({ memoryRoot: root, project, log: quiet })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
  for (const dir of anchorRoots.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 直接落一条记忆文件（同 standalone-plane 的种子写法）；workspace 目录补 .workspace 标记，缺它整个目录不被读取。 */
async function seed(scope: 'global' | 'workspace', partial: Parameters<typeof record>[0] = {}): Promise<string> {
  const memory = record({ ...partial, scope, ...(scope === 'workspace' ? { workspacePath: project } : {}) })
  const dir = scope === 'global' ? join(root, GLOBAL_DIR) : join(root, workspaceDirName(project))
  await mkdir(dir, { recursive: true })
  if (scope === 'workspace') await writeFile(join(dir, WORKSPACE_MARKER), `${project}\n`)
  await writeFile(join(dir, `${memory.id}.md`), encodeRecord(memory, {}))
  return memory.id
}

describe('createContextPlane', () => {
  it('设置变了 refresh 回 true 且类型表换成新场景；没变回 false', async () => {
    expect(plane.registry.has('procedure')).toBe(false)
    await plane.settings.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    expect(await plane.refresh()).toBe(true)
    expect(plane.registry.has('procedure')).toBe(true)
    expect(await plane.refresh()).toBe(false)
  })

  it('snapshot 与直接调 assembleSnapshot 的 DSH 组装同文（接线拉的是出厂值与转发类型表）', async () => {
    await seed('global', { id: 'mem_g1', name: '全局偏好', content: '所有项目用 pnpm', summary: 'pnpm', type: 'preference' })
    await seed('workspace', { id: 'mem_w1', name: '项目规则', content: '这个仓库的提交不加类型前缀', summary: '提交规范', type: 'knowledge' })
    const pre = await prereadSnapshot(plane.store, await realpath(project))
    const expected = assembleSnapshot({
      records: pre.records,
      files: pre.files,
      quarantinedCount: pre.quarantinedCount,
      registry: buildTypeRegistry({ template: DEFAULT_MEMORY_SETTINGS.template, customTypes: {}, scenes: DEFAULT_MEMORY_SETTINGS.scenes, removedPresetTypes: [] }),
      workspacePath: await realpath(project),
      budget: DEFAULT_MEMORY_SETTINGS.snapshotTokenBudget,
      overflow: DEFAULT_MEMORY_SETTINGS.snapshotOverflow,
      evidenceLookup: DEFAULT_MEMORY_SETTINGS.evidenceLookup,
      memoryRoot: root,
      now: Date.now(),
    })
    const snap = await plane.snapshot(await plane.resolveProject())
    expect(snap.text).toBe(expected.text)
    expect(snap.usedTokens).toBe(expected.usedTokens)
    expect(snap.injectedIds).toEqual(['mem_g1', 'mem_w1'])
    expect(snap.text).toContain('所有项目用 pnpm')
  })

  it('save 走管线：新建成功、重复主题被去重拦下、疑似密钥被拒', async () => {
    const workspacePath = await plane.resolveProject()
    const base = { type: 'preference', scope: 'workspace' as const, sourceMode: 'user-explicit' as const }
    const first = await plane.save({ action: 'create', ...base, name: '认证位置', content: '认证逻辑在 `src/auth.ts`', summary: 'auth 位置' }, workspacePath, { id: 'sess-1' })
    expect(first.kind).toBe('saved')
    if (first.kind !== 'saved') throw new Error('应保存成功')
    // 上游去重门只拦近乎逐字重复：相近主题照常保存
    const dup = await plane.save({ action: 'create', ...base, name: '认证位置改', content: '`src/auth.ts` 负责认证', summary: 'auth 位置改' }, workspacePath, { id: 'sess-1' })
    expect(dup.kind).toBe('saved')
    // 近乎逐字：才被拦
    const verbatim = await plane.save({ action: 'create', ...base, name: '认证位置', content: '认证逻辑在 `src/auth.ts`', summary: 'auth 位置' }, workspacePath, { id: 'sess-1' })
    expect(verbatim.kind).toBe('duplicate-suspected')
    if (verbatim.kind === 'duplicate-suspected') expect(verbatim.existing?.id).toBe(first.record.id)
    const secret = await plane.save({ action: 'create', ...base, name: '密钥', content: `服务的密钥是 ${FAKE_SECRET.sk}`, summary: '密钥' }, workspacePath, { id: 'sess-1' })
    expect(secret).toMatchObject({ kind: 'rejected', code: 'secret-critical' })
  })

  it('save 落在解析出的项目目录，快照随之带出', async () => {
    const workspacePath = await plane.resolveProject()
    const saved = await plane.save({ action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '构建命令', content: '这个仓库用 pnpm 构建', summary: '构建' }, workspacePath, { id: 'sess-1' })
    if (saved.kind !== 'saved') throw new Error('应保存成功')
    const snap = await plane.snapshot(workspacePath)
    expect(snap.injectedIds).toContain(saved.record.id)
    // knowledge 是 search 召回：快照索引行带名称与摘要，不带全文
    expect(snap.text).toContain('构建命令')
  })

  it('resolveProject 三种取值：缺省用装配的项目、给定绝对路径 realpath、不存在与 global 回 undefined', async () => {
    expect(await plane.resolveProject()).toBe(await realpath(project))
    expect(await plane.resolveProject(undefined)).toBe(await realpath(project))
    expect(await plane.resolveProject(project)).toBe(await realpath(project))
    expect(await plane.resolveProject(join(project, 'no-such-dir'))).toBeUndefined()
    expect(await plane.resolveProject('global')).toBeUndefined()
    expect(await plane.resolveProject('relative/path')).toBeUndefined()
  })

  it('search 走同一条读路径：刚保存的记录按关键词命中', async () => {
    const workspacePath = await plane.resolveProject()
    await plane.save({ action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '部署流程', content: '部署用 pnpm build 后 rsync', summary: '部署', tags: ['deploy'] }, workspacePath, { id: 'sess-1' })
    const hits = await plane.search({ query: '部署 rsync', project: workspacePath })
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.hits[0]!.summary).toBe('部署')
  })
})

describe('来源锚定位（写入侧）', () => {
  /** 假适配器：定位结果由用例的闭包决定（可变、可抛错）。 */
  function fakeAdapter(get: () => SourceAnchor | undefined | Promise<SourceAnchor | undefined>): AnchorAdapter {
    return {
      scheme: 'zcode',
      locateCall: async () => await get(),
      readWindow: async () => { throw new Error('本用例不读窗') },
    }
  }

  /** 带锚的平面：另建一个临时记忆根（afterEach 统一清）。 */
  async function anchoredPlane(get: () => SourceAnchor | undefined, anchorsOverride: Partial<AnchorLocatorOptions> = {}): Promise<ContextPlane> {
    const memoryRoot = await mkdtemp(join(tmpdir(), 'pm-context-anchor-'))
    anchorRoots.push(memoryRoot)
    return await createContextPlane({
      memoryRoot, project, log: quiet,
      anchors: { adapters: [fakeAdapter(get)], retryDelaysMs: [1, 1], ...anchorsOverride },
    })
  }

  const anchorIn = (sessionId: string, eventRange: [number, number]): SourceAnchor => ({ sessionId, eventRange })

  it('locateAnchor 转发到定位器；未配置锚的平面恒回 undefined', async () => {
    let calls = 0
    const anchored = await anchoredPlane(() => { calls++; return anchorIn('zcode:sess_aaa', [7, 9]) })
    expect(await anchored.locateAnchor({ title: 't', text: 'x' })).toEqual(anchorIn('zcode:sess_aaa', [7, 9]))
    expect(calls).toBe(1)
    expect(await plane.locateAnchor({ title: 't', text: 'x' })).toBeUndefined()
  })

  it('enabled: false（PLASTIC_ANCHOR=off 同义）不碰适配器', async () => {
    let calls = 0
    const disabled = await anchoredPlane(() => { calls++; return anchorIn('zcode:sess_aaa', [7, 9]) }, { enabled: false })
    expect(await disabled.locateAnchor({ title: 't', text: 'x' })).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('定位抛错被吞掉：locateAnchor 回 undefined，写入不受影响', async () => {
    const failing = await anchoredPlane(() => { throw new Error('库结构认不得') })
    expect(await failing.locateAnchor({ title: 't', text: 'x' })).toBeUndefined()
  })

  it('save 接受定位结果：真会话 id 与区间进 record.source', async () => {
    const anchored = await anchoredPlane(() => anchorIn('zcode:sess_aaa', [7, 9]))
    const workspacePath = await anchored.resolveProject()
    const out = await anchored.save(
      { action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '锚定写入', content: '带真锚的一条', summary: '锚定' },
      workspacePath, { id: 'zcode:sess_aaa', turnStartSeq: 7, lastSeq: 9 },
    )
    if (out.kind !== 'saved') throw new Error('应保存成功')
    expect(out.record.source).toEqual({ sessionId: 'zcode:sess_aaa', eventRange: [7, 9], sourceMode: 'user-explicit' })
  })

  it('没定位到（通道标识、区间缺省）：source 按 [0, 0] 占位，写入照常成功', async () => {
    const workspacePath = await plane.resolveProject()
    const out = await plane.save(
      { action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '无锚写入', content: '通道标识的一条', summary: '无锚' },
      workspacePath, { id: 'mcp:zcode' },
    )
    if (out.kind !== 'saved') throw new Error('应保存成功')
    expect(out.record.source).toEqual({ sessionId: 'mcp:zcode', eventRange: [0, 0], sourceMode: 'user-explicit' })
  })

  it('更新同样重新锚定：定位换了，source 跟着换', async () => {
    let current: SourceAnchor | undefined = anchorIn('zcode:sess_aaa', [7, 9])
    const anchored = await anchoredPlane(() => current)
    const workspacePath = await anchored.resolveProject()
    const created = await anchored.save(
      { action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '锚定写入', content: '带真锚的一条', summary: '锚定' },
      workspacePath, { id: 'zcode:sess_aaa', turnStartSeq: 7, lastSeq: 9 },
    )
    if (created.kind !== 'saved') throw new Error('应保存成功')
    current = anchorIn('zcode:sess_bbb', [11, 12])
    const updated = await anchored.save(
      { action: 'update', id: created.record.id, type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '锚定写入', content: '改过的正文', summary: '锚定', change: 'refine' },
      workspacePath, { id: 'zcode:sess_bbb', turnStartSeq: 11, lastSeq: 12 },
    )
    if (updated.kind !== 'updated') throw new Error(`应更新成功：${JSON.stringify(updated)}`)
    expect(updated.record.source).toEqual({ sessionId: 'zcode:sess_bbb', eventRange: [11, 12], sourceMode: 'user-explicit' })
  })
})
