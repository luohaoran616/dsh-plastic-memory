import { isAbsolute } from 'node:path'

/**
 * SessionStart 的快照 hook（spec D5）：stdin 收宿主给的 JSON（`cwd`、`session_id`、`hook_event_name`），
 * 项目取输入里的 `cwd`（缺失回退 PLASTIC_PROJECT），GET `http://127.0.0.1:<port>/api/gui/snapshot?project=…`，
 * `text` 非空时向 stdout 输出一段合法 JSON：`{ "hookEventName": "SessionStart", "additionalContext": <快照原文> }`。
 * 服务不可达、超时（缺省 3 秒）、返回为空、输入读不出：什么都不输出、退出码 0，不挡用户的会话。
 * 只请求本机回环；端口取 PLASTIC_WEB_PORT（缺省 7788，与 serve 的缺省同一值）。
 * 这个模块不依赖上下文平面（hook 只走 HTTP），stdio 模式也不为它背根包构建产物的依赖。
 */

export interface HookSnapshotInput {
  /** 会话的工作目录（ZCode hook 输入带 `cwd`）：快照按它解析项目。 */
  cwd?: string
  session_id?: string
  hook_event_name?: string
}

export interface HookSnapshotOutput {
  hookEventName: 'SessionStart'
  additionalContext: string
}

export interface HookSnapshotOptions {
  /** 缺省 PLASTIC_WEB_PORT，再缺省 7788。 */
  port?: number
  /** cwd 缺失时的回退项目（PLASTIC_PROJECT）。 */
  project?: string
  /** 缺省 3000 毫秒。 */
  timeoutMs?: number
  /** 缺省 globalThis.fetch；测试注入假实现。 */
  fetchImpl?: typeof fetch
}

/** hook 输出的固定事件名：这条 hook 只挂在 SessionStart 上（不设 matcher，四种来源都命中）。 */
export const HOOK_EVENT_NAME = 'SessionStart' as const

/** PLASTIC_WEB_PORT 没配时的端口（与 serve.ts 的 DEFAULT_PORT 同值；不直接 import，免得 hook 模式背上 HTTP 服务的依赖）。 */
export const HOOK_DEFAULT_PORT = 7788

/** stdin 读入上限：宿主的 hook 输入是个小 JSON，超过这个量级不是它发的。 */
export const HOOK_INPUT_MAX_BYTES = 1024 * 1024

/** stdin 的 JSON 收成输入对象；读不出、不是对象、数组都按空输入（没有 cwd 就走回退，最后静默退出）。 */
export function parseHookInput(text: string): HookSnapshotInput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.session_id === 'string' ? { session_id: record.session_id } : {}),
    ...(typeof record.hook_event_name === 'string' ? { hook_event_name: record.hook_event_name } : {}),
  }
}

/**
 * 跑一次快照带入。返回 undefined 表示什么都不输出（服务不通、超时、空文本、没有项目可问）。
 * 快照文本按响应体原样带回：服务端已做过项目校验（不存在或非绝对路径回 400，按无输出处理）。
 */
export async function hookSnapshot(input: HookSnapshotInput, options: HookSnapshotOptions = {}): Promise<HookSnapshotOutput | undefined> {
  // 项目：hook 输入的 cwd 优先（会话目录），缺失回退 PLASTIC_PROJECT；都没有就没有可问的项目
  const project = input.cwd?.trim() || options.project?.trim() || ''
  if (project === '' || !isAbsolute(project)) return undefined
  const port = options.port ?? HOOK_DEFAULT_PORT
  const url = `http://127.0.0.1:${port}/api/gui/snapshot?project=${encodeURIComponent(project)}`
  let text: unknown
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch.bind(globalThis))(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    text = (typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined)
  } catch {
    return undefined
  }
  if (typeof text !== 'string' || text === '') return undefined
  return { hookEventName: HOOK_EVENT_NAME, additionalContext: text }
}

/** 环境变量的缺省组装：PLASTIC_WEB_PORT、PLASTIC_PROJECT。 */
export function hookOptionsFromEnv(env: NodeJS.ProcessEnv): HookSnapshotOptions {
  const portRaw = env.PLASTIC_WEB_PORT?.trim() ?? ''
  const port = portRaw === '' ? undefined : Number(portRaw)
  return {
    ...(port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
    ...(env.PLASTIC_PROJECT?.trim() ? { project: env.PLASTIC_PROJECT.trim() } : {}),
  }
}

/** hook 子命令的入口：读 stdin（超长截断）、问服务、有结果才写 stdout。任何失败都静默、退出码 0。 */
export async function runHookCli(options: HookSnapshotOptions = {}): Promise<void> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > HOOK_INPUT_MAX_BYTES) break
    chunks.push(buffer)
  }
  const output = await hookSnapshot(parseHookInput(Buffer.concat(chunks).toString('utf8')), options)
  if (output !== undefined) process.stdout.write(`${JSON.stringify(output)}\n`)
}
