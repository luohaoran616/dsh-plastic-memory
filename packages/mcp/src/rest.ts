import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
import type { MemoryCore, SearchInput } from '@plastic/core/factory.ts'
import { memoryRecordSchema, type MemoryRecord } from '@plastic/core/record-schema.ts'
import { scopeOfMemory, type Scope } from '@plastic/core/scope.ts'
import { byPosition, type LocateTarget, type MemoryLogger } from '@plastic/core/storage/table.ts'
import {
  MAX_SEARCH_TOP_K, PROMOTE_REVIEW_KEY, defaultWorkspacePath, deriveSummary, recordView,
  type MemoryRecordView, type MemoryTools,
} from './tools.ts'

/**
 * REST 管理面（D4 的 `/api/*`）：与 MCP 工具面共用同一个 `MemoryCore` 与 `MemoryTools`，
 * 不另起存储层、不复制健康分口径。记录读写一律走 core 的 store / search（唯一事实源），
 * 这里只做「HTTP 入参 → core 调用 → JSON 出参」的翻译。
 *
 * 返回形状：
 * - 列表与单条同形（MemoryRecordView：title/text + core 的完整 frontmatter），前端编辑不用再猜字段；
 * - `GET /api/health` 直接返回 `{ score, issueCount, topIssues }`（Task 3 的实现，不是 MCP content 块）；
 * - 错误一律 `{ error: string }`，状态码区分 400/401/404/405/409/500（超限请求体 413）。
 *
 * PUT 的冲突标记用 `updatedAt`（客户端从 GET 拿到的那个值）：写回时锁内按它做 isChanged，
 * 过期即 409 且不写盘。请求体里的 id/source/status 等不可编辑字段一律忽略，以磁盘现状为准。
 */

/** REST 面的路径前缀；serve.ts 据此把 `/api` 与 `/mcp`、静态托管分开。 */
export const API_PREFIX = '/api'

/** 请求体上限：整条记录替换是纯文本，1 MiB 足够，也挡住误连的大文件。 */
const MAX_BODY_BYTES = 1024 * 1024

const RECORD_PATH = new RegExp(`^${API_PREFIX}/records/([^/]+)$`)
const RESTORE_PATH = new RegExp(`^${API_PREFIX}/records/([^/]+)/restore$`)

export interface RestOptions {
  core: MemoryCore
  /** Task 3 的工具实现层：`GET /api/health` 直接调它的 `health()`，不另写扣分表。 */
  tools: MemoryTools
  /** 固定项目映射（PLASTIC_PROJECT）：scope 缺省时作为当前项目。 */
  project?: string
  /** 相对路径的解析基准与缺省项目；缺省 process.cwd（与 MCP 进程同口径）。 */
  cwd?: () => string
  log?: MemoryLogger
}

/** 处理一个 /api 请求；返回 false 表示不是本模块认领的路径（由调用方回 404）。 */
export type RestHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>

/** JSON 响应统一入口（serve.ts 的鉴权失败与 MCP 错误响应也用它）。 */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error }, headers)
}

type ReadBodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string }

async function readJsonBody(req: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: '请求体过大' }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: false, status: 400, error: '请求体必须是 JSON 对象' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, error: '请求体不是合法 JSON' }
  }
}

interface ScopeSelection {
  /** 给 core.search 的作用域参数：scope 缺省时是可见集合（global + 当前项目）。 */
  search: Pick<SearchInput, 'project' | 'workspacePath'>
  /** 检索命中后按同一个作用域取回整条记录。 */
  locate: LocateTarget
}

/** scope 查询参数 → core 的作用域口径：'global' 只查全局，路径只查该项目，都不给查可见集合。 */
function selectScope(raw: string | null, options: RestOptions, cwd: () => string): ScopeSelection {
  const value = (raw ?? '').trim()
  if (value === 'global') return { search: { project: 'global' }, locate: { kind: 'global' } }
  if (value !== '') {
    const workspacePath = isAbsolute(value) ? resolve(value) : resolve(cwd(), value)
    return { search: { project: workspacePath }, locate: { kind: 'workspace', workspacePath } }
  }
  const workspacePath = defaultWorkspacePath({ project: options.project, cwd })
  return { search: { workspacePath }, locate: { workspacePath } }
}

/** 记录自己的那一份副本：写/删/恢复只动它，同 id 在别处的副本不连坐。 */
function recordTarget(record: MemoryRecord): LocateTarget {
  return scopeOfMemory(record) ?? { workspacePath: record.workspacePath }
}

/** store 的删除/恢复只接受具体作用域（Scope）；定位不到作用域时交给它的缺省口径。 */
function deleteScope(record: MemoryRecord): { at?: Scope } {
  const scope = scopeOfMemory(record)
  return scope === undefined ? {} : { at: scope }
}

