import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRestGateway, type RecordView } from './gateway.impl.ts'

/**
 * gateway 的对外行为：起一个真的 node:http 假服务（固定 JSON、按路径/方法分发），用 gateway 打过去，
 * 断言它交回来的值与错误形状——不 mock fetch 的实现细节，也不数调用了几次。
 * 假服务把收到的请求记下来，用来核对请求形状（查询参数、PUT 请求体），那是 REST 契约的一部分。
 */

interface SeenRequest {
  method: string
  pathname: string
  params: URLSearchParams
  body: unknown
}

interface Fixture {
  baseUrl: string
  seen: SeenRequest[]
  /** 下一次 PUT 的并发标记是否过期：true 时回 409。 */
  staleWrite: boolean
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

function view(partial: Partial<RecordView> = {}): RecordView {
  const stamp = 1_700_000_000_000
  return {
    id: 'mem_1',
    title: '每周三发版',
    text: '发布日是每周三，以这个为准。',
    path: '/memory/global/mem_1.md',
    type: 'project',
    scope: 'global',
    tags: ['release'],
    summary: '发布日是每周三',
    source: { sessionId: 'zcode:abc', eventRange: [0, 2], sourceMode: 'user-explicit' },
    createdAt: stamp,
    updatedAt: stamp,
    lastConfirmedAt: stamp,
    status: 'active',
    confidence: 0.9,
    ...partial,
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}

async function startFixture(): Promise<Fixture> {
  const seen: SeenRequest[] = []
  const fixture: Fixture = { baseUrl: '', seen, staleWrite: false }
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    const body = method === 'PUT' || method === 'POST' ? await readBody(req) : undefined
    seen.push({ method, pathname: url.pathname, params: url.searchParams, body })

    if (method === 'GET' && url.pathname === '/api/records') {
      return sendJson(res, 200, { records: [view()], limit: 20, offset: 40, hasMore: true })
    }
    if (method === 'GET' && url.pathname === '/api/records/mem_1') return sendJson(res, 200, view())
    if (method === 'GET' && url.pathname === '/api/records/mem_gone') return sendJson(res, 404, { error: '找不到记忆：mem_gone' })
    if (method === 'GET' && url.pathname === '/api/records/mem_broken') return sendJson(res, 500, { error: '内部错误' })

    if (method === 'PUT' && url.pathname === '/api/records/mem_1') {
      if (fixture.staleWrite) return sendJson(res, 409, { error: '记录在读取之后被改过，未写入（请重新读取后再提交）' })
      const update = body as { updatedAt: number; title: string; text: string }
      return sendJson(res, 200, view({ title: update.title, text: update.text, updatedAt: update.updatedAt + 1 }))
    }

    if (method === 'DELETE' && url.pathname === '/api/records/mem_1') return sendJson(res, 200, { ok: true, id: 'mem_1' })

    if (method === 'POST' && url.pathname === '/api/records/mem_archived/restore') {
      return sendJson(res, 200, view({ id: 'mem_archived', path: '/memory/global/mem_archived.md' }))
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { score: 82, issueCount: 2, topIssues: ['两条记忆的发布日互相矛盾', '一条记忆的指令文件过期'] })
    }

    if (method === 'GET' && url.pathname === '/api/promotions') {
      return sendJson(res, 200, [view({ id: 'mem_cand', scope: 'workspace', workspacePath: '/repo/a', 'needs-promote-review': true })])
    }

    if (method === 'POST' && url.pathname === '/api/promotions/mem_taken/approve') {
      // 提升撞上全局已有同 id 的副本：没处理成，但不是错误（changed=false, taken=true）
      return sendJson(res, 200, {
        id: 'mem_taken', action: 'approve', changed: false, taken: true,
        reason: '全局已有同一条记忆（也可能在最近删除里），提升会盖掉它，已原样留在项目内',
        record: view({ id: 'mem_taken', scope: 'workspace', workspacePath: '/repo/a' }),
      })
    }
    if (method === 'POST' && url.pathname === '/api/promotions/mem_cand/dismiss') {
      return sendJson(res, 200, { id: 'mem_cand', action: 'dismiss', changed: true, record: view({ id: 'mem_cand', scope: 'workspace', workspacePath: '/repo/a' }) })
    }

    sendJson(res, 404, { error: '假服务没有这条路由' })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanups.push(async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) })
  const { port } = server.address() as AddressInfo
  fixture.baseUrl = `http://127.0.0.1:${port}`
  return fixture
}

let server: Fixture

beforeEach(async () => {
  server = await startFixture()
})

