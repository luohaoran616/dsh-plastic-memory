import { describe, expect, it, vi } from 'vitest'
import { createAnthropicLlm } from '../src/standalone/llm.ts'

// 无宿主装配的模型线路：Anthropic Messages 的 HTTP 形状（本地代理只认 POST /v1/messages），
// 折成治理层的 SemanticLlm。这里把进程边界全换成假的：注入记录调用的 fetch，不起网络。

const BASE_URL = 'http://127.0.0.1:3091/api/anthropic'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** 记录调用的假 fetch：响应由用例给。 */
function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  })
  return { calls, fetch: fake as unknown as typeof fetch }
}

/** 取一次调用抛出的错误；没抛就让用例失败。 */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error('期望这次调用抛错，但它成功了')
}

describe('createAnthropicLlm', () => {
  it('只拼接正文块并带全请求字段', async () => {
    const { calls, fetch } = recordingFetch(() =>
      jsonResponse({
        content: [
          { type: 'thinking', thinking: '先想想' },
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
        stop_reason: 'end_turn',
      }),
    )
    const llm = createAnthropicLlm({ baseUrl: BASE_URL, model: 'claude-sonnet-4-5', fetch })

    await expect(llm.complete({ system: '系统提示', user: '用户输入' })).resolves.toBe('第一段\n第二段')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/messages`)
    expect(calls[0]!.init.method).toBe('POST')
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('x-api-key')).toBeNull()
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      system: '系统提示',
      messages: [{ role: 'user', content: '用户输入' }],
    })
  })

  it('按实际用量回调一次', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({
        content: [{ type: 'text', text: '{}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      }),
    )
    const llm = createAnthropicLlm({ baseUrl: BASE_URL, model: 'claude-sonnet-4-5', fetch })

    const usages: number[] = []
    await llm.complete({ system: '系统提示', user: '用户输入' }, undefined, tokens => usages.push(tokens))

    expect(usages).toEqual([42])
  })

  it('非 2xx 抛出带状态码与上游消息的错误', async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ msg: '令牌已过期' }, 401))
    const llm = createAnthropicLlm({ baseUrl: BASE_URL, model: 'claude-sonnet-4-5', fetch })

    const err = await caught(llm.complete({ system: '系统提示', user: '用户输入' }))

    expect(err.message).toContain('401')
    expect(err.message).toContain('令牌已过期')
  })

  it('输出被 max_tokens 截断时抛错', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ content: [{ type: 'text', text: '半截' }], stop_reason: 'max_tokens' }),
    )
    const llm = createAnthropicLlm({ baseUrl: BASE_URL, model: 'claude-sonnet-4-5', fetch })

    const err = await caught(llm.complete({ system: '系统提示', user: '用户输入' }))

    expect(err.message).toContain('max_tokens')
  })

  it('调用前已取消则不发请求', async () => {
    const { calls, fetch } = recordingFetch(() => jsonResponse({ content: [], stop_reason: 'end_turn' }))
    const llm = createAnthropicLlm({ baseUrl: BASE_URL, model: 'claude-sonnet-4-5', fetch })
    const controller = new AbortController()
    controller.abort()

    const err = await caught(llm.complete({ system: '系统提示', user: '用户输入' }, controller.signal))

    expect(err.name).toBe('AbortError')
    expect(calls).toHaveLength(0)
  })

  it('超时抛错', async () => {
    // 永不返回，但像真 fetch 一样响应 signal：不传 signal 就会一直挂着，由用例超时暴露
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    ) as unknown as typeof globalThis.fetch
    const llm = createAnthropicLlm({ baseUrl: BASE_URL, model: 'claude-sonnet-4-5', timeoutMs: 20, fetch })

    const startedAt = Date.now()
    const err = await caught(llm.complete({ system: '系统提示', user: '用户输入' }))

    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(err.name).toBe('TimeoutError')
  })
})
