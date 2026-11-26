import { reportedTokens, type SemanticLlm } from '../governance/semantic-scan.ts'

/** Anthropic Messages 线路的接线参数：地址、模型，以及可选的 key 与超时。 */
export interface AnthropicLlmOptions {
  /** 形如 http://127.0.0.1:3091/api/anthropic；适配器在后面接 /v1/messages。 */
  baseUrl: string
  model: string
  /** 进 x-api-key；不给就不带这个头。 */
  apiKey?: string
  /** 缺省 4096。 */
  maxTokens?: number
  /** 缺省 120_000。 */
  timeoutMs?: number
  fetch?: typeof fetch
}

/** /v1/messages 非流式响应里用得上的部分：正文块、停止原因、用量。 */
interface MessagesResponse {
  content?: { type?: string; text?: string }[]
  stop_reason?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

/** Anthropic 的用量字段换成 SemanticLlm 的口径：输入、输出、缓存读写相加；主计数缺失时不报。 */
function usageTokens(usage: MessagesResponse['usage']): number | undefined {
  if (usage?.input_tokens === undefined || usage.output_tokens === undefined) return undefined
  return reportedTokens({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  })
}

/** 上游错误体里的可读消息：先找常见字段（本地代理用 msg），不是 JSON 就原样带一段。 */
function upstreamDetail(body: string): string {
  let message: unknown
  try {
    const parsed = JSON.parse(body) as { msg?: unknown; message?: unknown; error?: { message?: unknown } }
    message = parsed.msg ?? parsed.message ?? parsed.error?.message
  } catch {
    message = undefined
  }
  if (typeof message === 'string' && message !== '') return message
  return body.trim().slice(0, 500) || '（无响应体）'
}

/**
 * 把 Anthropic Messages（POST {baseUrl}/v1/messages，非流式）接成治理层的模型调用：
 * 只拼 text 块、关掉 thinking；非 2xx 与 max_tokens 截断按失败抛错，取消与超时抛 signal.reason。
 */
export function createAnthropicLlm(options: AnthropicLlmOptions): SemanticLlm {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/messages`
  const maxTokens = options.maxTokens ?? 4096
  const timeoutMs = options.timeoutMs ?? 120_000
  return {
    model: options.model,
    async complete({ system, user }, signal, onUsage) {
      // 起步前先看取消：已取消就不发请求，直接抛（signal.reason 通常是 AbortError）。
      signal?.throwIfAborted()
      // 超时与调用方取消合成一个 signal：本地代理只认 POST /v1/messages，这条请求的生命周期就靠它兜住。
      const timeout = AbortSignal.timeout(timeoutMs)
      const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let usage: MessagesResponse['usage']
      try {
        const send = options.fetch ?? fetch
        let response: Response
        try {
          response = await send(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              ...(options.apiKey === undefined ? {} : { 'x-api-key': options.apiKey }),
            },
            body: JSON.stringify({
              model: options.model,
              max_tokens: maxTokens,
              thinking: { type: 'disabled' },
              system,
              messages: [{ role: 'user', content: user }],
            }),
            signal: requestSignal,
          })
        } catch (err) {
          // 中止时抛 signal.reason：DOMException 的 name 就是 AbortError / TimeoutError，往上按取消处理。
          throw requestSignal.aborted ? (requestSignal.reason ?? err) : err
        }
        if (!response.ok) {
          throw new Error(`模型线路返回 ${response.status}：${upstreamDetail(await response.text())}`)
        }
        const payload = (await response.json()) as MessagesResponse
        usage = payload.usage
        // 截断的输出是半截 JSON，解析必然不过；直接按失败报，别让它当成空结果或走重试。
        if (payload.stop_reason === 'max_tokens') throw new Error('模型输出被 max_tokens 截断：调大 maxTokens 或缩批')
        const text = (payload.content ?? [])
          .flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
          .join('\n')
        if (text === '') throw new Error('模型返回里没有 text 正文块')
        return text
      } finally {
        // 出错收尾前上游报了用量的也计入（SemanticLlm 契约），所以放 finally 里报。
        const tokens = usageTokens(usage)
        if (tokens !== undefined) onUsage?.(tokens)
      }
    },
  }
}