describe('listRecords', () => {
  it('带上 scope/q/limit/offset/status，并把分页信封原样解出来', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.listRecords({ scope: 'global', q: '发版', limit: 20, offset: 40, status: 'deleted' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ records: [view()], limit: 20, offset: 40, hasMore: true })

    const [request] = server.seen
    expect(request?.pathname).toBe('/api/records')
    expect(request?.params.get('scope')).toBe('global')
    expect(request?.params.get('q')).toBe('发版')
    expect(request?.params.get('limit')).toBe('20')
    expect(request?.params.get('offset')).toBe('40')
    expect(request?.params.has('status')).toBe(true)
  })

  it('缺省查询不写 scope/status：服务端按可见集合与在用记录取', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    await gateway.listRecords()
    const [request] = server.seen
    expect(request?.pathname).toBe('/api/records')
    expect(request?.params.toString()).toBe('')
  })
})

describe('读单条与溯源', () => {
  it('getRecord 交回带 frontmatter 与正文的完整视图', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.getRecord('mem_1')
    expect(result).toMatchObject({ ok: true, value: { id: 'mem_1', title: '每周三发版', type: 'project', path: '/memory/global/mem_1.md' } })
  })

  it('404 映射成 not-found，并保留服务端的说明', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.getRecord('mem_gone')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('not-found')
    expect(result.error.status).toBe(404)
    expect(result.error.detail).toBe('找不到记忆：mem_gone')
  })

  it('500 映射成 http 错误，不当成成功', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.getRecord('mem_broken')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('http')
    expect(result.error.status).toBe(500)
  })
})

describe('编辑', () => {
  it('PUT 带上并发标记与整条内容，成功交回新版本', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.updateRecord('mem_1', {
      updatedAt: 1_700_000_000_000, title: '每周四发版', text: '发布日改成每周四。', type: 'project', tags: ['release'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.title).toBe('每周四发版')
    expect(result.value.text).toBe('发布日改成每周四。')
    expect(server.seen[0]?.body).toEqual({
      updatedAt: 1_700_000_000_000, title: '每周四发版', text: '发布日改成每周四。', type: 'project', tags: ['release'],
    })
  })

  it('409 映射成冲突提示（不是静默失败，也不是成功）', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    server.staleWrite = true
    const result = await gateway.updateRecord('mem_1', { updatedAt: 1_699_999_999_999, title: '旧版本', text: '旧正文' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('conflict')
    expect(result.error.status).toBe(409)
    expect(result.error.message).toContain('重新读取')
    expect(result.error.detail).toContain('记录在读取之后被改过')
  })
})

describe('软删与恢复', () => {
  it('DELETE 回 { ok, id }', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.deleteRecord('mem_1')
    expect(result).toEqual({ ok: true, value: { ok: true, id: 'mem_1' } })
    expect(server.seen[0]).toMatchObject({ method: 'DELETE', pathname: '/api/records/mem_1' })
  })

  it('restore 交回恢复后的记录（路径回到作用域目录）', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.restoreRecord('mem_archived')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.id).toBe('mem_archived')
    expect(result.value.path).not.toContain('.archive')
    expect(server.seen[0]).toMatchObject({ method: 'POST', pathname: '/api/records/mem_archived/restore' })
  })
})

describe('体检与提升审核', () => {
  it('health 交回 { score, issueCount, topIssues }', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.health()
    expect(result).toEqual({
      ok: true,
      value: { score: 82, issueCount: 2, topIssues: ['两条记忆的发布日互相矛盾', '一条记忆的指令文件过期'] },
    })
  })

  it('promotions 是裸数组（不是分页信封）', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.listPromotions()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.isArray(result.value)).toBe(true)
    expect(result.value[0]).toMatchObject({ id: 'mem_cand', 'needs-promote-review': true })
  })

  it('approve 撞上全局已有同 id 的副本：changed=false/taken=true 是「没处理成」，不是错误', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.actOnPromotion('mem_taken', 'approve')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ id: 'mem_taken', action: 'approve', changed: false, taken: true })
    expect(result.value.reason).toContain('全局已有同一条记忆')
  })

  it('dismiss 交回处理结果，记录原样留在项目内', async () => {
    const gateway = createRestGateway({ baseUrl: server.baseUrl })
    const result = await gateway.actOnPromotion('mem_cand', 'dismiss')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toMatchObject({ id: 'mem_cand', action: 'dismiss', changed: true })
    expect(result.value.record.scope).toBe('workspace')
  })
})

describe('传输层', () => {
  it('缺省 base URL 是相对路径：浏览器里同源请求 /api/...，不写死主机端口', async () => {
    const urls: string[] = []
    const recordingFetch: typeof fetch = async (input) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ records: [], limit: 100, offset: 0, hasMore: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const gateway = createRestGateway({ fetch: recordingFetch })
    await gateway.listRecords({ q: '发版' })
    expect(urls).toEqual(['/api/records?q=%E5%8F%91%E7%89%88'])
  })

  it('服务连不上时是 network 错误，不是空列表', async () => {
    const gateway = createRestGateway({ baseUrl: 'http://127.0.0.1:1' })
    const result = await gateway.listRecords()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('network')
  })
})
