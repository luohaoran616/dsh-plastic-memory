import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { encodeRecord, splitFrontmatter } from '@plastic/core/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '@plastic/core/storage/paths.ts'
import type { MemoryRecord } from '@plastic/core/record-schema.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { createMemoryTools, type MemorySaveResult } from './tools.ts'

// 工具面映射的直查用例：真上下文平面（根包编译产物）+ 真临时记忆根，不经子进程。
// 断言入参映射（更新沿用目标）、去重与密钥的返回形状、全局目标的拒绝、project:"global" 的降级、
// memory_recall 与快照同文，以及设置变了的重注册。

type ContextPlane = import('dsh-plastic-memory/lib/standalone/context.js').ContextPlane

const quiet: MemoryLogger = { info() {}, warn() {}, error() {} }
const CONTEXT_MODULE = 'dsh-plastic-memory/lib/standalone/context.js'

let root: string
let project: string
let plane: ContextPlane
let toolset: ReturnType<typeof createMemoryTools>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-mcp-map-'))
  project = await mkdtemp(join(tmpdir(), 'pm-mcp-map-proj-'))
  const { createContextPlane } = await import(CONTEXT_MODULE)
  plane = await createContextPlane({ memoryRoot: root, client: 'spec', project })
  toolset = createMemoryTools(plane)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const saved = async (input: Parameters<typeof toolset.tools.save>[0]): Promise<Extract<MemorySaveResult, { ok: true }>> => {
  const result = await toolset.tools.save(input)
  if (!result.ok) throw new Error(`应保存成功：${JSON.stringify(result)}`)
  return result
}

/** 直接种一条全局记忆文件。 */
async function seedGlobal(partial: Partial<MemoryRecord> = {}): Promise<MemoryRecord> {
  const memory: MemoryRecord = {
    id: 'mem_global_target', name: '全局条目', type: 'knowledge', scope: 'global', tags: [],
    content: '全局正文', summary: '全局摘要',
    source: { sessionId: 'seed', eventRange: [0, 0], sourceMode: 'user-explicit' },
    createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null, recallCount: 0,
    status: 'active', confidence: 0.9, ...partial,
  }
  await mkdir(join(root, GLOBAL_DIR), { recursive: true })
  await writeFile(join(root, GLOBAL_DIR, `${memory.id}.md`), encodeRecord(memory, {}))
  return memory
}

describe('memory_save 的入参映射', () => {
  it('更新沿用目标字段：title/text 全量给，summary/tags/type 缺省沿用目标', async () => {
    const created = await saved({ title: '原题', text: '原始正文第一行\n细节', origin: 'user-stated', type: 'knowledge', tags: ['旧标签'], summary: '原始摘要' })
    const updated = await toolset.tools.save({ title: '新题', text: '新正文第一行', origin: 'user-stated', id: created.id, change: 'refine' })
    // 改了名称，落盘文件跟着改名：path 是新文件
    expect(updated).toMatchObject({ ok: true, kind: 'updated', id: created.id })
    expect(updated.ok && updated.path).not.toBe(created.path)
    const view = await toolset.tools.read({ id: created.id })
    expect(view).toMatchObject({ title: '新题', text: '新正文第一行', summary: '原始摘要', tags: ['旧标签'], type: 'knowledge' })
  })

  it('五档 origin 原样通行；confidence 只能下调到来源档位上限', async () => {
    const confirmed = await saved({ title: '经确认的动作', text: '用户确认有效的一次操作', origin: 'agent-action-confirmed', type: 'knowledge' })
    const view = await toolset.tools.read({ id: confirmed.id })
    expect(view.source).toMatchObject({ sessionId: 'mcp:spec', sourceMode: 'agent-action-confirmed' })
    // model-observed 的上限是 0.8：给 1 也被钳到 0.8
    const clamped = await saved({ title: '置信上限', text: '观察到的环境事实，另一台机器', origin: 'model-observed', type: 'knowledge', confidence: 1 })
    expect((await toolset.tools.read({ id: clamped.id })).confidence).toBe(0.8)
  })

  it('新建缺 type 或类型不在当前场景：rejected 并列出可选类型', async () => {
    const noType = await toolset.tools.save({ title: '没有类型', text: '正文', origin: 'user-stated' })
    expect(noType).toMatchObject({ ok: false, kind: 'rejected' })
    if (noType.ok === false && noType.kind === 'rejected') expect(noType.reason).toContain('type')
    const badType = await toolset.tools.save({ title: '场景外的类型', text: '正文', origin: 'user-stated', type: 'procedure' })
    expect(badType).toMatchObject({ ok: false, kind: 'rejected' })
  })
})

