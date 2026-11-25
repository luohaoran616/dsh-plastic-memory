import { isAbsolute, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CONFIDENCE_BY_SOURCE, memoryRecordSchema, type MemoryRecord, type SourceMode } from '@plastic/core/record-schema.ts'
import { DEFAULT_SEARCH_TOP_K, type MemoryCore, type SearchInput } from '@plastic/core/factory.ts'
import { byPosition, type MemoryLogger } from '@plastic/core/storage/table.ts'

/**
 * MCP 工具的实现层（D2 的五个工具）：只做「MCP 入参 → core 调用 → MCP 出参」的映射，
 * 写入全部走 `createMemoryCore` 组装出的 store（同一把跨进程写锁），不自己碰文件。
 * 这一层不依赖 MCP 框架，后续 REST 面直接复用同一组函数（Task 5）。
 */

export type MemoryOrigin = 'user-stated' | 'model-observed'

export interface MemorySaveInput {
  title: string
  text: string
  /** 项目路径；"global" 表示全局候选（落 workspace + needs-promote-review）。 */
  project?: string
  type?: string
  origin: MemoryOrigin
}

export interface MemorySaveResult {
  id: string
  path: string
}

export interface MemorySearchInput {
  query: string
  project?: string
  topK?: number
}

export interface MemorySearchHit {
  id: string
  title: string
  summary: string
  path: string
}

export interface MemorySearchResult {
  hits: MemorySearchHit[]
}

export interface MemoryReadInput {
  id: string
}

/** 完整记录：core 的 schema 字段原样保留（name/content 映射成 D2 的 title/text），另带文件绝对路径。 */
export type MemoryRecordView = Omit<MemoryRecord, 'name' | 'content'> & { title: string; text: string; path: string }

export interface MemoryForgetInput {
  id: string
}

export interface MemoryForgetResult {
  ok: boolean
}

export interface MemoryHealthResult {
  score: number
  issueCount: number
  topIssues: string[]
}

/** 五个工具的实现层接口：MCP 注册与 REST 面共用。 */
export interface MemoryTools {
  save(input: MemorySaveInput): Promise<MemorySaveResult>
  search(input: MemorySearchInput): Promise<MemorySearchResult>
  read(input: MemoryReadInput): Promise<MemoryRecordView>
  forget(input: MemoryForgetInput): Promise<MemoryForgetResult>
  health(): Promise<MemoryHealthResult>
}

export interface MemoryToolsOptions {
  /** 客户端标识（PLASTIC_CLIENT）：写进 source.sessionId = `mcp:<client>`。 */
  client: string
  /** 固定项目映射（PLASTIC_PROJECT），project 入参缺省时用它；缺省再退回进程 cwd。 */
  project?: string
  log: MemoryLogger
  /** 缺省 process.cwd：project 与 PLASTIC_PROJECT 都没给时推导 workspacePath。 */
  cwd?: () => string
  now?: () => number
}

/** type 入参缺省值：core 不带类型注册表，取内置的通用类型。 */
export const DEFAULT_TYPE = 'knowledge'
/** summary 派生上限：索引行与注入都读它，一行放得下的长度。 */
export const SUMMARY_MAX_CHARS = 120
/** memory_search 的 topK 上限：挡住一次拉全库的入参。 */
export const MAX_SEARCH_TOP_K = 100

/** origin（D2）→ core 的 sourceMode（R11）；置信度取该档上限，不自己拍数字。 */
export const ORIGIN_SOURCE_MODE = {
  'user-stated': 'user-explicit',
  'model-observed': 'environment-observed',
} as const satisfies Record<MemoryOrigin, SourceMode>

/** 只读简版体检的扣分表：口径写在 memory_health 的 description 里，客户端看得见。 */
export const HEALTH_PENALTY = {
  malformed: { per: 10, cap: 30 },
  expired: { per: 4, cap: 20 },
  orphan: { per: 3, cap: 15 },
} as const

/** 写 global 时落成 workspace 记录并带这个标记（R12）：不是正式全局记忆，等人确认后由 WebUI 提升。 */
export const PROMOTE_REVIEW_KEY = 'needs-promote-review' as const

