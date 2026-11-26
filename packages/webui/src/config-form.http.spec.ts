import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpConfigForm, type HttpConfigFormOptions } from './config-form.http.ts'

/**
 * HTTP ConfigForm 的实证：注入假 fetch，断言读到的快照形状、提交的请求体与返回值、
 * 被拒（400/409）后重读并回 false、传输失败抛错、unavailable 的降级。
 */

const READY_BODY = { status: 'ready', revision: 3, value: { template: 'coding', snapshotTokenBudget: 4000 }, writable: true }

function form(fetchMock: ReturnType<typeof vi.fn>, options: Omit<HttpConfigFormOptions, 'fetch'> = {}) {
  return createHttpConfigForm({ fetch: fetchMock as unknown as typeof fetch, ...options })
}

/** 等初始读与后续的微任务收尾。 */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HTTP ConfigForm', () => {
  it('初始读：ready 的快照带值与版本号；unavailable 按不可用显示', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(READY_BODY), { status: 200 }))
    const config = form(f)
    await settle()
    expect(config.getSnapshot()).toEqual({ status: 'ready', revision: 3, value: READY_BODY.value, writable: true })

    const down = form(vi.fn(async () => new Response(JSON.stringify({ status: 'unavailable', reason: 'corrupt', detail: 'x' }), { status: 200 })))
    await settle()
    expect(down.getSnapshot()).toEqual({ status: 'unavailable', value: undefined, revision: undefined, writable: false })
  })

  it('请求失败与非 JSON 响应都按 unavailable，writable 为 false', async () => {
    const config = form(vi.fn(async () => { throw new Error('断网') }))
    await settle()
    expect(config.getSnapshot().status).toBe('unavailable')
    expect(config.getSnapshot().writable).toBe(false)

    const garbage = form(vi.fn(async () => new Response('not json', { status: 200 })))
    await settle()
    expect(garbage.getSnapshot().status).toBe('unavailable')
  })

  it('set 拆点路径提交；mutate 带 expectedRevision；接受后回 true 并发布新值', async () => {
    const updated = { status: 'ready', revision: 4, value: { template: 'office' }, writable: true }
    const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
    // 次序：初始 GET → set 的 POST → 随后的重读 GET → mutate 的 POST → 重读 GET
    const f = vi.fn()
      .mockResolvedValueOnce(ok(READY_BODY))
      .mockResolvedValueOnce(ok(updated))
      .mockResolvedValueOnce(ok(updated))
      .mockResolvedValueOnce(ok(updated))
      .mockResolvedValueOnce(ok(updated))
    const config = form(f)
    await settle()

    await expect(config.set('snapshotTokenBudget', 2500)).resolves.toBe(true)
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ ops: [{ op: 'set', path: ['snapshotTokenBudget'], value: 2500 }] })
    expect(config.getSnapshot()).toEqual({ status: 'ready', revision: 4, value: { template: 'office' }, writable: true })

    await expect(config.mutate([{ op: 'unset', path: ['scenes', 's1'] }], 4)).resolves.toBe(true)
    expect(JSON.parse(f.mock.calls[3]![1]!.body as string)).toEqual({ ops: [{ op: 'unset', path: ['scenes', 's1'] }], expectedRevision: 4 })
  })

  it('被拒（400 内容不合法、409 版本冲突）回 false，且已重读最新值', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(READY_BODY), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'settings/conflict' } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(READY_BODY), { status: 200 }))
    const config = form(f)
    await settle()

    await expect(config.mutate([{ op: 'set', path: ['template'], value: 'office' }], 2)).resolves.toBe(false)
    // 提交之后跟了一次 GET（重读）
    expect(f.mock.calls[2]![0]).toBe('/api/gui/settings')
    expect((f.mock.calls[2]![1] as RequestInit).method).toBeUndefined()
    expect(config.getSnapshot()).toEqual({ status: 'ready', revision: 3, value: READY_BODY.value, writable: true })

    f.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'settings/invalid' } }), { status: 400 }))
    f.mockResolvedValueOnce(new Response(JSON.stringify(READY_BODY), { status: 200 }))
    await expect(config.mutate([], 3)).resolves.toBe(false)
  })

  it('传输失败原样抛（契约：reject 表示传输失败）', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(READY_BODY), { status: 200 }))
      .mockRejectedValueOnce(new Error('断网'))
    const config = form(f)
    await settle()
    await expect(config.mutate([], 3)).rejects.toThrow('断网')
  })

  it('订阅者在发布时收到通知；回到前台重读一次', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(READY_BODY), { status: 200 }))
    const config = form(f)
    await settle()
    const seen: Array<{ revision: number | undefined }> = []
    const stop = config.subscribe(() => { seen.push({ revision: config.getSnapshot().revision }) })

    // 回到前台：重读一次（GET 次数加一），值没变就不发新对象
    const before = f.mock.calls.length
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(f.mock.calls.length).toBe(before + 1)
    stop()
  })
})