function allowMethod(req: IncomingMessage, res: ServerResponse, methods: readonly string[]): boolean {
  if (methods.includes(req.method ?? '')) return true
  sendError(res, 405, `方法不允许：${req.method ?? ''}`, { allow: methods.join(', ') })
  return false
}

interface RecordUpdate {
  updatedAt: number
  title: string
  text: string
  type?: string
  tags?: string[]
  summary?: string
  id?: string
}

type ParseUpdateResult = { ok: true; value: RecordUpdate } | { ok: false; error: string }

/** PUT 请求体校验：updatedAt 是并发标记必填，title/text 是整条替换的内容主体；其余可选字段缺省保留现值。 */
function parseRecordUpdate(body: unknown): ParseUpdateResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '请求体必须是 JSON 对象' }
  const fields = body as Record<string, unknown>
  if (typeof fields.updatedAt !== 'number' || !Number.isFinite(fields.updatedAt)) {
    return { ok: false, error: 'updatedAt 必填：传 GET 读到的版本作为并发标记' }
  }
  if (typeof fields.title !== 'string' || fields.title.trim() === '') return { ok: false, error: 'title 必须是非空字符串' }
  if (typeof fields.text !== 'string') return { ok: false, error: 'text 必须是字符串' }
  if (fields.id !== undefined && typeof fields.id !== 'string') return { ok: false, error: 'id 必须是字符串' }
  if (fields.type !== undefined && (typeof fields.type !== 'string' || fields.type.trim() === '')) {
    return { ok: false, error: 'type 必须是非空字符串' }
  }
  if (fields.tags !== undefined && (!Array.isArray(fields.tags) || fields.tags.some(tag => typeof tag !== 'string'))) {
    return { ok: false, error: 'tags 必须是字符串数组' }
  }
  if (fields.summary !== undefined && typeof fields.summary !== 'string') return { ok: false, error: 'summary 必须是字符串' }
  const tags = fields.tags as unknown[] | undefined
  return {
    ok: true,
    value: {
      updatedAt: fields.updatedAt,
      title: fields.title.trim(),
      text: fields.text,
      ...(fields.type === undefined ? {} : { type: (fields.type as string).trim() }),
      ...(tags === undefined ? {} : { tags: tags as string[] }),
      ...(fields.summary === undefined ? {} : { summary: (fields.summary as string).trim() }),
      ...(fields.id === undefined ? {} : { id: fields.id }),
    },
  }
}

