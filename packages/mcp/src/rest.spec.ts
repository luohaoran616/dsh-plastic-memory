import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createMemoryCore, type MemoryCore } from '@plastic/core/factory.ts'
import { memoryRecordSchema, type MemoryRecord } from '@plastic/core/record-schema.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { GLOBAL_DIR } from '@plastic/core/storage/paths.ts'
import { splitFrontmatter } from '@plastic/core/storage/frontmatter.ts'
import { PROMOTE_REVIEW_KEY, createMemoryTools, type MemoryTools } from './tools.ts'
import { baseEnv, callJson } from './spec-helpers.ts'
import {
  DEFAULT_PORT, DEFAULT_WEBUI_DIR, LOOPBACK_HOST, parseServeArgs, startMemoryServer,
  type MemoryHttpServer,
} from './serve.ts'

/**
 * REST 管理面与 HTTP 模式的实证：起真 node:http 服务，用 fetch 逐端点往返。
 * 这里不 mock core：种子记录经 `core.store.create` 落盘，读回也走同一份文件表，与 MCP 工具面共享同一个实现层。
 */

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 测试不关心日志：分词的降级告警等会从 core logger 出来，别污染用例输出。 */
const silentLog: MemoryLogger = { info() {}, warn() {}, error() {} }

let seq = 0
function seedRecord(partial: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1
  const stamp = Date.now()
  return memoryRecordSchema.parse({
    id: `mem_rest_${seq}`,
    name: '条目',
    type: 'knowledge',
    scope: 'global',
    tags: [],
    content: '正文',
    summary: '正文',
    source: { sessionId: 'rest-spec', eventRange: [0, 0], sourceMode: 'user-explicit' },
    createdAt: stamp,
    updatedAt: stamp,
    lastConfirmedAt: stamp,
    lastRecalledAt: null,
    recallCount: 0,
    status: 'active',
    confidence: 0.9,
    ...partial,
  })
}

