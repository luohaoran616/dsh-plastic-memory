/**
 * 页面侧 HTTP 网关的对外行为：注入假 fetch，按方法与路径分发、按次数回放响应，
 * 断言 hook 给出的状态与它发出的请求（命令体、刷新次数）。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GUI_VIEW_VERSION } from '@plastic/core/gui/contract.ts'
import type { BorrowedSession } from 'dsh-plastic-memory/client/gateway.ts'
import { createHttpGateway, GUI_API } from './gateway.http.ts'

/** 假响应：JSON 体或原文体（视图文件按原文回）。 */
interface FakeResponse {
  status: number
  body?: unknown
  text?: string
}

/** 假 fetch 收到的一次请求。 */
interface FakeCall {
  method: string
  path: string
  url: string
  body: unknown
}

/** 一条路由：固定回放或按请求内容回（命令端点按 line 分）。 */
interface FakeRoute {
  method: string
  path: string
  /** 按次序回放；用完了重复最后一个。 */
  responses?: FakeResponse[]
  /** 按请求内容回。 */
  respond?: (call: FakeCall, index: number) => FakeResponse
}

/** 假 fetch：按方法与路径分发，记下每次请求。 */
function createFakeFetch(routes: FakeRoute[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const counts = new Map<string, number>()
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://fake.local')
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    const call: FakeCall = { method, path, url: String(input), body }
    calls.push(call)
    const route = routes.find(r => r.method === method && r.path === path)
    if (route === undefined) {
      return new Response(JSON.stringify({ error: { code: 'gui/unknown-view', message: `没有这条路由：${method} ${path}` } }), {
        status: 404, headers: { 'content-type': 'application/json' },
      })
    }
    const index = counts.get(path) ?? 0
    counts.set(path, index + 1)
    const chosen = route.respond !== undefined
      ? route.respond(call, index)
      : route.responses![Math.min(index, route.responses!.length - 1)]!
    const payload = chosen.text ?? (chosen.body === undefined ? '' : JSON.stringify(chosen.body))
    return new Response(payload, { status: chosen.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

/** 全部记忆视图（合法形状，够 parseView 认）。 */
const LIBRARY_VIEW = { version: GUI_VIEW_VERSION, memoryRoot: '/mem', layers: [], directoryIssues: [] }

/** 版本号不对的视图：旧插件写的，parseView 说是过时。 */
const OUTDATED_VIEW = { ...LIBRARY_VIEW, version: GUI_VIEW_VERSION - 1 }

/** 命令端点的成功响应：服务端回 `{kind, text}`，text 是命令结果的 JSON 原文。 */
function commandOk(result: unknown): FakeResponse {
  return { status: 200, body: { kind: 'success', text: JSON.stringify(result) } }
}

/** 命令端点的失败响应：命令失败也是 200，回的是错误结果。 */
function commandFail(code: string, detail?: string): FakeResponse {
  return {
    status: 200,
    body: { kind: 'error', text: JSON.stringify({ ok: false, code, ...(detail === undefined ? {} : { detail }) }) },
  }
}

/** 视图端点：回视图文件原文。 */
function viewOk(view: unknown): FakeResponse {
  return { status: 200, text: JSON.stringify(view) }
}

/** 发到命令端点的请求。 */
function commandCalls(calls: FakeCall[]): FakeCall[] {
  return calls.filter(c => c.method === 'POST' && c.path === `${GUI_API}/commands`)
}

/** 读视图端点的请求。 */
function viewCalls(calls: FakeCall[], name: string): FakeCall[] {
  return calls.filter(c => c.method === 'GET' && c.path === `${GUI_API}/views/${name}`)
}

const SESSION: BorrowedSession = { kind: 'ready', sessionId: 'standalone', cwd: undefined }

afterEach(() => {
  vi.useRealTimers()
})

describe('页面侧 HTTP 网关', () => {
  it('首次读视图从读取中到就绪', async () => {
    const fake = createFakeFetch([
      { method: 'GET', path: `${GUI_API}/views/library`, responses: [viewOk(LIBRARY_VIEW)] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => gateway.useView(SESSION, 'library'))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('视图缺失时自动刷新一次再读', async () => {
    const fake = createFakeFetch([
      {
        method: 'GET',
        path: `${GUI_API}/views/library`,
        responses: [
          { status: 404, body: { error: { code: 'gui/view-missing', message: '视图还没生成' } } },
          viewOk(LIBRARY_VIEW),
        ],
      },
      { method: 'POST', path: `${GUI_API}/commands`, responses: [commandOk({ ok: true, cmd: 'refresh-views' })] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => gateway.useView(SESSION, 'library'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(commandCalls(fake.calls)).toHaveLength(1)
    expect(commandCalls(fake.calls)[0]!.body).toEqual({ line: '/memory refresh-views' })
  })

  it('刷新后仍不认识就停在过时', async () => {
    const fake = createFakeFetch([
      { method: 'GET', path: `${GUI_API}/views/library`, responses: [viewOk(OUTDATED_VIEW)] },
      { method: 'POST', path: `${GUI_API}/commands`, responses: [commandOk({ ok: true, cmd: 'refresh-views' })] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => gateway.useView(SESSION, 'library'))
    await waitFor(() => expect(result.current.status).toBe('outdated'))
    expect(commandCalls(fake.calls)).toHaveLength(1)
  })

  it('命令成功后已读视图重读', async () => {
    const fake = createFakeFetch([
      { method: 'GET', path: `${GUI_API}/views/library`, responses: [viewOk(LIBRARY_VIEW)] },
      {
        method: 'POST',
        path: `${GUI_API}/commands`,
        respond: call => {
          const line = (call.body as { line: string }).line
          return line.includes(' info') ? commandOk({ ok: true, cmd: 'info' }) : commandFail('failed', '这条命令失败了')
        },
      },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => gateway.useView(SESSION, 'library'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(viewCalls(fake.calls, 'library')).toHaveLength(1)

    await act(async () => { await gateway.execute('standalone', { cmd: 'info' }) })
    await waitFor(() => expect(viewCalls(fake.calls, 'library')).toHaveLength(2))

    // 失败且错误码不说明界面落后于磁盘：不重读
    await act(async () => { await gateway.execute('standalone', { cmd: 'confirm', memoryId: 'mem_1' }) })
    expect(viewCalls(fake.calls, 'library')).toHaveLength(2)
  })

  it('模型只问一次', async () => {
    const fake = createFakeFetch([
      {
        method: 'POST',
        path: `${GUI_API}/commands`,
        responses: [commandOk({ ok: true, cmd: 'model-info', model: 'glm-5.3' })],
      },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => ({ a: gateway.useModel(SESSION), b: gateway.useModel(SESSION) }))
    await waitFor(() => expect(result.current.a.status).toBe('ready'))
    expect(result.current.a).toEqual({ status: 'ready', model: 'glm-5.3' })
    expect(result.current.b).toEqual({ status: 'ready', model: 'glm-5.3' })
    expect(commandCalls(fake.calls)).toHaveLength(1)
  })

  it('模型拿不到时状态是不可用', async () => {
    const fake = createFakeFetch([
      { method: 'POST', path: `${GUI_API}/commands`, responses: [commandFail('llm-unavailable')] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => gateway.useModel(SESSION))
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
  })

  it('不主动问模型时不发命令', async () => {
    const fake = createFakeFetch([])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    renderHook(() => gateway.useModel(SESSION, { shouldAsk: false }))
    await act(async () => { await Promise.resolve() })
    // 设置表单的初始读不算：这条用例管的是模型探测不发命令
    expect(fake.calls.filter(call => call.path !== '/api/gui/settings')).toHaveLength(0)
  })

  it('挂载时刷新一次', async () => {
    const fake = createFakeFetch([
      { method: 'POST', path: `${GUI_API}/commands`, responses: [commandOk({ ok: true, cmd: 'refresh-views' })] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    renderHook(() => gateway.useFreshViews(SESSION))
    await waitFor(() => expect(commandCalls(fake.calls)).toHaveLength(1))
    expect(commandCalls(fake.calls)[0]!.body).toEqual({ line: '/memory refresh-views' })
  })

  it('回到前台满五秒才再刷新', async () => {
    vi.useFakeTimers()
    const fake = createFakeFetch([
      { method: 'POST', path: `${GUI_API}/commands`, responses: [commandOk({ ok: true, cmd: 'refresh-views' })] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    renderHook(() => gateway.useFreshViews(SESSION))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(commandCalls(fake.calls)).toHaveLength(1)

    // 刚挂载就切回前台：距上次刷新不足五秒，不再发
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(commandCalls(fake.calls)).toHaveLength(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(commandCalls(fake.calls)).toHaveLength(2)
  })

  it('会话恒定就绪', () => {
    const fake = createFakeFetch([])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => ({
      session: gateway.useSession(undefined),
      workspace: gateway.useCurrentWorkspace(),
      config: gateway.useConfig(),
    }))
    expect(result.current.session).toEqual({ kind: 'ready', sessionId: 'standalone', cwd: undefined })
    expect(result.current.workspace).toEqual({ status: 'ready', workspacePath: undefined })
    expect(result.current.config).toBeUndefined()
  })

  it('忘记后删除状态记下', async () => {
    const fake = createFakeFetch([
      { method: 'POST', path: `${GUI_API}/commands`, responses: [commandOk({ ok: true, cmd: 'forget', memoryIds: ['mem_1'] })] },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    const { result } = renderHook(() => ({ deletions: gateway.useDeletions() }))
    await act(async () => { await gateway.execute('standalone', { cmd: 'forget', memoryId: 'mem_1' }) })
    await waitFor(() => expect(result.current.deletions.of('mem_1')).toBe('soft'))
  })

  it('网络失败折成 failed', async () => {
    const gateway = createHttpGateway({
      fetch: (async () => { throw new Error('连不上记忆服务') }) as unknown as typeof fetch,
    })
    const result = await gateway.execute('standalone', { cmd: 'info' })
    expect(result).toMatchObject({ ok: false, code: 'failed' })
  })

  it('读文件', async () => {
    const fake = createFakeFetch([
      {
        method: 'GET',
        path: `${GUI_API}/file`,
        responses: [
          { status: 200, body: { text: 'a' } },
          { status: 404, body: { error: { code: 'gui/file-unavailable', message: '读不到这个文件' } } },
        ],
      },
    ])
    const gateway = createHttpGateway({ fetch: fake.fetch })
    expect(await gateway.readFile('standalone', '/mem/a.md')).toBe('a')
    const fileCall = fake.calls.find(call => call.path === `${GUI_API}/file`)!
    expect(fileCall.url).toContain('path=%2Fmem%2Fa.md')
    expect(await gateway.readFile('standalone', '/mem/b.md')).toBeUndefined()
  })
})
