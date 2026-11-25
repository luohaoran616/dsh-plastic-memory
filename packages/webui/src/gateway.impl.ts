/**
 * REST 版 gateway：WebUI 与 `plastic-mcp serve` 之间的唯一数据通道（D4 的 `/api/*`）。
 *
 * 形状对齐原 `client/gateway.ts` 的 `MemoryGateway` 概念（列表/单条/编辑/软删/恢复/体检/提升审核），
 * 但那个接口绑的是 DSH 宿主通道（借会话 + 视图文件 + `/memory` 命令），在独立 SPA 里走不通，所以这里重新封装 REST。
 *
 * 约定：
 * - base URL 缺省是空串 → 请求相对路径 `/api/...`。页面与 `/api/*` 由同一个 serve 进程同源托管，
 *   端口可换而代码不动（别硬编码 127.0.0.1:7788）。
 * - 错误一律折成 `GatewayResult`，不抛异常：`409` 单独映射成 `conflict`——
 *   那是「你手上这份已经过期，重新读取再改」，不是失败率统计里的一次错误，界面上要给冲突提示而不是静默失败。
 * - 只搬 JSON，不碰磁盘：所有写路径由服务端交给 core（同一把跨进程写锁）。
 */

/** core 记录来源档（R11）：界面按它显示「谁说的」。 */
export type SourceMode = 'user-explicit' | 'user-behavior' | 'environment-observed' | 'agent-inferred' | 'agent-action-confirmed'

/** REST 单条记录的对外形状（服务端 `recordView`）：`title`/`text` 就是核心的 name/content，其余是完整 frontmatter。 */
export interface RecordView {
  id: string
  title: string
  text: string
  /** 记录在记忆根里的实际文件路径（溯源用）。已删记录的路径在 `.archive/` 下。 */
  path: string
  type: string
  scope: 'global' | 'workspace'
  workspacePath?: string
  tags: string[]
  summary: string
  source?: { sessionId: string; eventRange: [number, number]; sourceMode: SourceMode }
  createdAt: number
  updatedAt: number
  lastConfirmedAt: number
  lastRecalledAt?: number | null
  recallCount?: number
  validTo?: number
  status: 'active' | 'superseded' | 'deleted'
  deletedAt?: number
  confidence: number
  globalCandidate?: boolean
  /** MCP 端 `project: "global"` 的落法：待人工确认提升（D3）。 */
  'needs-promote-review'?: boolean
  /** ZCode 导入溯源（D7）。 */
  'imported-from'?: string
  /** 子 agent 写入的委派信息（宿主填）；记忆卡用它显示「第几层 / 待确认」。 */
  delegation?: { depth: number; reviewed?: { by: 'user' | 'main'; at: number } }
}

/** 列表分页信封：`limit` 缺省与上限都是 100，翻页用 `offset`，`hasMore` 表示还有没有下一页。 */
export interface RecordPage {
  records: RecordView[]
  limit: number
  offset: number
  hasMore: boolean
}

/** `GET /api/health` 的只读简版（不是 MCP content 块）。 */
export interface HealthSummary {
  score: number
  issueCount: number
  topIssues: string[]
}

export type PromotionAction = 'approve' | 'dismiss'

/**
 * 提升审核的处理结果。`changed=false` 是「无需处理」；`taken=true` 是 approve 撞上全局已有同 id 的副本——
 * 记录原样留在项目内、不做任何写入，这**不是**错误，界面要把它和失败分开说。
 */
export interface PromotionResult {
  id: string
  action: PromotionAction
  changed: boolean
  reason?: string
  taken?: boolean
  record: RecordView
}

export type GatewayErrorKind = 'conflict' | 'not-found' | 'bad-request' | 'unauthorized' | 'http' | 'network'

export interface GatewayError {
  kind: GatewayErrorKind
  /** HTTP 状态码；`network` 没有（请求没到服务端）。 */
  status?: number
  /** 给人看的提示，界面直接显示。 */
  message: string
  /** 服务端 `{ error }` 里的原文（或传输层的原始错误），排错用。 */
  detail?: string
}

export type GatewayResult<T> = { ok: true; value: T } | { ok: false; error: GatewayError }

export interface RecordQuery {
  /** 与 core 的 project 同义：`'global'` 全局、给路径该项目、都不给是可见集合。 */
  scope?: string
  /** 关键词；空串等同不传（服务端按可见集合列出）。 */
  q?: string
  /** 1–100，缺省由服务端取上限 100。 */
  limit?: number
  offset?: number
  /** 缺省 active；`deleted` 列 `.archive/` 里的归档记录。 */
  status?: 'active' | 'deleted'
}

/** 整条替换的可编辑面；`updatedAt` 是并发标记，必须来自 GET 读到的那一份。 */
export interface RecordUpdateInput {
  updatedAt: number
  title: string
  text: string
  type?: string
  tags?: string[]
  summary?: string
}