/**
 * 正文首行（去掉空白）作摘要；首行为空时取全文开头，空白折成一个空格。超过上限截断并加省略号。
 * core 的 summary 是必填字符串，MCP 入参只有 text，所以在这里派生。
 */
export function deriveSummary(text: string): string {
  const [firstLine = ''] = text.split(/\r?\n/, 1)
  const line = firstLine.trim()
  const base = line.length > 0 ? line : text.trim().replace(/\s+/gu, ' ')
  const chars = [...base]
  return chars.length > SUMMARY_MAX_CHARS ? `${chars.slice(0, SUMMARY_MAX_CHARS).join('')}…` : base
}

/** 与插件写入管线同形的 id（pipeline.ts 的 `mem_` + 时间戳 base36 + 随机段）；core 没有 id 生成器。 */
function newMemoryId(now: number): string {
  return `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** project 入参归一：空串与纯空白当没给（D6 的固定映射缺省）。 */
function requestedProject(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : undefined
}

export function createMemoryTools(core: MemoryCore, options: MemoryToolsOptions): MemoryTools {
  const fixedProject = requestedProject(options.project)
  const clock = (): number => options.now?.() ?? Date.now()
  const cwd = (): string => options.cwd?.() ?? process.cwd()
  /** 项目路径按 MCP 进程 cwd 解析成绝对路径（core 的 workspacePath 是路径，D3/工厂语义）。 */
  const absolutize = (value: string): string => (isAbsolute(value) ? resolve(value) : resolve(cwd(), value))

  /** project 缺省时的工作目录：PLASTIC_PROJECT（"global" 不是路径，退回 cwd）→ cwd。 */
  const defaultWorkspace = (): string => {
    if (fixedProject === undefined || fixedProject === 'global') return resolve(cwd())
    return absolutize(fixedProject)
  }

  /**
   * 写入目标（R12）：project 入参 > PLASTIC_PROJECT > cwd。解析结果恰为 "global" 时不写全局，
   * 而是写进解析出的 workspace 作用域并打 needs-promote-review 标记——这是 MCP 端唯一的全局处理路径，
   * 没有入参组合能直接落进 global。
   */
  const writeTarget = (project: string | undefined): { workspacePath: string; needsPromoteReview: boolean } => {
    const requested = requestedProject(project) ?? fixedProject
    if (requested === 'global') return { workspacePath: defaultWorkspace(), needsPromoteReview: true }
    if (requested === undefined) return { workspacePath: defaultWorkspace(), needsPromoteReview: false }
    return { workspacePath: absolutize(requested), needsPromoteReview: false }
  }

  /** 检索范围：project 缺省用 PLASTIC_PROJECT/cwd 的可见集合（global + 该项目）；具体路径查 global + 该项目；"global" 只查全局。 */
  const searchScope = (project: string | undefined): Pick<SearchInput, 'project' | 'workspacePath'> => {
    const requested = requestedProject(project) ?? fixedProject
    if (requested === 'global') return { project: 'global' }
    return { workspacePath: requested === undefined ? resolve(cwd()) : absolutize(requested) }
  }

  const save = async (input: MemorySaveInput): Promise<MemorySaveResult> => {
    const title = input.title.trim()
    if (title.length === 0) throw new Error('title 不能为空')
    const sourceMode = ORIGIN_SOURCE_MODE[input.origin]
    if (sourceMode === undefined) throw new Error(`origin 只能取 user-stated 或 model-observed：${String(input.origin)}`)
    const target = writeTarget(input.project)
    const stamp = clock()
    // source 形状按 core 的契约（R11）：MCP 没有 DSH 会话，sessionId 就是写入通道标识，事件区间是占位。
    const record: MemoryRecord = memoryRecordSchema.parse({
      id: newMemoryId(stamp),
      name: title,
      type: requestedProject(input.type) ?? DEFAULT_TYPE,
      scope: 'workspace',
      workspacePath: target.workspacePath,
      tags: [],
      content: input.text,
      summary: deriveSummary(input.text),
      source: { sessionId: `mcp:${options.client}`, eventRange: [0, 0], sourceMode },
      createdAt: stamp,
      updatedAt: stamp,
      lastConfirmedAt: stamp,
      lastRecalledAt: null,
      recallCount: 0,
      status: 'active',
      confidence: CONFIDENCE_BY_SOURCE[sourceMode],
      ...(target.needsPromoteReview ? { [PROMOTE_REVIEW_KEY]: true } : {}),
    })
    await core.store.create(record)
    // create 不返回落盘路径（同名会追加 id 片段），写完按 id 定位一次拿准确文件路径
    const located = await core.store.locate(record.id, { workspacePath: target.workspacePath })
    if (located === undefined) throw new Error(`写入后定位不到记录：${record.id}`)
    return { id: record.id, path: located.filePath }
  }

  const search = async (input: MemorySearchInput): Promise<MemorySearchResult> => {
    const topK = Math.min(Math.max(input.topK ?? DEFAULT_SEARCH_TOP_K, 1), MAX_SEARCH_TOP_K)
    const { hits } = await core.search({ query: input.query, topK, ...searchScope(input.project) })
    return { hits: hits.map(hit => ({ id: hit.id, title: hit.title, summary: hit.summary, path: hit.path })) }
  }

  const read = async (input: MemoryReadInput): Promise<MemoryRecordView> => {
    // 按 id 定位（全局 + 当前项目的会话视角，找不到再扫其他项目；含 .archive/）：读全文用，不受检索截断影响
    const located = await core.store.locate(input.id, { workspacePath: defaultWorkspace() })
    if (located === undefined) throw new Error(`找不到记忆：${input.id}`)
    // 位置即作用域：.archive/ 里的文件 status 一律按 deleted 返回
    const { name, content, ...rest } = byPosition(located)
    return { ...rest, title: name, text: content, path: located.filePath }
  }

  const forget = async (input: MemoryForgetInput): Promise<MemoryForgetResult> => {
    const located = await core.store.locate(input.id, { workspacePath: defaultWorkspace() })
    if (located === undefined) return { ok: false }
    // 只走软删（进 .archive/，可恢复）；MCP 端不提供 store.hardDelete 的任何入口
    return { ok: await core.store.softDelete(byPosition(located)) }
  }

  /**
   * 只读简版体检（D2）：扫全库（global 与所有项目）统计三类机械问题，不写任何文件。
   * 口径与 memory_health 的 description 保持一致：malformed 每条例 10 分/上限 30，expired 4/20，orphan 3/15；
   * score = 100 − 扣分合计，夹在 0–100 的整数。
   */
  const health = async (): Promise<MemoryHealthResult> => {
    const stamp = clock()
    const read = await core.store.readRaw(undefined)
    const malformed = read.quarantined
    const active = read.records.filter(located => located.record.status === 'active')
    const expired = active.filter(located => located.record.validTo !== undefined && located.record.validTo <= stamp)
    const knownIds = new Set(read.records.map(located => located.record.id))
    const orphans = active.filter(located => (located.record.supersedes ?? []).some(id => !knownIds.has(id)))
    const penalty = (count: number, rule: { per: number; cap: number }): number => Math.min(count * rule.per, rule.cap)
    const score = Math.max(0, 100
      - penalty(malformed.length, HEALTH_PENALTY.malformed)
      - penalty(expired.length, HEALTH_PENALTY.expired)
      - penalty(orphans.length, HEALTH_PENALTY.orphan))
    const issues = [
      malformed.length > 0 && { penalty: penalty(malformed.length, HEALTH_PENALTY.malformed), text: `${malformed.length} 个文件解析失败进入隔离区：${malformed[0]!.path}` },
      expired.length > 0 && { penalty: penalty(expired.length, HEALTH_PENALTY.expired), text: `${expired.length} 条在用记忆已过期：${expired[0]!.record.id}` },
      orphans.length > 0 && { penalty: penalty(orphans.length, HEALTH_PENALTY.orphan), text: `${orphans.length} 条记忆的 supersedes 指向不存在的 id：${orphans[0]!.record.id}` },
    ].filter(issue => issue !== false)
    issues.sort((a, b) => b.penalty - a.penalty)
    return {
      score,
      issueCount: malformed.length + expired.length + orphans.length,
      topIssues: issues.map(issue => issue.text).slice(0, 5),
    }
  }

  return { save, search, read, forget, health }
}

/** 工具结果统一走一段 JSON 文本（D2 的输出形状都在 JSON 里，客户端按 text 解析）。 */
function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

/**
 * 把五个工具注册到 MCP server：名字与输入面按 D2 一字不差（多一个少一个都算违约），
 * project 的解析规则写在 description 里，客户端不用看代码就知道 "global" 的落法。
 */
export function registerMemoryTools(server: McpServer, tools: MemoryTools): void {
  server.registerTool('memory_save', {
    description: [
      '保存一条长期记忆：写入三端共享的记忆根（workspace 作用域，走同一把跨进程写锁）。',
      'title 是记录名（进文件名与索引），text 是正文；summary 由 text 首行自动派生（首行为空时取正文开头，最多 120 字符）。',
      'origin 必填：user-stated 表示用户明确说过，model-observed 表示模型从环境或工具结果观察到的。',
      'project 缺省时写入 PLASTIC_PROJECT（未配置时按 MCP 进程 cwd 推导）的项目；传具体路径写入该项目；',
      '传 "global" 不会直接写全局，而是写入当前项目并标记 needs-promote-review: true，等人在 WebUI 确认后才提升为全局记忆。',
    ].join(''),
    inputSchema: {
      title: z.string().describe('记录名，进记忆文件名与索引'),
      text: z.string().describe('正文'),
      project: z.string().optional().describe('项目路径（绝对路径，相对路径按 MCP 进程 cwd 解析）；缺省用 PLASTIC_PROJECT 或 cwd；"global" 表示全局候选'),
      type: z.string().optional().describe('记录类型，缺省 knowledge'),
      origin: z.enum(['user-stated', 'model-observed']).describe('来源：user-stated（用户明确说过）或 model-observed（模型观察到的）'),
    },
  }, async args => jsonResult(await tools.save(args)))

  server.registerTool('memory_search', {
    description: [
      '检索长期记忆，复用 core 的检索打分。',
      '缺省范围是全局 + 当前项目（PLASTIC_PROJECT，未配置时按 MCP 进程 cwd）；',
      'project 传具体路径时查全局 + 该项目，传 "global" 只查全局。topK 缺省 8，上限 100。',
    ].join(''),
    inputSchema: {
      query: z.string().describe('检索关键词；空串返回当前范围内全部记忆'),
      project: z.string().optional().describe('限定项目（绝对路径或 "global"）；缺省用 PLASTIC_PROJECT 或 cwd'),
      topK: z.number().int().min(1).max(MAX_SEARCH_TOP_K).optional().describe('返回条数，缺省 8，上限 100'),
    },
  }, async args => jsonResult(await tools.search(args)))

  server.registerTool('memory_read', {
    description: [
      '按 id 读取一条记忆的完整记录：frontmatter 字段（title、type、scope、tags、status、source、时间戳等）与正文 text，',
      '另带文件绝对路径 path。已软删的记忆照常返回，status 为 deleted，path 指向 .archive/。',
    ].join(''),
    inputSchema: {
      id: z.string().describe('记忆 id（mem_ 开头，来自 memory_save / memory_search）'),
    },
  }, async args => jsonResult(await tools.read(args)))

  server.registerTool('memory_forget', {
    description: [
      '软删一条记忆：文件移入记忆根的 .archive/，可通过 WebUI 恢复。MCP 不提供物理删除。',
      'id 不存在时返回 { ok: false }。',
    ].join(''),
    inputSchema: {
      id: z.string().describe('要软删的记忆 id'),
    },
  }, async args => jsonResult(await tools.forget(args)))

  server.registerTool('memory_health', {
    description: [
      '只读简版体检，不写任何文件。口径：扫全库（global 与所有项目）——',
      'malformed：frontmatter 解析失败进入隔离区的文件，每个扣 10 分、最多扣 30；',
      'expired：active 但 validTo 已过期的记忆，每个扣 4 分、最多扣 20；',
      'orphan：supersedes 指向不存在 id 的在用记忆，每个扣 3 分、最多扣 15。',
      'score = 100 减去扣分合计，夹在 0–100 的整数；issueCount 是三类问题条数之和；',
      'topIssues 是按类聚合的问题摘要（扣分多的在前，最多 5 条）。完整体检与拍板在 WebUI。',
    ].join(''),
    inputSchema: {},
  }, async () => jsonResult(await tools.health()))
}
