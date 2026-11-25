import { z } from 'zod'
import { withinValidity } from './record-freshness.ts'
import { MemoryStore, type QueryScope } from './store.ts'
import { FileTable } from './storage/file-table.ts'
import { resolveMemoryRoot } from './storage/paths.ts'
import { createRootLock } from './storage/root-lock.ts'
import { SidecarStore } from './storage/sidecar.ts'
import { resolveLiveFirst, type MemoryLogger, type SessionTarget } from './storage/table.ts'
import { expandQueryTerms } from './text.ts'
import { tokenizerForQuery } from './search/jieba-segmenter.ts'
import { anchorTerms, compareRanked, rankRecords, type RankedRecord } from './search/ranking.ts'
import { CJK } from './search/tokenizer.ts'

/**
 * 记忆库的组装入口：DSH 插件之外的入口（MCP server、ZCode 导入器、REST/WebUI）都用它起同一份接线，
 * 不再各自组一遍。接线项从插件 `apply()` 的接线段平移：一把记忆根写锁、一张召回统计侧表、一个文件表、
 * 一个 MemoryStore，外加检索用的 jieba 分词器。治理侧的侧表（快照、待决账本、扫描缓存、建议忽略）是
 * DSH 宿主的事，不进这里。
 */

/** 组装参数。 */
export interface MemoryCoreOptions {
  /** 记忆根。调用方给已解析的绝对路径（MCP 侧由 `PLASTIC_MEMORY_ROOT` 决定）；空串按 DSH 记忆根的既有缺省解析。 */
  root: string
  /** 客户端标识（D6：zcode、antigravity…）。 */
  client: string
  /** 缺省回退 console，与 MemoryStore / FileTable 构造函数的既有缺省一致。 */
  log?: MemoryLogger
}

/** 一次检索的输入。作用域由调用方定好（MCP 把 project / cwd 映射成这里的参数），工厂不再猜。 */
export interface SearchInput {
  query: string
  /** 缺省 8，对齐 D2 里 memory_search 的 topK 缺省。 */
  topK?: number
  /** 限定作用域：`'global'` 只看全局，其他值当项目路径看待；缺省按 workspacePath 读可见集合。 */
  project?: string
  /** 当前项目：project 缺省时决定可见集合（global + 这个项目）；同 id 多副本时也是取舍的会话视角。 */
  workspacePath?: string
}

/** 一条命中：字段按 D2 的 memory_search 输出走，另带正文与文件绝对路径。 */
export interface SearchHit {
  id: string
  /** 记录名（对外的 title）。 */
  title: string
  type: string
  summary: string
  content: string
  tags: string[]
  /** 记忆文件的绝对路径。 */
  path: string
}

export interface SearchResult {
  hits: SearchHit[]
}

export interface MemoryCore {
  /** 组装时给的客户端标识（D6）：写入路径拿到它标记记录来源。 */
  readonly client: string
  store: MemoryStore
  search(query: SearchInput): Promise<SearchResult>
  close(): Promise<void>
}

/** topK 缺省值，对齐 D2。 */
export const DEFAULT_SEARCH_TOP_K = 8

/**
 * 工厂不建、不读、不暴露的四张治理侧表拿它填 SidecarStore 的 schema 槽位：任何误用当场解析失败，
 * 而不是在 core 里私造一份治理契约（治理 schema 留在插件包的 governance/schema.ts）。
 */
const UNUSED_SIDE_TABLE = z.never()

const CJK_CHAR = new RegExp(`[${CJK}]`, 'u')

/** 单个字母、纯数字几乎在每个文件里出现：既不作为打分 token，也不能进 any 模式预筛。单个 CJK 字是实词，保留。 */
function isNoiseTerm(term: string): boolean {
  return /^\p{N}+$/u.test(term) || ([...term].length === 1 && !CJK_CHAR.test(term))
}

/** 作用域参数 → QueryScope：project 优先，都没有时按可见集合（global + workspacePath）。 */
function scopeOf(input: SearchInput): QueryScope {
  if (input.project === 'global') return { kind: 'global' }
  if (input.project !== undefined) return { kind: 'workspace', workspacePath: input.project }
  return { kind: 'visible', workspacePath: input.workspacePath }
}