export interface MemoryGateway {
  listRecords(query?: RecordQuery): Promise<GatewayResult<RecordPage>>
  getRecord(id: string): Promise<GatewayResult<RecordView>>
  updateRecord(id: string, input: RecordUpdateInput): Promise<GatewayResult<RecordView>>
  deleteRecord(id: string): Promise<GatewayResult<{ ok: boolean; id: string }>>
  restoreRecord(id: string): Promise<GatewayResult<RecordView>>
  health(): Promise<GatewayResult<HealthSummary>>
  listPromotions(): Promise<GatewayResult<RecordView[]>>
  actOnPromotion(id: string, action: PromotionAction): Promise<GatewayResult<PromotionResult>>
}

export interface RestGatewayOptions {
  /** 缺省空串 → 相对路径 `/api/...`（同源托管）。测试与特殊部署可给绝对地址。 */
  baseUrl?: string
  /** 缺省用全局 fetch；测试可换成记录用的假函数。 */
  fetch?: typeof fetch
}

const API_PREFIX = '/api'

const NETWORK_MESSAGE = '连不上记忆服务：请确认 plastic-mcp serve 正在运行，且页面与它在同一个地址下。'

/** 状态码 → 界面上要说的话。409 是并发过期，要用户重新读取；404 是没了；401 是没带令牌。 */
function mapHttpError(status: number, detail: string | undefined): GatewayError {
  const base = { status, ...(detail === undefined ? {} : { detail }) }
  if (status === 409) return { ...base, kind: 'conflict', message: '这条记录在你打开之后被改过，未保存。请重新读取最新内容后再提交。' }
  if (status === 404) return { ...base, kind: 'not-found', message: '找不到这条记录，可能已经被删除。' }
  if (status === 401) return { ...base, kind: 'unauthorized', message: '服务要求访问令牌（serve --token），当前请求没有带上。' }
  if (status === 400 || status === 413) return { ...base, kind: 'bad-request', message: `服务端拒绝了请求（HTTP ${status}）。` }
  return { ...base, kind: 'http', message: `请求失败（HTTP ${status}）。` }
}

/** 拼请求地址：只有给了值的参数才进查询串（缺省交给服务端的缺省口径，不在客户端编一套）。 */
function requestUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const base = baseUrl.replace(/\/+$/, '')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    params.set(key, String(value))
  }
  const search = params.toString()
  return `${base}${API_PREFIX}${path}${search === '' ? '' : `?${search}`}`
}

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE'
  body?: unknown
}

export function createRestGateway(options: RestGatewayOptions = {}): MemoryGateway {
  const baseUrl = options.baseUrl ?? ''
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)

  async function request<T>(path: string, query?: Record<string, string | number | undefined>, init: RequestOptions = {}): Promise<GatewayResult<T>> {
    let response: Response
    try {
      response = await doFetch(requestUrl(baseUrl, path, query), {
        method: init.method ?? 'GET',
        headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        cache: 'no-store',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (error) {
      return {
        ok: false,
        error: { kind: 'network', message: NETWORK_MESSAGE, detail: error instanceof Error ? error.message : String(error) },
      }
    }

    const text = await response.text().catch(() => '')
    let payload: unknown
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
    }
    const serverError = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as { error?: unknown }).error
      : undefined
    const detail = typeof serverError === 'string' ? serverError : undefined

    if (!response.ok) return { ok: false, error: mapHttpError(response.status, detail) }
    if (payload === undefined) {
      return { ok: false, error: { kind: 'http', status: response.status, message: '服务端返回的不是 JSON。', detail: text.slice(0, 200) } }
    }
    return { ok: true, value: payload as T }
  }

  const recordPath = (id: string, suffix = ''): string => `/records/${encodeURIComponent(id)}${suffix}`

  return {
    listRecords: query => request<RecordPage>('/records', {
      scope: query?.scope, q: query?.q, limit: query?.limit, offset: query?.offset, status: query?.status,
    }),

    getRecord: id => request<RecordView>(recordPath(id)),

    // updatedAt 必填：服务端拿它做锁内 isChanged，过期就 409 且不写盘
    updateRecord: (id, input) => request<RecordView>(recordPath(id), undefined, {
      method: 'PUT',
      body: {
        updatedAt: input.updatedAt,
        title: input.title,
        text: input.text,
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      },
    }),

    deleteRecord: id => request<{ ok: boolean; id: string }>(recordPath(id), undefined, { method: 'DELETE' }),

    restoreRecord: id => request<RecordView>(recordPath(id, '/restore'), undefined, { method: 'POST' }),

    health: () => request<HealthSummary>('/health'),

    listPromotions: () => request<RecordView[]>('/promotions'),

    actOnPromotion: (id, action) => request<PromotionResult>(`/promotions/${encodeURIComponent(id)}/${action}`, undefined, { method: 'POST' }),
  }
}