describe('memory_save 走写入管线', () => {
  it('重复主题回 duplicate-suspected 并列出已有记忆；force 放行', async () => {
    const first = await saved({ title: '部署流程', text: '部署用 pnpm build 之后 rsync 到网关机器', origin: 'user-stated', type: 'knowledge' })
    const dup = await toolset.tools.save({ title: '部署流程另一份', text: '部署用 pnpm build 之后 rsync 到网关机器上', origin: 'user-stated', type: 'knowledge' })
    expect(dup).toMatchObject({ ok: false, kind: 'duplicate-suspected' })
    if (dup.ok === false && dup.kind === 'duplicate-suspected') {
      // 上游去重改为单条相近记忆：直接对 id 断言
      expect(dup.existing?.id).toBe(first.id)
    }
    const forced = await saved({ title: '部署流程另一份', text: '部署用 pnpm build 之后 rsync 到网关机器上', origin: 'user-stated', type: 'knowledge', force: true })
    expect(forced.kind).toBe('saved')
  })

  it('厂商形状的密钥被拒（force 也不放行），不落盘', async () => {
    const secret = ['sk-', 'TESTONLY'.padEnd(24, 'a')].join('')
    const rejected = await toolset.tools.save({ title: '带密钥', text: `服务的密钥是 ${secret}`, origin: 'user-stated', type: 'knowledge', force: true })
    expect(rejected).toMatchObject({ ok: false, kind: 'rejected' })
    if (rejected.ok === false && rejected.kind === 'rejected') expect(rejected.reason).toContain('密钥')
  })

  it('更新目标是全局记忆直接拒：MCP 没有确认更新的通道', async () => {
    await seedGlobal()
    const rejected = await toolset.tools.save({ title: '改全局', text: '新的全局正文', origin: 'user-stated', type: 'knowledge', id: 'mem_global_target' })
    expect(rejected).toMatchObject({ ok: false, kind: 'rejected' })
    if (rejected.ok === false && rejected.kind === 'rejected') expect(rejected.reason).toContain('全局')
  })

  it('project: "global" 由管线降级：落当前项目、带 globalCandidate，结果标 promotion: candidate', async () => {
    const savedGlobal = await saved({ title: '全局候选约定', text: '所有项目都适用的一条约定', origin: 'user-stated', type: 'preference', project: 'global' })
    expect(savedGlobal.promotion).toBe('candidate')
    const dir = join(root, workspaceDirName(project))
    expect(savedGlobal.path.startsWith(`${dir}/`)).toBe(true)
    const frontmatter = splitFrontmatter(await readFile(savedGlobal.path, 'utf8')).data
    // workspace 作用域由目录与 .workspace 标记表达，frontmatter 里不写 scope；全局候选标记在
    expect(frontmatter).toMatchObject({ globalCandidate: true })
    expect(frontmatter.scope).toBeUndefined()
  })

  it('project 给到不存在的路径：写进该路径解析出的目录（与既有落盘语义一致）', async () => {
    const fresh = join(project, 'new-sub', 'deeper')
    const result = await saved({ title: '新项目首条', text: '目录还不存在也能落盘', origin: 'user-stated', type: 'knowledge', project: fresh })
    expect(result.path.startsWith(`${join(root, workspaceDirName(fresh))}/`)).toBe(true)
  })
})

describe('memory_recall 与 memory_search', () => {
  it('memory_recall 与快照接口对同一项目回同一段文本', async () => {
    await saved({ title: '项目规则', text: '这个仓库用 pnpm 跑构建', origin: 'user-stated', type: 'knowledge', project })
    const resolved = await plane.resolveProject(project) ?? project
    const recalled = await toolset.tools.recall({ project })
    expect(recalled.text).toBe((await plane.snapshot(resolved)).text)
    expect(recalled.text).toContain('这个仓库用 pnpm 跑构建')
    expect(recalled.injectedCount).toBeGreaterThanOrEqual(1)
    // 缺省与 global 的口径
    expect((await toolset.tools.recall()).text).toBe((await plane.snapshot(resolved)).text)
    expect((await toolset.tools.recall({ project: 'global' })).text).toBe((await plane.snapshot(undefined)).text)
  })

  it('memory_recall 对不存在的项目路径抛错，缺省目录按 PLASTIC_PROJECT 原文', async () => {
    await expect(toolset.tools.recall({ project: join(project, 'no-such') })).rejects.toThrow(/不存在/)
    await expect(toolset.tools.recall({ project: 'relative/path' })).rejects.toThrow(/绝对路径/)
    // 缺省：PLASTIC_PROJECT 是装配时的 project
    const recalled = await toolset.tools.recall()
    expect(recalled.text).toBe((await plane.snapshot(await realpath(project))).text)
  })

  it('memory_search 的 project 限定与 global 只查全局', async () => {
    const inProject = await saved({ title: '项目内条目', text: '只属于这个项目的记忆内容', origin: 'user-stated', type: 'knowledge', project })
    await saved({ title: '另一项目条目', text: '别的项目里的记忆内容另一段', origin: 'user-stated', type: 'knowledge', project: join(project, 'other') })
    const scoped = await toolset.tools.search({ query: '记忆内容', project })
    expect(scoped.hits.map(hit => hit.id)).toEqual([inProject.id])
    expect((await toolset.tools.search({ query: '记忆内容', project: 'global' })).hits).toHaveLength(0)
  })
})