interface ApiFixture {
  root: string
  core: MemoryCore
  tools: MemoryTools
  server: MemoryHttpServer
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

async function startApi(options: { records?: MemoryRecord[]; token?: string; webuiDir?: string } = {}): Promise<ApiFixture> {
  const root = await mkdtemp(join(tmpdir(), 'pm-mcp-rest-'))
  const core = await createMemoryCore({ root, client: 'rest-spec', log: silentLog })
  const tools = createMemoryTools(core, { client: 'rest-spec', project: process.cwd() })
  for (const record of options.records ?? []) await core.store.create(record)
  const server = await startMemoryServer({
    core, tools, port: 0, project: process.cwd(), log: silentLog,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.webuiDir === undefined ? {} : { webuiDir: options.webuiDir }),
  })
  cleanups.push(async () => {
    await server.close()
    await core.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, core, tools, server }
}

interface JsonResponse<T = unknown> {
  status: number
  body: T
  headers: Headers
}

/** GET /api/records 的分页信封：records 是本页，hasMore 表示后面还有（limit 缺省 100）。 */
interface RecordPage<T = Record<string, unknown>> {
  records: T[]
  limit: number
  offset: number
  hasMore: boolean
}

/** 提升审核的处理结果：changed=false 表示这条记录没有待处理标记（已处理过），不是错误。 */
interface PromotionActionResult {
  id: string
  action: 'approve' | 'dismiss'
  changed: boolean
  reason?: string
  record: Record<string, unknown>
}

async function request<T = unknown>(api: ApiFixture, path: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(new URL(path, api.server.url), init)
  const text = await response.text()
  return {
    status: response.status,
    // 端点只回 JSON；静态页面用 rawFetch
    body: (text === '' ? undefined : JSON.parse(text)) as T,
    headers: response.headers,
  }
}

function putJson(api: ApiFixture, path: string, body: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
  return request(api, path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** 落盘文件的 frontmatter：提升/驳回要验的是写进文件的结果，不只是接口返回的视图。 */
async function frontmatterAt(path: string): Promise<Record<string, unknown>> {
  return splitFrontmatter(await readFile(path, 'utf8')).data
}

describe('REST 管理面（Task 5）', () => {
  it('GET /api/records 按 scope 列出可见集合，q 复用 core 检索并返回完整记录视图', async () => {
    const visible = seedRecord({
      id: 'mem_rest_visible', name: '包管理用 pnpm', scope: 'workspace', workspacePath: process.cwd(),
      content: '这个仓库的包管理一律用 pnpm', summary: '包管理选型',
    })
    const global = seedRecord({ id: 'mem_rest_global', name: '全局偏好', content: '全局正文' })
    const other = seedRecord({
      id: 'mem_rest_other', name: '别的项目', scope: 'workspace', workspacePath: '/projects/other', content: '别的正文',
    })
    const api = await startApi({ records: [visible, global, other] })

    // scope 缺省 = 可见集合（global + 当前项目），别的项目不在内
    const all = await request<RecordPage<{ id: string }>>(api, '/api/records')
    expect(all.status).toBe(200)
    expect(all.body.records.map(record => record.id).sort()).toEqual([global.id, visible.id].sort())
    // 分页信封的缺省值：limit 100、offset 0、没有下一页
    expect(all.body).toMatchObject({ limit: 100, offset: 0, hasMore: false })

    const scoped = await request<RecordPage<{ id: string; workspacePath?: string }>>(api, `/api/records?scope=${encodeURIComponent('/projects/other')}`)
    expect(scoped.body.records.map(record => record.id)).toEqual([other.id])
    expect(scoped.body.records[0]!.workspacePath).toBe('/projects/other')

    const searched = await request<RecordPage>(api, '/api/records?q=pnpm')
    expect(searched.body.records.map(record => record.id)).toEqual([visible.id])
    // 列表与单条同形：带 title/text/path/scope，编辑不需要再猜字段
    expect(searched.body.records[0]).toMatchObject({
      id: visible.id, title: '包管理用 pnpm', text: expect.stringContaining('pnpm'),
      scope: 'workspace', workspacePath: process.cwd(), status: 'active',
    })
    expect(String(searched.body.records[0]!.path)).toContain(api.root)
  })

  it('GET /api/records 支持 limit/offset 翻页：不重不漏、带 hasMore，越过末页回空页', async () => {
    const base = Date.now()
    // 各条 lastConfirmedAt 不同：检索排序在同一份磁盘内容上稳定，翻页才谈得上「后面的记录」
    const records = Array.from({ length: 7 }, (_, index) => seedRecord({
      id: `mem_page_${index}`, name: `分页条目 ${index}`, content: `分页正文 ${index}`,
      lastConfirmedAt: base + index,
    }))
    const api = await startApi({ records })

    const first = await request<RecordPage<{ id: string }>>(api, '/api/records?limit=3')
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ limit: 3, offset: 0, hasMore: true })
    // 新近确认的在前：第 7、6、5 条
    expect(first.body.records.map(record => record.id)).toEqual(['mem_page_6', 'mem_page_5', 'mem_page_4'])

    const collected = first.body.records.map(record => record.id)
    let offset = 3
    let hasMore = first.body.hasMore
    while (hasMore) {
      const page = await request<RecordPage<{ id: string }>>(api, `/api/records?limit=3&offset=${offset}`)
      expect(page.status).toBe(200)
      expect(page.body).toMatchObject({ limit: 3, offset })
      collected.push(...page.body.records.map(record => record.id))
      hasMore = page.body.hasMore
      offset += 3
    }
    // 100 条的缺省上限不再是硬截断：翻页能取到全部记录，且不重不漏
    expect(collected).toEqual([...records].reverse().map(record => record.id))

    const beyond = await request<RecordPage>(api, '/api/records?limit=3&offset=30')
    expect(beyond.status).toBe(200)
    expect(beyond.body.records).toEqual([])
    expect(beyond.body.hasMore).toBe(false)

    // 非法分页参数明确 400，不静默按缺省值处理
    for (const path of ['/api/records?limit=0', '/api/records?limit=abc', '/api/records?limit=101', '/api/records?offset=-1']) {
      expect((await request(api, path)).status).toBe(400)
    }
  })

  it('GET /api/records/:id 返回完整记录，未知 id 回 404 JSON', async () => {
    const seeded = seedRecord({ id: 'mem_rest_detail', name: '详情条目', content: '详情正文' })
    const api = await startApi({ records: [seeded] })

    const detail = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)
    expect(detail.status).toBe(200)
    expect(detail.headers.get('content-type')).toContain('application/json')
    expect(detail.body).toMatchObject({
      id: seeded.id, title: '详情条目', text: '详情正文', status: 'active',
      source: seeded.source, confidence: 0.9,
    })
    expect(String(detail.body.path)).toContain(api.root)

    const missing = await request<{ error: string }>(api, '/api/records/mem_missing')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBeTruthy()
  })

  it('PUT /api/records/:id 整条替换：更新可编辑字段、保留 id 与来源标识，并回可读的新视图', async () => {
    const seeded = seedRecord({ id: 'mem_rest_put', name: '旧标题', content: '旧正文' })
    const api = await startApi({ records: [seeded] })
    const before = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)

    const updated = await putJson(api, `/api/records/${seeded.id}`, {
      title: '新标题',
      text: '新正文',
      type: 'preference',
      tags: ['edited'],
      summary: '新摘要',
      updatedAt: before.body.updatedAt,
      // 请求体里伪造的不可编辑字段一律以磁盘现状为准
      source: { sessionId: 'spoof', eventRange: [0, 0], sourceMode: 'agent-inferred' },
      status: 'deleted',
      id: seeded.id,
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({
      id: seeded.id, title: '新标题', text: '新正文', type: 'preference', tags: ['edited'],
      summary: '新摘要', status: 'active', source: seeded.source,
    })
    expect((updated.body as { updatedAt: number }).updatedAt).toBeGreaterThan(before.body.updatedAt as number)

    const reread = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)
    expect(reread.body).toMatchObject({ title: '新标题', text: '新正文', source: seeded.source })
  })

  it('PUT 并发过期（锁内 isChanged 命中）回 409 且不写盘', async () => {
    const seeded = seedRecord({ id: 'mem_rest_conflict', name: '冲突前', content: '并发改前' })
    const api = await startApi({ records: [seeded] })
    const before = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)

    // 模拟另一个会话在读到之后写入：直接经 core 改盘，updatedAt 前进
    await api.core.store.update(seeded, current => ({ ...current, content: '并发改后', updatedAt: current.updatedAt + 5000 }))

    const rejected = await putJson(api, `/api/records/${seeded.id}`, {
      title: '我的标题', text: '我的正文', updatedAt: before.body.updatedAt,
    })
    expect(rejected.status).toBe(409)
    expect((rejected.body as { error: string }).error).toBeTruthy()
    const after = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)
    expect(after.body).toMatchObject({ text: '并发改后' })

    // 拿最新版本标记重试即可写入
    const retried = await putJson(api, `/api/records/${seeded.id}`, {
      title: '我的标题', text: '我的正文', updatedAt: after.body.updatedAt,
    })
    expect(retried.status).toBe(200)
    expect((retried.body as { text: string }).text).toBe('我的正文')
  })

  it('DELETE 软删进 .archive/，restore 后 id 与正文逐字不漂移（Review Focus #3 钉子）', async () => {
    const seeded = seedRecord({ id: 'mem_rest_restore', name: '要恢复的条目', content: '逐字一致的正文\n第二行' })
    const api = await startApi({ records: [seeded] })
    const before = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)
    expect(before.body.status).toBe('active')

    const deleted = await request<{ ok: boolean; id: string }>(api, `/api/records/${seeded.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ ok: true, id: seeded.id })

    const archived = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)
    expect(archived.status).toBe(200)
    expect(archived.body.status).toBe('deleted')
    expect(String(archived.body.path)).toContain('.archive')
    const listed = await request<RecordPage<{ id: string }>>(api, '/api/records')
    expect(listed.body.records.map(record => record.id)).not.toContain(seeded.id)

    const restored = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}/restore`, { method: 'POST' })
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ id: before.body.id, title: before.body.title, text: before.body.text, status: 'active' })
    expect(restored.body.id).toBe(before.body.id)
    expect(restored.body.text).toBe(before.body.text)
    expect(String(restored.body.path)).not.toContain('.archive')

    const reread = await request<Record<string, unknown>>(api, `/api/records/${seeded.id}`)
    expect(reread.body.id).toBe(before.body.id)
    expect(reread.body.text).toBe(before.body.text)
  })

  it('GET /api/records?status=deleted 列出已软删记录：默认列表不含、恢复后消失', async () => {
    const doomed = seedRecord({
      id: 'mem_archive_list', name: '要归档的条目', content: '归档正文', summary: '归档',
      scope: 'workspace', workspacePath: process.cwd(),
    })
    const live = seedRecord({ id: 'mem_archive_live', name: '在用条目', content: '在用正文' })
    const api = await startApi({ records: [doomed, live] })

    const empty = await request<RecordPage<{ id: string }>>(api, '/api/records?status=deleted')
    expect(empty.status).toBe(200)
    expect(empty.body.records).toEqual([])

    expect((await request(api, `/api/records/${doomed.id}`, { method: 'DELETE' })).status).toBe(200)

    const archived = await request<RecordPage<{ id: string; status: string; text: string; path: string }>>(api, '/api/records?status=deleted')
    expect(archived.body.records.map(record => record.id)).toEqual([doomed.id])
    expect(archived.body.records[0]).toMatchObject({ id: doomed.id, status: 'deleted', text: '归档正文', title: '要归档的条目' })
    expect(archived.body.records[0]!.path).toContain('.archive')

    // 默认（active）列表不含归档记录
    const active = await request<RecordPage<{ id: string }>>(api, '/api/records')
    expect(active.body.records.map(record => record.id)).toEqual([live.id])

    // scope 收窄到别的项目：看不到这个项目的归档
    const elsewhere = await request<RecordPage>(api, `/api/records?status=deleted&scope=${encodeURIComponent('/projects/elsewhere')}`)
    expect(elsewhere.body.records).toEqual([])

    // q 走 core 的 queryScope 过滤（不是另写一套打分）
    const filtered = await request<RecordPage<{ id: string }>>(api, '/api/records?status=deleted&q=归档')
    expect(filtered.body.records.map(record => record.id)).toEqual([doomed.id])

    // 未知 status 值明确 400，不静默当成 active
    expect((await request(api, '/api/records?status=bogus')).status).toBe(400)

    // 恢复后从归档列表消失、回到 active 列表
    expect((await request(api, `/api/records/${doomed.id}/restore`, { method: 'POST' })).status).toBe(200)
    expect((await request<RecordPage>(api, '/api/records?status=deleted')).body.records).toEqual([])
    expect((await request<RecordPage<{ id: string }>>(api, '/api/records')).body.records.map(record => record.id).sort())
      .toEqual([doomed.id, live.id].sort())
  })

  it('DELETE 与 restore 的未知 id 回 404，缺 updatedAt 的 PUT 回 400', async () => {
    const api = await startApi({ records: [seedRecord({ id: 'mem_rest_missing_ops' })] })
    expect((await request(api, '/api/records/mem_none', { method: 'DELETE' })).status).toBe(404)
    expect((await request(api, '/api/records/mem_none/restore', { method: 'POST' })).status).toBe(404)
    const missingMarker = await putJson(api, '/api/records/mem_rest_missing_ops', { title: 't', text: 'x' })
    expect(missingMarker.status).toBe(400)
  })

  it('GET /api/health 复用 memory_health 的扣分口径（malformed 每条 10 分）', async () => {
    const api = await startApi({ records: [seedRecord({ id: 'mem_rest_health' })] })
    expect((await request<{ score: number; issueCount: number }>(api, '/api/health')).body)
      .toEqual({ score: 100, issueCount: 0, topIssues: [] })

    // 一个 frontmatter 坏文件进隔离区：与 Task 3 的 memory_health 同一口径（10 分/条）
    await mkdir(join(api.root, GLOBAL_DIR), { recursive: true })
    await writeFile(join(api.root, GLOBAL_DIR, 'broken.md'), '---\nname: [未闭合\n---\n\n正文\n', 'utf8')

    const health = await request<{ score: number; issueCount: number; topIssues: string[] }>(api, '/api/health')
    expect(health.status).toBe(200)
    expect(health.body.score).toBe(90)
    expect(health.body.issueCount).toBe(1)
    expect(health.body.topIssues[0]).toContain('解析失败')
    // 与工具实现逐字相同：REST 没有另写一份口径
    expect(health.body).toEqual(await api.tools.health())
  })

  it('GET /api/promotions 只返回 needs-promote-review 的在用记录', async () => {
    const flaggedGlobal = seedRecord({ id: 'mem_promote_global', name: '待提升全局', 'needs-promote-review': true })
    const flaggedWorkspace = seedRecord({
      id: 'mem_promote_ws', scope: 'workspace', workspacePath: process.cwd(), name: '待提升项目', 'needs-promote-review': true,
    })
    const plain = seedRecord({ id: 'mem_promote_plain', name: '普通记忆' })
    const api = await startApi({ records: [flaggedGlobal, flaggedWorkspace, plain] })

    const promotions = await request<Array<Record<string, unknown>>>(api, '/api/promotions')
    expect(promotions.status).toBe(200)
    expect(promotions.body.map(record => record.id).sort()).toEqual([flaggedGlobal.id, flaggedWorkspace.id].sort())
    for (const record of promotions.body) {
      expect(record['needs-promote-review']).toBe(true)
      expect(record.text).toBeTruthy()
      expect(String(record.path)).toContain(api.root)
    }
  })

  it('POST /api/promotions/:id/approve 把待提升记录变成正式全局记忆（幂等）', async () => {
    const flagged = seedRecord({
      id: 'mem_promote_approve', name: '待提升的条目', content: '提升正文',
      scope: 'workspace', workspacePath: process.cwd(), 'needs-promote-review': true,
    })
    const untouched = seedRecord({
      id: 'mem_promote_stay', name: '保持待审', scope: 'workspace', workspacePath: process.cwd(), 'needs-promote-review': true,
    })
    const api = await startApi({ records: [flagged, untouched] })

    const approved = await request<PromotionActionResult>(api, `/api/promotions/${flagged.id}/approve`, { method: 'POST' })
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({ id: flagged.id, action: 'approve', changed: true })
    // 作用域搬到 global、提升标记没了、正文与标题不漂移
    expect(approved.body.record).toMatchObject({ id: flagged.id, scope: 'global', status: 'active', title: '待提升的条目', text: '提升正文' })
    expect(approved.body.record.workspacePath).toBeUndefined()
    expect(approved.body.record[PROMOTE_REVIEW_KEY]).toBeUndefined()
    // 真的落在 global 目录，写进文件的 frontmatter 也不再带提升标记（作用域由目录表达，frontmatter 不写 scope）
    const promotedPath = String(approved.body.record.path)
    expect(promotedPath).toContain(`${join(api.root, GLOBAL_DIR)}${sep}`)
    expect(await frontmatterAt(promotedPath)).toMatchObject({ id: flagged.id, name: '待提升的条目', status: 'active' })
    expect((await frontmatterAt(promotedPath))[PROMOTE_REVIEW_KEY]).toBeUndefined()
    // 同一 id 只剩全局这一份副本，项目里不再有副本
    expect(await api.core.store.copiesOf(flagged.id)).toEqual([{ kind: 'global' }])

    // 队列里只剩没处理的那条
    const queue = await request<Array<{ id: string }>>(api, '/api/promotions')
    expect(queue.body.map(record => record.id)).toEqual([untouched.id])

    // 幂等：再 approve 一次回 200「无需处理」，不是 500，也不把记录搅坏
    const again = await request<PromotionActionResult>(api, `/api/promotions/${flagged.id}/approve`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ id: flagged.id, action: 'approve', changed: false })
    expect(again.body.reason).toBeTruthy()
    expect(again.body.record).toMatchObject({ id: flagged.id, scope: 'global', text: '提升正文' })
  })

  it('POST /api/promotions/:id/dismiss 只去掉标记、记录留在原作用域（幂等）', async () => {
    const flagged = seedRecord({
      id: 'mem_promote_dismiss', name: '留在项目', content: '项目正文',
      scope: 'workspace', workspacePath: process.cwd(), 'needs-promote-review': true,
    })
    const api = await startApi({ records: [flagged] })

    const dismissed = await request<PromotionActionResult>(api, `/api/promotions/${flagged.id}/dismiss`, { method: 'POST' })
    expect(dismissed.status).toBe(200)
    expect(dismissed.body).toMatchObject({ id: flagged.id, action: 'dismiss', changed: true })
    // 作用域不变、正文不变、标记没了
    expect(dismissed.body.record).toMatchObject({
      id: flagged.id, scope: 'workspace', workspacePath: process.cwd(), status: 'active', text: '项目正文',
    })
    expect(dismissed.body.record[PROMOTE_REVIEW_KEY]).toBeUndefined()
    // 没有搬家、没有进 .archive/：还在项目目录顶层
    const keptPath = String(dismissed.body.record.path)
    expect(keptPath).toContain(api.root)
    expect(keptPath).not.toContain('.archive')
    expect((await frontmatterAt(keptPath))[PROMOTE_REVIEW_KEY]).toBeUndefined()
    // 队列空
    expect((await request<Array<unknown>>(api, '/api/promotions')).body).toEqual([])

    const again = await request<PromotionActionResult>(api, `/api/promotions/${flagged.id}/dismiss`, { method: 'POST' })
    expect(again.status).toBe(200)
    expect(again.body.changed).toBe(false)
    expect(again.body.record).toMatchObject({ id: flagged.id, scope: 'workspace' })
  })

  it('提升处理动作只收 POST：未知 id 404、GET 405、已软删记录 409', async () => {
    const flagged = seedRecord({ id: 'mem_promote_errors', name: '错误路径', 'needs-promote-review': true })
    const api = await startApi({ records: [flagged] })

    expect((await request(api, '/api/promotions/mem_none/approve', { method: 'POST' })).status).toBe(404)
    expect((await request(api, '/api/promotions/mem_none/dismiss', { method: 'POST' })).status).toBe(404)

    const wrongMethod = await request<{ error: string }>(api, `/api/promotions/${flagged.id}/approve`)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toContain('POST')

    // 已软删的候选不能处理（先恢复再说），回明确的 409 而不是 500
    expect((await request(api, `/api/records/${flagged.id}`, { method: 'DELETE' })).status).toBe(200)
    const deleted = await request<{ error: string }>(api, `/api/promotions/${flagged.id}/approve`, { method: 'POST' })
    expect(deleted.status).toBe(409)
    expect(deleted.body.error).toBeTruthy()
  })

  it('只绑 127.0.0.1：监听地址不是 0.0.0.0 或通配地址', async () => {
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
    const api = await startApi()
    const address = api.server.server.address()
    expect(address).not.toBeNull()
    expect(typeof address === 'string' ? address : address!.address).toBe('127.0.0.1')
    expect(address).not.toMatchObject({ address: '0.0.0.0' })
  })

  it('token 启用后 /api 与 /mcp 要求 Authorization: Bearer；缺省关闭鉴权', async () => {
    const api = await startApi({ records: [seedRecord({ id: 'mem_rest_token' })], token: 's3cret' })
    expect((await request(api, '/api/health')).status).toBe(401)
    expect((await request(api, '/api/health', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await request(api, '/api/health', { headers: { authorization: 'Basic s3cret' } })).status).toBe(401)
    const ok = await request<{ score: number }>(api, '/api/health', { headers: { authorization: 'Bearer s3cret' } })
    expect(ok.status).toBe(200)
    expect(ok.body.score).toBe(100)

    // MCP 端点同一套鉴权
    expect((await request(api, '/mcp', { method: 'POST' })).status).toBe(401)
    expect((await request(api, '/mcp', { method: 'POST', headers: { authorization: 'Bearer s3cret' } })).status).not.toBe(401)

    // 缺省没有 token：不带头也能访问
    const open = await startApi()
    expect((await request(open, '/api/health')).status).toBe(200)
  })

  it('token 启用时静态产物放行、数据面仍 401（浏览器导航带不了 Authorization 头）', async () => {
    const webuiDir = await mkdtemp(join(tmpdir(), 'pm-mcp-webui-token-'))
    await mkdir(join(webuiDir, 'assets'), { recursive: true })
    await writeFile(join(webuiDir, 'index.html'), '<!doctype html><title>plastic-token</title>', 'utf8')
    await writeFile(join(webuiDir, 'assets', 'app.js'), 'console.log("token")', 'utf8')
    try {
      const api = await startApi({ webuiDir, token: 's3cret' })

      // 静态文件不带 token 也放行：浏览器导航和 <script> 加不了请求头
      const index = await fetch(new URL('/', api.server.url))
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('plastic-token')
      const asset = await fetch(new URL('/assets/app.js', api.server.url))
      expect(asset.status).toBe(200)
      expect(await asset.text()).toContain('console.log')

      // 同一个实例的数据面照旧校验：无 token 401，带对 token 200
      expect((await request(api, '/api/health')).status).toBe(401)
      expect((await request(api, '/api/records')).status).toBe(401)
      const health = await request<{ score: number }>(api, '/api/health', { headers: { authorization: 'Bearer s3cret' } })
      expect(health.status).toBe(200)
      expect(health.body.score).toBe(100)
    } finally {
      await rm(webuiDir, { recursive: true, force: true })
    }
  })

  it('/mcp 用 Streamable HTTP 暴露同一组五工具，写入经同一份 core 落盘', async () => {
    const api = await startApi()
    const client = new Client({ name: 'rest-spec-http', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', api.server.url))
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map(tool => tool.name).sort()).toEqual([
        'memory_forget', 'memory_health', 'memory_read', 'memory_save', 'memory_search',
      ])
      const saved = await callJson<{ id: string }>(client, 'memory_save', {
        title: '经 HTTP MCP 保存', text: 'http-mcp-marker 正文', origin: 'user-stated',
      })
      const detail = await request<Record<string, unknown>>(api, `/api/records/${saved.id}`)
      expect(detail.status).toBe(200)
      expect(detail.body).toMatchObject({ title: '经 HTTP MCP 保存', source: { sessionId: 'mcp:rest-spec' } })
    } finally {
      await client.close()
    }
  })

  it('静态托管指向 packages/webui/dist：有产物时挂载并回 SPA 入口，目录不存在时其余端点照常', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pm-mcp-webui-'))
    const webuiDir = join(base, 'dist')
    await mkdir(join(webuiDir, 'assets'), { recursive: true })
    await writeFile(join(webuiDir, 'index.html'), '<!doctype html><title>plastic</title>', 'utf8')
    await writeFile(join(webuiDir, 'assets', 'app.js'), 'console.log("plastic")', 'utf8')
    // 穿越目标必须是产物目录之外真实存在的文件：守卫失效时会读到它，这条用例才有区分力
    const sentinel = 'pm-mcp-traversal-sentinel-4a1c'
    await writeFile(join(base, 'secret.txt'), sentinel, 'utf8')
    try {
      const api = await startApi({ webuiDir })
      const index = await fetch(new URL('/', api.server.url))
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      expect(await index.text()).toContain('plastic')

      const asset = await fetch(new URL('/assets/app.js', api.server.url))
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('javascript')
      expect(await asset.text()).toContain('console.log')

      // 无扩展名的前端路由回 index.html；带扩展名的缺失文件是真 404
      const spa = await fetch(new URL('/memory/123', api.server.url))
      expect(await spa.text()).toContain('<!doctype html>')
      expect((await fetch(new URL('/missing.js', api.server.url))).status).toBe(404)
      // 编码过的 ../ 穿越：解码后落到产物目录之外的 secret.txt（存在且内容可辨认），
      // 守卫一删就会把哨兵内容吐出来——不是靠「目标本来就不存在」蒙过去的 404
      const escaped = await fetch(new URL('/%2e%2e%2fsecret.txt', api.server.url))
      expect(escaped.status).toBe(404)
      expect(await escaped.text()).not.toContain(sentinel)
    } finally {
      await rm(base, { recursive: true, force: true })
    }

    // 目录不存在时启动不报错、不挂静态，API 照常
    const missingDir = join(tmpdir(), `pm-mcp-no-webui-${Date.now()}`)
    const api = await startApi({ webuiDir: missingDir })
    expect((await fetch(new URL('/', api.server.url))).status).toBe(404)
    expect((await request(api, '/api/health')).status).toBe(200)
  })

  it('serve 参数解析：缺省 7788、可换端口与 token，非法值直接报错', () => {
    expect(parseServeArgs([])).toEqual({ port: DEFAULT_PORT })
    expect(DEFAULT_PORT).toBe(7788)
    expect(parseServeArgs(['--port', '0', '--token', 't'])).toEqual({ port: 0, token: 't' })
    expect(parseServeArgs(['--port', '9001'])).toEqual({ port: 9001 })
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow()
    expect(() => parseServeArgs(['--port', '70000'])).toThrow()
    expect(() => parseServeArgs(['--token'])).toThrow()
    expect(() => parseServeArgs(['--bogus'])).toThrow()
    expect(DEFAULT_WEBUI_DIR.endsWith(join('packages', 'webui', 'dist'))).toBe(true)
  })

  it('bin 的 serve 子命令按 PLASTIC_* 起 HTTP 模式，日志只走 stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-serve-bin-'))
    const child = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--token', 'cli-secret'], {
      cwd: PACKAGE_ROOT,
      env: { ...baseEnv, PLASTIC_MEMORY_ROOT: root, PLASTIC_CLIENT: 'zcode' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    const exit = new Promise<number | null>(resolvePromise => child.once('exit', code => resolvePromise(code)))
    try {
      const port = await new Promise<number>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve 启动超时：${stderr}`)), 10_000)
        child.stderr!.setEncoding('utf8')
        child.stderr!.on('data', (chunk: string) => {
          stderr += chunk
          const matched = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)
          if (matched !== null) {
            clearTimeout(timer)
            resolvePromise(Number(matched[1]))
          }
        })
        child.once('exit', code => {
          clearTimeout(timer)
          reject(new Error(`serve 提前退出（code=${String(code)}）：${stderr}`))
        })
      })
      const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: 'Bearer cli-secret' } })
      expect(health.status).toBe(200)
      expect((await health.json() as { score: number }).score).toBe(100)
      child.kill('SIGTERM')
      expect(await exit).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toContain('127.0.0.1')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
