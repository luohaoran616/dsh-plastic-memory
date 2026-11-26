import { isAbsolute, resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { MemoryRecord, SourceMode } from '@plastic/core/record-schema.ts'
import type { MemoryStore } from '@plastic/core/store.ts'
import { DEFAULT_SEARCH_TOP_K, type SearchInput, type SearchResult } from '@plastic/core/factory.ts'
import { byPosition, type LocatedFile } from '@plastic/core/storage/table.ts'

/**
 * MCP 工具的实现层：只做「MCP 入参 → 上下文平面调用 → MCP 出参」的映射。
 * 写入走上下文平面的 save（与 DSH 同一条写入管线：结构去重、疑似密钥拦截、更新、取代、有效期、快照先行），
 * 读走同一张文件表与同一份设置驱动的类型表。这一层只认结构子集（mcp 包不 import 插件源码，
 * GuiPlanePort 的同款约定）：类型表、写入入参与结果都按形状声明，由 tsc 证明上下文平面满足它们。
 */

/** 类型表的结构子集：has 校验入参、all 出枚举、renderSaveDescription 出规则段。 */
export interface ToolTypeRegistry {
  has(name: string): boolean
  all(): ReadonlyArray<{ name: string }>
  /** 写侧规则（通用层 + 各类型记什么、什么时候记）。 */
  renderSaveDescription(surface?: 'dsh' | 'mcp'): string
}

/** MCP 工具面只认这个结构：上下文平面的子集 + 客户端标识。stdio 与 serve 都建一个真平面传进来，测试传假的。 */
export interface MemoryContextPort {
  /** 客户端标识（PLASTIC_CLIENT）：写进 source.sessionId = `mcp:<client>`。 */
  readonly client: string
  /** 固定项目映射（PLASTIC_PROJECT），project 入参缺省时用它；缺省再退回进程 cwd。 */
  readonly project: string | undefined
  readonly store: MemoryStore
  readonly registry: ToolTypeRegistry
  /** 现读设置文档；场景与类型配置变了就重建类型表、回 true。每次工具调用前比对一次。 */
  refresh(): Promise<boolean>
  /** project 参数 → 项目路径：'global' 或不存在的路径回 undefined；缺省用装配的项目；非绝对路径回 undefined。 */
  resolveProject(project?: string): Promise<string | undefined>
  search(input: SearchInput): Promise<SearchResult>
  /** 快照原文与用量（纯读）。workspacePath 缺省只带全局。 */
  snapshot(workspacePath: string | undefined): Promise<{ text: string } & SnapshotUsageShape>
  /** 回查记忆的来源锚（memory_source 的实现层）：返回结构化结果 + 与 DSH 渲染逐字相同的 text。 */
  source(input: { memoryId: string; window?: number }, workspacePath: string | undefined): Promise<MemorySourceResult & { text: string }>
  /**
   * 来源锚定位（写入侧，设计说明 §A2）：拿这次调用收到的 title/text 到客户端自己的会话存储里找
   * 「刚刚发出这一次调用」的会话。缺省没有（不定位，维持 mcp:<client>）；上下文平面按选项装配。
   */
  locateAnchor?(args: { title: string; text: string }): Promise<AnchorLocation | undefined>
  /** 写入走与 DSH 同一条管线（入参与结果按形状声明，管线原样满足它）。session 是锚定位的结果或通道标识。 */
  save(input: ToolSaveInput, workspacePath: string | undefined, session: ToolSession): Promise<ToolSaveOutcome>
}

/** 写入的来源锚：定位命中 = 真会话 id + 该端自己的序号区间；没定位到 = `{ id: 'mcp:<client>' }`（管线按 [0, 0] 占位）。 */
export interface ToolSession {
  id: string
  turnStartSeq?: number
  lastSeq?: number
}

/** 写入入参的结构子集（插件管线的 SaveInput 原样满足它，多出的 edits 不影响赋值方向）。 */
export interface ToolSaveInput {
  action: 'create' | 'update'
  id?: string
  name?: string
  type?: string
  scope?: 'global' | 'workspace'
  content?: string
  summary?: string
  tags?: string[]
  sourceMode: SourceMode
  confidence?: number
  supersedes?: string[]
  validFrom?: string
  validTo?: string
  force?: boolean
  confirmGlobal?: string
}

/** 锚定位的结果（写入侧）：真会话 id + 该端自己的序号区间；sourceMode 要等落盘时管线才填。 */
export interface AnchorLocation {
  sessionId: string
  eventRange: [number, number]
}

/** 落盘记录的来源锚（管线填的机械事实）：谁在哪个客户端的哪个会话、哪一轮写的。 */
export interface MemorySourceAnchor {
  sessionId: string
  eventRange: [number, number]
  sourceMode: SourceMode
}

/** 写入结果的结构子集（插件管线的 PipelineResult 原样满足它）。 */
export interface ToolSaveOutcome {
  kind: 'saved' | 'updated' | 'duplicate-suspected' | 'rejected'
  record?: { id: string; globalCandidate?: boolean; source?: MemorySourceAnchor }
  warnings?: ReadonlyArray<{ code: string; text: string }>
  existing?: ReadonlyArray<{ id: string; summary: string }>
  reason?: string
}

/** 快照用量（插件 assembleSnapshot 的返回去掉 text 后的形状）。 */
export interface SnapshotUsageShape {
  tokens: { workspace: number; global: number; fixed: number }
  usedTokens: number
  injectedIds: string[]
  titleOnlyIds: string[]
  omittedCount: number
}

export type MemoryOrigin =
  | 'user-stated' | 'model-observed' // 旧值：新五档的前两档别名
  | 'user-explicit' | 'user-behavior' | 'environment-observed' | 'agent-inferred' | 'agent-action-confirmed'

export interface MemorySaveInput {
  title: string
  text: string
  /** 项目路径；"global" 不是直接写全局，而是管线降级成 workspace + 全局提升候选。 */
  project?: string
  /** 新建必填：当前场景的类型枚举之一；更新缺省沿用目标记忆的类型。 */
  type?: string
  origin: MemoryOrigin
  /** 更新目标：给了它就是更新（title/text 给全量，summary/tags/type 没给的沿用目标）。 */
  id?: string
  /** 缺省：新建按 text 派生（首行，最多 120 字符），更新沿用目标。 */
  summary?: string
  /** 更新没给时沿用目标。 */
  tags?: string[]
  /** 0–1，只能下调到来源档位的置信上限（管线钳）。 */
  confidence?: number
  /** 被这条新记忆取代的旧记忆 id（新建时用；旧记忆随即失效、不再带入）。 */
  supersedes?: string[]
  /** 生效起始，本机时间 YYYY-MM-DD HH:mm 或 YYYY-MM-DD。 */
  validFrom?: string
  /** 失效截止，本机时间；到点后不再带入、搜不到。 */
  validTo?: string
  /** 跳过结构去重与疑似密钥拦截（用户已确认）。 */
  force?: boolean
}

/** 写入结果：ok=false 时没有 id/path，改走 duplicate-suspected / rejected 的形状（与管线同码）。 */
export type MemorySaveResult =
  | { ok: true; kind: 'saved' | 'updated'; id: string; path: string; source?: MemorySourceAnchor; warnings?: string[]; promotion?: 'candidate' }
  | { ok: false; kind: 'duplicate-suspected'; existing: ReadonlyArray<{ id: string; summary: string }> }
  | { ok: false; kind: 'rejected'; reason: string }

export interface MemoryRecallInput {
  /** 缺省全局 + 当前项目（PLASTIC_PROJECT，未配置时按进程 cwd）；"global" 只带全局；具体路径带全局 + 该项目。 */
  project?: string
}

/** memory_recall 的输出：与 hook 注入的是同一段文本。 */
export interface MemoryRecallResult {
  text: string
  usedTokens: number
  injectedCount: number
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

/** 完整记录：core 的 schema 字段原样保留（name/content 映射成 title/text），另带文件绝对路径。 */
export type MemoryRecordView = Omit<MemoryRecord, 'name' | 'content'> & { title: string; text: string; path: string }

/** 落盘记录 → 对外视图：memory_read 与其他读入口共用这一份字段映射。 */
export function recordView(located: LocatedFile): MemoryRecordView {
  const { name, content, ...rest } = byPosition(located)
  return { ...rest, title: name, text: content, path: located.filePath }
}

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

export interface MemorySourceInput {
  /** 要回查的记忆 id（快照/搜索结果里的 mem_ 开头 id）。 */
  memoryId: string
  /** 读取的事件条数，缺省覆盖记忆产生的当轮对话，上限 24。 */
  window?: number
}

/** memory_source 的结构化结果（插件 executeSource 的 SourceResult 原样满足它，code 放宽成 string）。 */
export type MemorySourceResult =
  | { kind: 'ok'; memoryId: string; name: string; sessionId: string; range: [number, number]; lines: string[]; skipped: number }
  | { kind: 'not-found'; memoryId: string }
  | { kind: 'no-source'; memoryId: string }
  | { kind: 'forbidden'; memoryId: string }
  | { kind: 'rejected'; memoryId: string; code: string; reason: string }
  | { kind: 'unavailable'; memoryId: string; reason: string }

/** 七个工具的实现层接口：stdio 的注册与 HTTP 模式的 `/mcp` 端点共用。 */
export interface MemoryTools {
  save(input: MemorySaveInput): Promise<MemorySaveResult>
  recall(input?: MemoryRecallInput): Promise<MemoryRecallResult>
  search(input: MemorySearchInput): Promise<MemorySearchResult>
  read(input: MemoryReadInput): Promise<MemoryRecordView>
  forget(input: MemoryForgetInput): Promise<MemoryForgetResult>
  health(): Promise<MemoryHealthResult>
  source(input: MemorySourceInput): Promise<MemorySourceResult & { text: string }>
}

export interface MemoryToolsOptions {
  /** 缺省 process.cwd：project 与 PLASTIC_PROJECT 都没给时推导 workspacePath；相对 project 入参按它解析。 */
  cwd?: () => string
  now?: () => number
}

/** summary 派生上限：索引行与注入都读它，一行放得下的长度。 */
export const SUMMARY_MAX_CHARS = 120
/** memory_search 的 topK 上限：挡住一次拉全库的入参。 */
export const MAX_SEARCH_TOP_K = 100

/** origin → core 的 sourceMode：旧值 user-stated / model-observed 是五档里前两档的别名，五档原名原样通行。 */
export const ORIGIN_SOURCE_MODE: Record<MemoryOrigin, SourceMode> = {
  'user-stated': 'user-explicit',
  'model-observed': 'environment-observed',
  'user-explicit': 'user-explicit',
  'user-behavior': 'user-behavior',
  'environment-observed': 'environment-observed',
  'agent-inferred': 'agent-inferred',
  'agent-action-confirmed': 'agent-action-confirmed',
}

/** 只读简版体检的扣分表：口径写在 memory_health 的 description 里，客户端看得见。 */
export const HEALTH_PENALTY = {
  malformed: { per: 10, cap: 30 },
  expired: { per: 4, cap: 20 },
  orphan: { per: 3, cap: 15 },
} as const

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

/** 与插件写入管线同形的 id（pipeline.ts 的 `mem_` + 时间戳 base36 + 随机段）；core 没有 id 生成器。
 *  ZCode 导入器也用它：导入记录与 MCP 写入是同一种 id 形态。 */
export function newMemoryId(now: number): string {
  return `mem_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** project 入参归一：空串与纯空白当没给（D6 的固定映射缺省）。 */
function requestedProject(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * memory_save 的 text 参数说明：与 DSH content 参数说明（type-registry 的 CONTENT_WRITING_GUIDE）是同一段正文写法，
 * 只把开头那句 DSH 工具面专属的（整条替换 / edits）换成「记忆正文。」。memory_source 两面都有，回查那句照留。
 * tests/mcp-save-description.spec.ts 守它和源头的这份关系。
 */
export const MCP_TEXT_GUIDE = [
  '记忆正文。按所选类型说明里的「正文」写法组织：结论在前，类型说明里的「原因：」「依据：」「背景：」接在句号后面，同一段写完、不换行（类型说明没写正文写法的，写清事实和它的依据或情境）。',
  '用第三人称陈述句并标明主体（「用户…」「项目定了…」），提到用户时每次都写「用户」，不用「他」「她」代称，日后读到时能和用户当下的话分开。',
  '用自己的话概括清楚，去掉口语和语气词；补充说明直接写进句子，正文里不加括号补注：别名和缩写放进 tags，日期按对话里的精度写，对话里没提到的细节直接略过；人名、地名、数字、单位、命令和路径照原样写，不概括成类别；适用范围和确定程度照对话里的写。',
  '正文只写这件事本身：这条是用户告诉你的、什么时候记的，记录会自动保存；第三方出处（同事、文档、通知）照常写进正文或「依据：」；写记忆时的操作经过（写入被拒、重试）留在会话里。只写对话或资料里有依据的内容，不替用户编理由。',
  '怎么用由类型统一交代，正文里不另列泛泛的使用场景和注意事项；不写行号、临时路径这类很快过时的细节，改用稳定的位置描述。',
  '完整经过可以用 memory_source 回查，不用抄进正文。提到别的记忆时写它的名称，不写记忆 id。',
].join('')

/** memory_save 描述的落盘段（project 的解析、"global" 的落法、更新的写法）。 */
const SAVE_PERSISTENCE = [
  '落盘：project 缺省写入 PLASTIC_PROJECT（未配置时按进程 cwd 推导）的项目；传绝对路径写入该项目（目录不存在会创建）；',
  '传 "global" 不是直接写全局，而是写入当前项目、标成全局提升候选（globalCandidate: true），等人在 WebUI 确认后才提升。',
  '更新带 id：title、text 给全量，summary、tags、type 没给的沿用目标记忆。',
  '更新目标是全局记忆时直接拒绝：MCP 没有确认更新的通道，去 WebUI 上改，或确认内容对所有项目都成立后在当前项目新建一条。',
  '重复主题会被结构去重拦下（返回 duplicate-suspected 和已有记忆清单）；疑似密钥被拦下（rejected 带原因），用户确认后带 force: true 重发。',
].join('')

export interface MemoryToolset {
  /** 七个工具的实现；测试钩子（withTestHoldLock）可整体替换其中的函数，处理器按属性现取。 */
  tools: MemoryTools
  /** 现读设置（变了重建类型表）并按当前类型表把七个工具（重）注册到 server；变了回 true（registerTool 自带 tools/list_changed 通知）。 */
  register(server: McpServer): Promise<boolean>
}

export function createMemoryTools(context: MemoryContextPort, options: MemoryToolsOptions = {}): MemoryToolset {
  const cwd = (): string => options.cwd?.() ?? process.cwd()
  const absolutize = (value: string): string => (isAbsolute(value) ? resolve(value) : resolve(cwd(), value))
  /** 缺省工作目录：PLASTIC_PROJECT（"global" 不是路径，退回 cwd）→ cwd。按原文用，不做存在性检查（与既有语义一致）。 */
  const defaultWorkspace = (): string => {
    const fixed = context.project
    if (fixed === undefined || fixed === 'global') return resolve(cwd())
    return isAbsolute(fixed) ? resolve(fixed) : resolve(cwd(), fixed)
  }

  const save = async (input: MemorySaveInput): Promise<MemorySaveResult> => {
    const title = input.title.trim()
    if (title === '') throw new Error('title 不能为空')
    const sourceMode = ORIGIN_SOURCE_MODE[input.origin]
    if (sourceMode === undefined) {
      throw new Error(`origin 只能取 ${Object.keys(ORIGIN_SOURCE_MODE).join('、')}：${String(input.origin)}`)
    }
    const explicit = requestedProject(input.project)
    // project 入参缺省时 PLASTIC_PROJECT 也算：环境里的 "global" 与显式传 "global" 同一条守卫
    const requested = explicit ?? context.project
    const isGlobalRequest = requested === 'global'
    const workspacePath = isGlobalRequest || explicit === undefined
      ? defaultWorkspace()
      : (await context.resolveProject(explicit)) ?? absolutize(explicit)
    // project: "global" 走 scope=global，由管线降级成当前项目的全局提升候选（唯一的全局处理路径）
    const scope: 'global' | 'workspace' = isGlobalRequest ? 'global' : 'workspace'

    // 更新：先读目标，没给的字段沿用目标；全局目标直接拒（MCP 没有确认码通道）
    let base: Awaited<ReturnType<MemoryStore['get']>> | undefined
    if (input.id !== undefined) {
      base = await context.store.get(input.id, { workspacePath })
      if (base === undefined || base.status === 'deleted') {
        return { ok: false, kind: 'rejected', reason: `更新目标不存在或已删除：${input.id}` }
      }
      if (base.scope === 'global') {
        return {
          ok: false, kind: 'rejected',
          reason: '更新目标是全局记忆：MCP 端没有确认更新的通道，去 WebUI 上改，或确认内容对所有项目都成立后在当前项目新建一条记忆。',
        }
      }
    } else if (input.type === undefined || !context.registry.has(input.type)) {
      // 新建必填且必须在当前场景里：枚举写进 schema，设置热更新后枚举可能变旧，这里按现行表再验一次
      return {
        ok: false, kind: 'rejected',
        reason: `type 必须是当前场景的类型之一（${context.registry.all().map(t => t.name).join('、')}）：${String(input.type)}`,
      }
    }

    // 来源锚定位（spec §A2）：拿收到的原文（不 trim）去客户端存储里对「刚刚发出这一次调用」，对上才带真锚；
    // 没配置、没对上、读不了都落到通道标识。对不上就不锚，任何失败都不挡写入。
    const anchor = await context.locateAnchor?.({ title: input.title, text: input.text }) ?? undefined
    const session: ToolSession = anchor !== undefined
      ? { id: anchor.sessionId, turnStartSeq: anchor.eventRange[0], lastSeq: anchor.eventRange[1] }
      : { id: `mcp:${context.client}` }

    const outcome = await context.save({
      action: base !== undefined ? 'update' : 'create',
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: title,
      type: input.type ?? base?.type,
      scope: base?.scope ?? scope,
      content: input.text,
      summary: input.summary ?? (base !== undefined ? base.summary : deriveSummary(input.text)),
      tags: input.tags ?? base?.tags ?? [],
      sourceMode,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.force === true ? { force: true } : {}),
    }, workspacePath, session)
    if (outcome.kind === 'saved' || outcome.kind === 'updated') {
      // create 不返回落盘路径（同名会追加 id 片段），写完按 id 定位一次拿准确文件路径
      const located = await context.store.locate(outcome.record!.id, { workspacePath })
      if (located === undefined) throw new Error(`写入后定位不到记录：${outcome.record!.id}`)
      return {
        ok: true, kind: outcome.kind, id: outcome.record!.id, path: located.filePath,
        // source 原样透出（记录里恒有）：没锚上时是 mcp:<client> 与 [0, 0]，模型与人都看得到这次没锚上
        source: outcome.record!.source,
        ...(outcome.warnings !== undefined && outcome.warnings.length > 0 ? { warnings: outcome.warnings.map(w => w.text) } : {}),
        ...(outcome.record!.globalCandidate === true ? { promotion: 'candidate' as const } : {}),
      }
    }
    if (outcome.kind === 'duplicate-suspected') return { ok: false, kind: outcome.kind, existing: outcome.existing ?? [] }
    return { ok: false, kind: 'rejected', reason: outcome.reason ?? '写入被拒绝' }
  }

  const recall = async (input: MemoryRecallInput = {}): Promise<MemoryRecallResult> => {
    const requested = requestedProject(input.project)
    let workspacePath: string | undefined
    if (requested === 'global') {
      workspacePath = undefined
    } else if (requested === undefined) {
      // 与检索同一口径：PLASTIC_PROJECT（"global" 不是路径）→ cwd
      workspacePath = defaultWorkspace()
    } else {
      if (!isAbsolute(requested)) throw new Error(`project 必须是绝对路径或 "global"：${requested}`)
      workspacePath = await context.resolveProject(requested)
      if (workspacePath === undefined) throw new Error(`project 不存在或读不了：${requested}`)
    }
    const snap = await context.snapshot(workspacePath)
    return { text: snap.text, usedTokens: snap.usedTokens, injectedCount: snap.injectedIds.length }
  }

  const search = async (input: MemorySearchInput): Promise<MemorySearchResult> => {
    const topK = Math.min(Math.max(input.topK ?? DEFAULT_SEARCH_TOP_K, 1), MAX_SEARCH_TOP_K)
    const requested = requestedProject(input.project)
    const scope: Pick<SearchInput, 'project' | 'workspacePath'> = requested === 'global'
      ? { project: 'global' }
      : { workspacePath: requested === undefined ? defaultWorkspace() : (await context.resolveProject(requested)) ?? absolutize(requested) }
    const { hits } = await context.search({ query: input.query, topK, ...scope })
    return { hits: hits.map(hit => ({ id: hit.id, title: hit.title, summary: hit.summary, path: hit.path })) }
  }

  const read = async (input: MemoryReadInput): Promise<MemoryRecordView> => {
    // 按 id 定位（全局 + 当前项目的会话视角，找不到再扫其他项目；含 .archive/）：读全文用，不受检索截断影响
    const located = await context.store.locate(input.id, { workspacePath: defaultWorkspace() })
    if (located === undefined) throw new Error(`找不到记忆：${input.id}`)
    // 位置即作用域：.archive/ 里的文件 status 一律按 deleted 返回
    return recordView(located)
  }

  const forget = async (input: MemoryForgetInput): Promise<MemoryForgetResult> => {
    const located = await context.store.locate(input.id, { workspacePath: defaultWorkspace() })
    if (located === undefined) return { ok: false }
    // 只走软删（进 .archive/，可恢复）；MCP 端不提供 store.hardDelete 的任何入口
    return { ok: await context.store.softDelete(byPosition(located)) }
  }

  /**
   * 只读简版体检：扫全库（global 与所有项目，含 .archive/）统计三类机械问题，不写任何文件。
   * orphan 口径与插件侧治理一致（src/governance/rule-scan.ts）：supersedes 目标「查不到」或「已删」才算孤儿，
   * 被取代后归档的 superseded 副本不算——不读 .archive/ 会把正常替代链误判成断链。
   * 扣分口径与 memory_health 的 description 保持一致：malformed 每条例 10 分/上限 30，expired 4/20，orphan 3/15；
   * score = 100 − 扣分合计，夹在 0–100 的整数。
   */
  const source = async (input: MemorySourceInput): Promise<MemorySourceResult & { text: string }> => {
    // 跨项目门在实现层里按 workspacePath 判（与 DSH 的 executeSource 同一条规则）；独立端没有子会话委派
    return await context.source(input, defaultWorkspace())
  }

  const health = async (): Promise<MemoryHealthResult> => {
    const stamp = options.now?.() ?? Date.now()
    const read = await context.store.readRaw(undefined, { includeArchive: true })
    const malformed = read.quarantined
    const active = read.records.filter(located => located.record.status === 'active')
    const expired = active.filter(located => located.record.validTo !== undefined && located.record.validTo <= stamp)
    const statusById = new Map(read.records.map(located => [located.record.id, located.record.status] as const))
    const orphans = active.filter(located => (located.record.supersedes ?? []).some(id => {
      const status = statusById.get(id)
      return status === undefined || status === 'deleted'
    }))
    const penalty = (count: number, rule: { per: number; cap: number }): number => Math.min(count * rule.per, rule.cap)
    const score = Math.max(0, 100
      - penalty(malformed.length, HEALTH_PENALTY.malformed)
      - penalty(expired.length, HEALTH_PENALTY.expired)
      - penalty(orphans.length, HEALTH_PENALTY.orphan))
    const issues = [
      malformed.length > 0 && { penalty: penalty(malformed.length, HEALTH_PENALTY.malformed), text: `${malformed.length} 个文件解析失败进入隔离区：${malformed[0]!.path}` },
      expired.length > 0 && { penalty: penalty(expired.length, HEALTH_PENALTY.expired), text: `${expired.length} 条在用记忆已过期：${expired[0]!.record.id}` },
      orphans.length > 0 && { penalty: penalty(orphans.length, HEALTH_PENALTY.orphan), text: `${orphans.length} 条记忆的 supersedes 指向不存在或已删除的 id：${orphans[0]!.record.id}` },
    ].filter(issue => issue !== false)
    issues.sort((a, b) => b.penalty - a.penalty)
    return {
      score,
      issueCount: malformed.length + expired.length + orphans.length,
      topIssues: issues.map(issue => issue.text).slice(0, 5),
    }
  }

  const self: MemoryToolset = {
    tools: { save, recall, search, read, forget, health, source },
    async register(server) {
      const changed = await context.refresh()
      define(server)
      return changed
    },
  }

  /** 按当前类型表把七个工具注册到 server（重名即覆盖，SDK 自动发 tools/list_changed）。 */
  function define(server: McpServer): void {
    const typeNames = context.registry.all().map(t => t.name)
    const rules = context.registry.renderSaveDescription('mcp')
    server.registerTool('memory_save', {
      description: [
        '保存一条长期记忆：写入三端共享的记忆根，走与 DSH 插件同一条写入管线（结构去重、疑似密钥拦截、更新、取代、有效期、快照先行）。',
        'summary 缺省按 text 首行派生（首行为空时取正文开头，最多 120 字符）。origin 必填：五档取 DSH 的原名，',
        'user-stated 是 user-explicit 的别名、model-observed 是 environment-observed 的别名。',
        '',
        rules,
        '',
        SAVE_PERSISTENCE,
      ].join('\n'),
      inputSchema: {
        title: z.string().describe('记录名，进记忆文件名与索引（2-16 字左右）'),
        text: z.string().describe(MCP_TEXT_GUIDE),
        origin: z.enum(['user-stated', 'model-observed', 'user-explicit', 'user-behavior', 'environment-observed', 'agent-inferred', 'agent-action-confirmed'])
          .describe('信息从哪来，决定置信度上限。user-explicit：用户明说的（别名 user-stated）。agent-action-confirmed：你做的事经用户确认有效或被采纳。user-behavior：用户反复做出的动作（多次改写、撤销、拒绝同一类做法）；对一次举动揣测动机不算。environment-observed：从文件、命令输出、配置里直接读到的事实（别名 model-observed）。agent-inferred：你自己的推断和解读；只要中间有一步是你推出来的、不是直接看到的，就填它。'),
        project: z.string().optional().describe('项目路径（绝对路径，相对路径按进程 cwd 解析）；缺省用 PLASTIC_PROJECT 或 cwd；"global" 表示全局提升候选'),
        type: z.enum(typeNames).optional().describe('记录类型：新建必填，取当前场景的类型之一；更新缺省沿用目标记忆'),
        id: z.string().optional().describe('更新目标：给了它就是更新（title/text 给全量，summary/tags/type 没给的沿用目标记忆）'),
        summary: z.string().optional().describe('一句话说清这条记忆讲什么；缺省新建按 text 首行派生、更新沿用目标'),
        tags: z.array(z.string()).optional().describe('只写正文、title、summary 里都没出现、但以后可能被拿来搜它的词：同义词、中英文别名、缩写'),
        confidence: z.number().min(0).max(1).optional().describe('取值 0–1（0.9=确定，0.5=推测），只能下调到来源档位的上限'),
        supersedes: z.array(z.string()).optional().describe('被这条新记忆取代的旧记忆 id（新建时用）。旧的随即失效、不再带入；旧说法要留档时用它'),
        validFrom: z.string().optional().describe('生效起始，本机时间 YYYY-MM-DD HH:mm 或 YYYY-MM-DD；只有用户说了从什么时候开始才填'),
        validTo: z.string().optional().describe('失效截止，本机时间 YYYY-MM-DD HH:mm 或 YYYY-MM-DD；到点后不再带入、搜不到'),
        force: z.boolean().optional().describe('跳过结构去重与疑似密钥拦截（用户已确认）'),
      },
    }, async args => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.save(args))
    })

    server.registerTool('memory_recall', {
      description: [
        '读取项目（全局 + 该项目）的注入快照原文：各类记忆怎么用、记了什么、每条的 id 与文件路径都在里面。',
        '做需要长期记忆的事之前先调它，不用逐条检索。project 缺省用 PLASTIC_PROJECT（未配置时按进程 cwd）；',
        '传 "global" 只带全局；传绝对路径带全局 + 该项目。与快照接口（/api/gui/snapshot）回的是同一段文本。',
      ].join(''),
      inputSchema: {
        project: z.string().optional().describe('项目路径（绝对路径）或 "global"；缺省用 PLASTIC_PROJECT 或 cwd'),
      },
    }, async args => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.recall(args))
    })

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
    }, async args => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.search(args))
    })

    server.registerTool('memory_read', {
      description: [
        '按 id 读取一条记忆的完整记录：frontmatter 字段（title、type、scope、tags、status、source、时间戳等）与正文 text，',
        '另带文件绝对路径 path。已软删的记忆照常返回，status 为 deleted，path 指向 .archive/。',
      ].join(''),
      inputSchema: {
        id: z.string().describe('记忆 id（mem_ 开头，来自 memory_save / memory_search / memory_recall）'),
      },
    }, async args => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.read(args))
    })

    server.registerTool('memory_forget', {
      description: [
        '软删一条记忆：文件移入记忆根的 .archive/，可通过 WebUI 恢复。MCP 不提供物理删除。',
        'id 不存在时返回 { ok: false }。',
      ].join(''),
      inputSchema: {
        id: z.string().describe('要软删的记忆 id'),
      },
    }, async args => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.forget(args))
    })

    server.registerTool('memory_health', {
      description: [
        '只读简版体检，不写任何文件。口径：扫全库（global 与所有项目，含 .archive/）——',
        'malformed：frontmatter 解析失败进入隔离区的文件，每个扣 10 分、最多扣 30；',
        'expired：active 但 validTo 已过期的记忆，每个扣 4 分、最多扣 20；',
        'orphan：supersedes 指向不存在或已删除 id 的在用记忆，每个扣 3 分、最多扣 15（被取代后归档的记录不算）。',
        'score = 100 减去扣分合计，夹在 0–100 的整数；issueCount 是三类问题条数之和；',
        'topIssues 是按类聚合的问题摘要（扣分多的在前，最多 5 条）。完整体检与拍板在 WebUI。',
      ].join(''),
      inputSchema: {},
    }, async () => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.health())
    })

    server.registerTool('memory_source', {
      description: [
        '回查一条长期记忆的原始出处：读取产生这条记忆的会话轨迹片段（当时的对话原文）。',
        '用于核对记忆的来源语境，例如记忆之间矛盾、或治理裁决前想看当时用户怎么说的。',
        '只读，只能回查当前项目和全局记忆；原始会话已不可读时会明确告知。',
        '写入时定位到会话的（source.sessionId 带 zcode:/antigravity: 前缀）在本机对应客户端的存储里开窗读；',
        '没定位到的（mcp: 前缀）没有可回查的对话；DSH 会话写的请在 DSH 里回查。',
      ].join(''),
      inputSchema: {
        memoryId: z.string().describe('要回查的记忆 id（快照/搜索结果里的 mem_ 开头 id）'),
        window: z.number().int().min(1).max(24).optional().describe('读取的事件条数，缺省覆盖记忆产生的当轮对话，上限 24'),
      },
    }, async args => {
      await refreshAndRedefined(server)
      return jsonResult(await self.tools.source(args))
    })
  }

  /** 每次工具调用前比对一次设置；类型配置变了就按新类型表重注册（SDK 自动通知 tools/list_changed）。 */
  async function refreshAndRedefined(server: McpServer): Promise<void> {
    if (await context.refresh()) define(server)
  }

  return self
}

/** 工具结果统一走一段 JSON 文本（输出形状都在 JSON 里，客户端按 text 解析）。 */
function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}