describe('设置热更新与重注册', () => {
  it('设置变了 register 回 true 并按新类型表渲染描述与枚举；没变回 false', async () => {
    const registered: Array<{ name: string; description: string; inputSchema: Record<string, { _def?: { values?: string[] }; options?: string[] } | undefined> }> = []
    const fakeServer = {
      registerTool: (name: string, def: { description: string; inputSchema: Record<string, unknown> }) => {
        registered.push({ name, description: def.description, inputSchema: def.inputSchema as Record<string, never> })
      },
    } as unknown as McpServer

    expect(await toolset.register(fakeServer)).toBe(false)
    const before = registered.find(t => t.name === 'memory_save')!
    expect(before.description).not.toContain('可复用流程')
    expect(before.description).toContain('各类型记什么、什么时候记')

    await plane.settings.mutate([{ op: 'set', path: ['template'], value: 'coding' }])
    expect(await toolset.register(fakeServer)).toBe(true)
    const after = registered.filter(t => t.name === 'memory_save').at(-1)!
    // 编码场景带预设类型「可复用流程」；type 枚举随之换
    expect(after.description).toContain('可复用流程')
    // type 是 z.enum(...).optional()：先解包再读枚举值
    const typeEnum = after.inputSchema.type!
    const inner = (typeEnum as { unwrap?: () => { options?: string[] } }).unwrap?.() ?? typeEnum
    expect((inner.options ?? []).map(v => String(v))).toContain('procedure')

    expect(await toolset.register(fakeServer)).toBe(false)
  })
})

describe('memory_save 的来源锚', () => {
  it('没配置锚时结果带通道标识 source（mcp:<client>、[0, 0]），模型与人都看得到没锚上', async () => {
    const result = await saved({ title: '无锚写入', text: '无锚正文', origin: 'user-stated', type: 'knowledge' })
    expect(result.source).toEqual({ sessionId: 'mcp:spec', eventRange: [0, 0], sourceMode: 'user-explicit' })
  })

  it('定位命中：结果与落盘记录带真锚；更新重新锚定到新会话', async () => {
    const anchoredRoot = await mkdtemp(join(tmpdir(), 'pm-mcp-map-anchor-'))
    try {
      // 假适配器：第一发锚到 sess_aaa，之后锚到 sess_bbb（更新的重新锚定）
      let current: { sessionId: string, eventRange: [number, number] } | undefined = { sessionId: 'zcode:sess_aaa', eventRange: [7, 9] }
      const adapter = {
        scheme: 'zcode' as const,
        locateCall: async () => current,
        readWindow: async () => { throw new Error('本用例不读窗') },
      }
      const { createContextPlane: create } = await import(CONTEXT_MODULE)
      const anchoredPlane = await create({ memoryRoot: anchoredRoot, client: 'spec', project, anchors: { adapters: [adapter] } })
      const anchoredTools = createMemoryTools(anchoredPlane)
      const created = await anchoredTools.tools.save({ title: '带锚写入', text: '带锚正文', origin: 'user-stated', type: 'knowledge' })
      if (!created.ok) throw new Error('应保存成功')
      expect(created.source).toEqual({ sessionId: 'zcode:sess_aaa', eventRange: [7, 9], sourceMode: 'user-explicit' })
      expect((await anchoredTools.tools.read({ id: created.id })).source).toMatchObject({ sessionId: 'zcode:sess_aaa', eventRange: [7, 9] })

      current = { sessionId: 'zcode:sess_bbb', eventRange: [11, 12] }
      const updated = await anchoredTools.tools.save({ title: '带锚写入', text: '改过的正文', origin: 'user-stated', id: created.id, change: 'refine' })
      if (!updated.ok) throw new Error('应更新成功')
      expect(updated.source).toEqual({ sessionId: 'zcode:sess_bbb', eventRange: [11, 12], sourceMode: 'user-explicit' })
    } finally {
      await rm(anchoredRoot, { recursive: true, force: true })
    }
  })
})