/** 同 id 多副本的取舍视角：可见集合用调用方给的项目，限定到某个项目时就是那个项目，全局没有视角。 */
function sessionOf(scope: QueryScope): SessionTarget {
  return { workspacePath: scope.kind === 'global' ? undefined : scope.workspacePath }
}

export async function createMemoryCore(opts: MemoryCoreOptions): Promise<MemoryCore> {
  const log = opts.log ?? console
  const root = resolveMemoryRoot(opts.root)
  // 一个进程实例一把，注入文件表与侧表：同实例内按持有计数嵌套，与其他进程（DSH 插件、另一个 MCP 进程）经锁库互斥
  const lock = createRootLock({ root, log })
  const sidecar = new SidecarStore({
    root,
    lock,
    schemas: {
      snapshots: UNUSED_SIDE_TABLE,
      pending: UNUSED_SIDE_TABLE,
      scanCache: UNUSED_SIDE_TABLE,
      adviceIgnores: UNUSED_SIDE_TABLE,
    },
    log,
  })
  // 索引行不注入格式器：FileTable 的缺省就是 core 的 formatIndexLine，行末带同目录文件名。
  // 插件那版要读类型注册表决定 passive 标注，core 没有类型注册表。
  const table = new FileTable({ root, lock, stats: sidecar.recallStats, log })
  const store = new MemoryStore(table, log, sidecar.recallStats)

  const search = async (input: SearchInput): Promise<SearchResult> => {
    // 查询与记录两侧共用这一个分词器：查询含汉字时是 jieba 档（首次搜索才加载），否则 bigram
    const tokenize = await tokenizerForQuery(input.query, { log })
    // 新 token 定前两档并打分；旧词项（expandQueryTerms）给第三档，兜住 id 这类不打分字段的子串命中
    const tokens = [...new Set(tokenize(input.query))].filter(t => !isNoiseTerm(t))
    const legacyTerms = expandQueryTerms(input.query)
    // 预筛词 = token ∪ 旧词项，any 模式：记录侧 token 必是原文连续子串，所以预筛是超集。
    // 并集里出现噪声词项时不预筛：剔掉它会漏掉只靠它命中的记录，留着它预筛也几乎不跳过任何文件。
    const unionTerms = [...new Set([...tokens, ...legacyTerms])]
    const prefilter = unionTerms.length > 0 && !unionTerms.some(isNoiseTerm)
      ? { prefilterTerms: unionTerms, prefilterMatch: 'any' as const }
      : {}
    const scope = scopeOf(input)
    const session = sessionOf(scope)
    const now = Date.now()
    // 与插件检索同一条读路径：按范围读目录 → 同 id 取舍 → active → validTo（过期的不进检索）
    const read = await store.readRaw(scope, prefilter)
    const located = resolveLiveFirst(read.records, session)
      .filter(l => l.record.status === 'active' && withinValidity(l.record, now))
    const records = located.map(l => l.record)
    // 零 token 查询：不做关键词过滤，范围内全部按 confidence、lastConfirmedAt 排
    const ranked: RankedRecord[] = tokens.length === 0 && legacyTerms.length === 0
      ? records.map(record => ({ record, tier: 'all', coverage: 0, anchorHits: 0, score: 0, tokenHits: [] }))
      : rankRecords({
        tokens, legacyTerms, anchors: anchorTerms(input.query), records, listedCount: read.listedCount, tokenize,
      })
    const top = ranked.sort(compareRanked).slice(0, Math.max(0, input.topK ?? DEFAULT_SEARCH_TOP_K))
    const pathOf = new Map(located.map(l => [l.record.id, l.filePath]))
    return {
      hits: top.map(({ record: r }) => ({
        id: r.id,
        title: r.name,
        type: r.type,
        summary: r.summary,
        content: r.content,
        tags: r.tags,
        path: pathOf.get(r.id)!,
      })),
    }
  }

  return {
    client: opts.client,
    store,
    search,
    /**
     * 没有常驻句柄要释放：写锁的连接按批开关（storage/root-lock.ts：一批的持有计数归零就回滚并关闭），
     * 文件表与侧表构造不做 I/O、不持句柄，分词器是进程级单例。这个出口留给调用方的进程退出路径，幂等。
     */
    async close(): Promise<void> {},
  }
}