function decodeId(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

export function createRestHandler(options: RestOptions): RestHandler {
  const { core, tools } = options
  const cwd = (): string => options.cwd?.() ?? process.cwd()
  /** 读单条/定位目标的缺省视角：与 MCP 工具面同一个「当前项目」。 */
  const readTarget = (): LocateTarget => ({ workspacePath: defaultWorkspacePath({ project: options.project, cwd }) })

  const updateRecord = async (id: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const located = await core.store.locate(id, readTarget(), { isMissRechecked: true })
    if (located === undefined) return sendError(res, 404, `找不到记忆：${id}`)
    const current = byPosition(located)
    const body = await readJsonBody(req)
    if (!body.ok) return sendError(res, body.status, body.error)
    const parsed = parseRecordUpdate(body.value)
    if (!parsed.ok) return sendError(res, 400, parsed.error)
    const update = parsed.value
    if (update.id !== undefined && update.id !== id) return sendError(res, 400, '请求体 id 与路径不一致')
    // 软删的记录只能先 restore 再编辑：PUT 不复活记录，也不覆盖归档文件
    if (current.status !== 'active') return sendError(res, 409, '记录已删除，不能编辑')

    const stamp = Date.now()
    // 整条替换：只取可编辑的内容面，id/scope/source/status/治理标记与时间线由磁盘现状保底
    const next = memoryRecordSchema.parse({
      ...current,
      name: update.title,
      content: update.text,
      type: update.type ?? current.type,
      tags: update.tags ?? current.tags,
      summary: update.summary ?? deriveSummary(update.text),
      updatedAt: stamp,
      lastConfirmedAt: stamp,
    })
    const target = recordTarget(current)
    const written = await core.store.updateIfLive(current, () => next, target, {
      isChanged: latest => latest.updatedAt !== update.updatedAt,
    })
    if (written === undefined) return sendError(res, 409, '记录在读取之后被改过，未写入（请重新读取后再提交）')
    const reread = await core.store.locate(id, target)
    if (reread === undefined) return sendError(res, 500, '写入后定位不到记录')
    sendJson(res, 200, recordView(reread))
  }

  const deleteRecord = async (id: string, res: ServerResponse): Promise<void> => {
    const located = await core.store.locate(id, readTarget(), { isMissRechecked: true })
    if (located === undefined) return sendError(res, 404, `找不到记忆：${id}`)
    const current = byPosition(located)
    // 软删：文件进 .archive/，可从 POST .../restore 恢复；REST 不提供硬删
    if (!(await core.store.softDelete(current, deleteScope(current)))) {
      return sendError(res, 404, `找不到记忆：${id}`)
    }
    sendJson(res, 200, { ok: true, id })
  }

  const restoreRecord = async (id: string, res: ServerResponse): Promise<void> => {
    const located = await core.store.locate(id, readTarget(), { isMissRechecked: true })
    if (located === undefined) return sendError(res, 404, `找不到记忆：${id}`)
    const current = byPosition(located)
    const target = recordTarget(current)
    if (!(await core.store.restoreArchived(current, deleteScope(current)))) {
      return sendError(res, 404, `找不到记忆：${id}`)
    }
    const reread = await core.store.locate(id, target)
    if (reread === undefined) return sendError(res, 500, '恢复后定位不到记录')
    sendJson(res, 200, recordView(reread))
  }

  const listRecords = async (res: ServerResponse, url: URL): Promise<void> => {
    const scope = selectScope(url.searchParams.get('scope'), options, cwd)
    const query = url.searchParams.get('q') ?? ''
    // 关键词与空查询都走 core.search：同一套分词、打分与作用域口径，REST 不另写一份
    const { hits } = await core.search({ query, topK: MAX_SEARCH_TOP_K, ...scope.search })
    const views = await Promise.all(hits.map(async (hit) => {
      const located = await core.store.locate(hit.id, scope.locate) ?? await core.store.locate(hit.id, readTarget())
      return located === undefined ? undefined : recordView(located)
    }))
    sendJson(res, 200, views.filter((view): view is MemoryRecordView => view !== undefined))
  }

  const listPromotions = async (res: ServerResponse): Promise<void> => {
    // 治理队列看全库（跨项目）：core 的 queryScope 按 active 读出同 id 一份，再筛 MCP 打的提升标记
    const { records } = await core.store.queryScope({ status: ['active'] })
    const flagged = records.filter(record => record[PROMOTE_REVIEW_KEY] === true)
    const views = await Promise.all(flagged.map(async (record) => {
      const located = await core.store.locate(record.id, recordTarget(record))
      return located === undefined ? undefined : recordView(located)
    }))
    sendJson(res, 200, views.filter((view): view is MemoryRecordView => view !== undefined))
  }

  return async (req, res, url) => {
    try {
      const path = url.pathname
      if (path === `${API_PREFIX}/health`) {
        if (!allowMethod(req, res, ['GET'])) return true
        // 复用 Task 3 的 health()：只搬 JSON，不带 MCP content 外壳
        sendJson(res, 200, await tools.health())
        return true
      }
      if (path === `${API_PREFIX}/promotions`) {
        if (!allowMethod(req, res, ['GET'])) return true
        await listPromotions(res)
        return true
      }
      if (path === `${API_PREFIX}/records`) {
        if (!allowMethod(req, res, ['GET'])) return true
        await listRecords(res, url)
        return true
      }

      const restoreMatch = RESTORE_PATH.exec(path)
      if (restoreMatch !== null) {
        const id = decodeId(restoreMatch[1]!)
        if (id === undefined) {
          sendError(res, 400, '记录 id 编码非法')
          return true
        }
        if (!allowMethod(req, res, ['POST'])) return true
        await restoreRecord(id, res)
        return true
      }

      const recordMatch = RECORD_PATH.exec(path)
      if (recordMatch !== null) {
        const id = decodeId(recordMatch[1]!)
        if (id === undefined) {
          sendError(res, 400, '记录 id 编码非法')
          return true
        }
        switch (req.method) {
          case 'GET': {
            const located = await core.store.locate(id, readTarget())
            if (located === undefined) {
              sendError(res, 404, `找不到记忆：${id}`)
              return true
            }
            sendJson(res, 200, recordView(located))
            return true
          }
          case 'PUT':
            await updateRecord(id, req, res)
            return true
          case 'DELETE':
            await deleteRecord(id, res)
            return true
          default:
            allowMethod(req, res, ['GET', 'PUT', 'DELETE'])
            return true
        }
      }
      return false
    } catch (error) {
      options.log?.error('[plastic-memory] REST 请求失败:', error)
      if (!res.headersSent) sendError(res, 500, '内部错误')
      else res.destroy()
      return true
    }
  }
}