describe('memory_source（独立端回查）', () => {
  /** 在记忆根里直接种一条带 source 的 workspace 记录（写到它自己所属 workspace 的目录）。 */
  async function seedWithSource(rootDir: string, memory: MemoryRecord): Promise<void> {
    const ws = memory.workspacePath!
    const dir = join(rootDir, workspaceDirName(ws))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WORKSPACE_MARKER), `${ws}\n`)
    await writeFile(join(dir, `${memory.id}.md`), encodeRecord(memory, {}))
  }

  const externalRecord = (id: string, workspacePath: string): MemoryRecord => ({
    id, name: '带外端锚', type: 'knowledge', scope: 'workspace', workspacePath, tags: [],
    content: '外端锚正文', summary: '外锚',
    source: { sessionId: 'zcode:sess_map', eventRange: [2, 5], sourceMode: 'user-explicit' },
    createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null, recallCount: 0,
    status: 'active', confidence: 0.9,
  })

  it('mcp: 通道标识回 unavailable（原因进 JSON，text 与 DSH 渲染同文）；不存在的 id not-found', async () => {
    const created = await saved({ title: '回查目标', text: '回查正文', origin: 'user-stated', type: 'knowledge' })
    const result = await toolset.tools.source({ memoryId: created.id })
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error(result.kind)
    expect(result.reason).toContain('没有定位到原始对话')
    expect(result.text).toContain('原始证据不可用')
    const ghost = await toolset.tools.source({ memoryId: 'mem_ghost' })
    expect(ghost.kind).toBe('not-found')
    expect(ghost.text).toContain('不存在或已删除')
  })

  it('外端锚经注入的适配器读到窗口：lines 与 range 原样透出，text 是 DSH 的渲染；别的项目的记录 forbidden', async () => {
    const anchoredRoot = await mkdtemp(join(tmpdir(), 'pm-mcp-map-source-'))
    try {
      const adapter = {
        scheme: 'zcode' as const,
        locateCall: async () => undefined,
        readWindow: async () => ({ events: [{ seq: 2, role: 'user', text: '第二轮：帮我记一条' }], skipped: 0, range: [2, 5] }),
      }
      const { createContextPlane: create } = await import(CONTEXT_MODULE)
      const anchoredPlane = await create({ memoryRoot: anchoredRoot, client: 'spec', project, anchors: { adapters: [adapter] } })
      await seedWithSource(anchoredRoot, externalRecord('mem_zsrc', project))
      // 别的项目的 workspace 记录种在它自己的目录里：定位得到但跨项目门拒绝（与 DSH 同一条规则）
      await seedWithSource(anchoredRoot, externalRecord('mem_zforeign', '/other/project'))
      const anchoredTools = createMemoryTools(anchoredPlane)
      const result = await anchoredTools.tools.source({ memoryId: 'mem_zsrc' })
      if (result.kind !== 'ok' || result.via !== 'anchor') throw new Error(`应回查成功：${JSON.stringify(result)}`)
      expect(result.lines).toEqual(['- [2] user: 第二轮：帮我记一条'])
      expect(result.sessionId).toBe('zcode:sess_map')
      expect(result.range).toEqual([2, 5])
      expect(result.text).toContain('会话 zcode:sess_map')
      expect(result.text).toContain('- [2] user: 第二轮：帮我记一条')
      expect(await anchoredTools.tools.source({ memoryId: 'mem_zforeign' })).toMatchObject({ kind: 'forbidden', memoryId: 'mem_zforeign' })
    } finally {
      await rm(anchoredRoot, { recursive: true, force: true })
    }
  })
})

describe('memory_save 的工具描述（经真上下文平面注册出去的那一份）', () => {
  it('用 MCP 的参数名：不带 DSH 工具面才有的 action / edits / content / scope / sourceMode', async () => {
    const registered: Array<{ name: string; description: string }> = []
    const fakeServer = {
      registerTool: (name: string, def: { description: string }) => { registered.push({ name, description: def.description }) },
    } as unknown as McpServer
    await toolset.register(fakeServer)
    const description = registered.find(t => t.name === 'memory_save')!.description
    expect(description).toContain('更新已有记忆传 id 和 text')
    expect(description).toContain('origin 填 agent-inferred')
    // 2026-11-26 回归：转发对象曾把 surface 丢掉，MCP 面渲染出 DSH 的参数名，模型据此以为更新不可用
    for (const dshOnly of ['action=update', '传 edits', '传 content', 'scope 默认填 workspace', 'sourceMode 填']) {
      expect(description, dshOnly).not.toContain(dshOnly)
    }
  })
})
