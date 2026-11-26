import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeRecord } from '@plastic/core/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '@plastic/core/storage/paths.ts'
import type { MemoryLogger } from '@plastic/core/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { assembleSnapshot } from '../src/snapshot.ts'
import { prereadSnapshot } from '../src/runtime.ts'
import { DEFAULT_MEMORY_SETTINGS } from '../src/governance/memory-settings.ts'
import { createContextPlane, type ContextPlane } from '../src/standalone/context.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { record } from './helpers/record.ts'

// 上下文平面：真实临时目录做记忆根与项目目录。断言设置热更新、快照接线、写入管线与项目解析。

const quiet: MemoryLogger = { info() {}, warn() {}, error() {} }

let root: string
let project: string
let plane: ContextPlane

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-context-root-'))
  project = await mkdtemp(join(tmpdir(), 'pm-context-proj-'))
  plane = await createContextPlane({ memoryRoot: root, project, log: quiet })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
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
    const first = await plane.save({ action: 'create', ...base, name: '认证位置', content: '认证逻辑在 `src/auth.ts`', summary: 'auth 位置' }, workspacePath, 'sess-1')
    expect(first.kind).toBe('saved')
    const dup = await plane.save({ action: 'create', ...base, name: '认证位置改', content: '`src/auth.ts` 负责认证', summary: 'auth 位置改' }, workspacePath, 'sess-1')
    expect(dup.kind).toBe('duplicate-suspected')
    const secret = await plane.save({ action: 'create', ...base, name: '密钥', content: `服务的密钥是 ${FAKE_SECRET.sk}`, summary: '密钥' }, workspacePath, 'sess-1')
    expect(secret).toMatchObject({ kind: 'rejected', code: 'secret-critical' })
  })

  it('save 落在解析出的项目目录，快照随之带出', async () => {
    const workspacePath = await plane.resolveProject()
    const saved = await plane.save({ action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '构建命令', content: '这个仓库用 pnpm 构建', summary: '构建' }, workspacePath, 'sess-1')
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
    await plane.save({ action: 'create', type: 'knowledge', scope: 'workspace', sourceMode: 'user-explicit', name: '部署流程', content: '部署用 pnpm build 后 rsync', summary: '部署', tags: ['deploy'] }, workspacePath, 'sess-1')
    const hits = await plane.search({ query: '部署 rsync', project: workspacePath })
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.hits[0]!.summary).toBe('部署')
  })
})
