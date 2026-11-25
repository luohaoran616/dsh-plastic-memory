import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createMemoryCore } from '@plastic/core/factory.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { createMemoryTools, registerMemoryTools, type MemoryTools } from './tools.ts'
import { API_PREFIX, sendError, sendJson } from './http-util.ts'
import { handleGuiRequest, type GuiPlanePort } from './gui-http.ts'

/**
 * `plastic-mcp serve`：HTTP 模式。同一个 node:http 服务暴露三样（D4）——
 * `/mcp`（Streamable HTTP 的 MCP 端点）、`/api/gui/*`（独立页面接口）、`/`（WebUI 静态产物）。
 * 只绑 127.0.0.1；`--token` 缺省关闭鉴权，启用时 `/api` 与 `/mcp` 校验 `Authorization: Bearer`。
 * 静态产物目录不存在就不挂静态，其余端点照常工作（Task 6 构建前也能起服务）。
 *
 * 零新运行时依赖：HTTP 层只用 node:http、node:fs 与 MCP SDK 自带的传输实现。
 */

const pkg = createRequire(import.meta.url)('../package.json') as { version: string }

/** 唯一允许的监听地址：本机回环，不做 0.0.0.0。 */
export const LOOPBACK_HOST = '127.0.0.1'

/** 独立页面接口的路径前缀（D4：全部挂在 /api 下）。 */
const GUI_PATH = `${API_PREFIX}/gui`

/** D4 的缺省端口。 */
export const DEFAULT_PORT = 7788

/** Task 6 的 WebUI 构建产物；从 src/ 与 lib/ 起算层级相同，都在 packages/webui/dist。 */
export const DEFAULT_WEBUI_DIR = fileURLToPath(new URL('../../webui/dist', import.meta.url))

const SERVE_USAGE = 'plastic-mcp serve [--port 7788] [--token <t>]'

export interface ServeArgs {
  /** 0 表示随机空闲端口（测试与临时实例用）。 */
  port: number
  token?: string
}

/** `serve` 子命令参数：只认 --port 与 --token，非法值直接抛（bin 的 fail 统一收口）。 */
export function parseServeArgs(argv: string[]): ServeArgs {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg !== '--port' && arg !== '--token') throw new Error(`未知参数：${arg}\n用法：${SERVE_USAGE}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 需要值\n用法：${SERVE_USAGE}`)
    values.set(arg, value)
    i += 1
  }
  const portRaw = values.get('--port')
  const port = portRaw === undefined ? DEFAULT_PORT : Number(portRaw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port 必须是 0–65535 的整数：${String(portRaw)}\n用法：${SERVE_USAGE}`)
  }
  const token = values.get('--token')
  if (token !== undefined && token.trim() === '') throw new Error(`--token 不能为空\n用法：${SERVE_USAGE}`)
  return { port, ...(token === undefined ? {} : { token }) }
}

export interface MemoryHttpServerOptions {
  /** MCP 工具面：/mcp 端点用它应答。 */
  tools: MemoryTools
  /** 缺省 DEFAULT_PORT；0 = 随机空闲端口。 */
  port?: number
  /** 启用 Bearer 鉴权（/api/* 与 /mcp）。 */
  token?: string
  /** WebUI 产物目录；缺省 packages/webui/dist。目录不存在就不挂静态托管。 */
  webuiDir?: string
  /** 独立页面的无宿主平面；有它时 /api/gui/* 由 handleGuiRequest 处理，关闭服务时一并释放。 */
  gui?: GuiPlanePort
  log?: MemoryLogger
}

export interface MemoryHttpServer {
  host: string
  port: number
  url: string
  server: Server
  close(): Promise<void>
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** 目录存在才挂静态；不存在（Task 6 还没构建）返回 undefined，启动不报错。 */
function staticRootOf(dir: string): string | undefined {
  try {
    return statSync(dir).isDirectory() ? resolve(dir) : undefined
  } catch {
    return undefined
  }
}

function sendFile(req: IncomingMessage, res: ServerResponse, body: Buffer, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL, root: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, `方法不允许：${req.method ?? ''}`, { allow: 'GET, HEAD' })
    return
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    sendError(res, 400, '路径编码非法')
    return
  }
  if (decoded.includes('\0')) {
    sendError(res, 400, '路径非法')
    return
  }
  const requested = resolve(root, `.${decoded}`)
  // 路径必须落在产物目录内：%2e%2e 这类穿越一律拒绝
  if (requested !== root && !requested.startsWith(root + sep)) {
    sendError(res, 404, 'Not Found')
    return
  }
  const file = await readFile(requested).catch(() => undefined)
  if (file !== undefined) {
    sendFile(req, res, file, contentTypeOf(requested))
    return
  }
  // SPA 前端路由回 index.html；带扩展名的缺失资源是真 404（不能把 HTML 当脚本回）
  if (extname(decoded) !== '') {
    sendError(res, 404, 'Not Found')
    return
  }
  const index = await readFile(join(root, 'index.html')).catch(() => undefined)
  if (index === undefined) {
    sendError(res, 404, 'Not Found')
    return
  }
  sendFile(req, res, index, CONTENT_TYPES['.html']!)
}

const BEARER = /^Bearer\s+(.+)$/i

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string') return false
  return BEARER.exec(header.trim())?.[1] === token
}

/** 鉴权只管数据面：静态产物是构建好的前端文件，浏览器导航带不了 Authorization 头。 */
function requiresAuth(pathname: string): boolean {
  return pathname === '/mcp' || pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, tools: MemoryTools, log?: MemoryLogger): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed：stateless Streamable HTTP 只接受 POST' },
      id: null,
    }, { allow: 'POST' })
    return
  }
  // stateless 模式每个请求必须用新的 transport（SDK 契约：复用会串消息 id），server 跟着请求建、响应后关
  const server = new McpServer({ name: 'plastic-memory', version: pkg.version })
  registerMemoryTools(server, tools)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (error) {
    log?.error('[plastic-memory] MCP 请求失败:', error)
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    } else {
      res.destroy()
    }
  } finally {
    if (res.writableEnded) await server.close().catch(() => {})
    else res.once('close', () => { void server.close().catch(() => {}) })
  }
}

export async function startMemoryServer(options: MemoryHttpServerOptions): Promise<MemoryHttpServer> {
  const { tools, token, gui } = options
  const log = options.log
  const staticRoot = staticRootOf(options.webuiDir ?? DEFAULT_WEBUI_DIR)
  // 鉴权之后才轮到界面接口；来源比对用服务自己的地址，监听之后才知道端口
  let allowedOrigin = ''

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`)
    if (token !== undefined && requiresAuth(url.pathname) && !authorized(req, token)) {
      sendError(res, 401, '未授权：需要 Authorization: Bearer <token>', { 'www-authenticate': 'Bearer' })
      return
    }
    if (gui !== undefined && (url.pathname === GUI_PATH || url.pathname.startsWith(`${GUI_PATH}/`))) {
      if (await handleGuiRequest(gui, req, res, url, allowedOrigin)) return
    }
    if (url.pathname === '/mcp') {
      await handleMcp(req, res, tools, log)
      return
    }
    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      // 旧的 REST 管理面已删：/api 下只剩界面接口（上面已认领），其余路径一律 404
      sendError(res, 404, 'Not Found')
      return
    }
    if (staticRoot === undefined) {
      sendError(res, 404, 'Not Found（WebUI 未构建：packages/webui/dist 不存在）')
      return
    }
    await serveStatic(req, res, url, staticRoot)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log?.error('[plastic-memory] HTTP 请求失败:', error)
      if (!res.headersSent) sendError(res, 500, '内部错误')
      else res.destroy()
    })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? DEFAULT_PORT, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('HTTP 服务没有拿到监听地址')
  }
  allowedOrigin = `http://${LOOPBACK_HOST}:${address.port}`

  const close = async (): Promise<void> => {
    const stopped = new Promise<void>((resolvePromise, reject) => {
      server.close(error => (error === undefined ? resolvePromise() : reject(error)))
    })
    server.closeAllConnections()
    try {
      await stopped
    } finally {
      // 先停服务再释放平面：释放会写视图文件，不该再和请求抢
      await gui?.dispose()
    }
  }
  return { host: LOOPBACK_HOST, port: address.port, url: `http://${LOOPBACK_HOST}:${address.port}`, server, close }
}

/** bin 的 serve 分支解析出来的环境配置（与 stdio 模式同一组 PLASTIC_*）。 */
export interface ServeCliConfig {
  root: string
  client: string
  project?: string
  /** bin 装配好的无宿主平面；stdio 模式不涉及。 */
  gui?: GuiPlanePort
}

/**
 * serve 模式的界面与模型线路配置，全部来自环境变量（spec D7、D8）。
 * 项目必填；模型线路两个变量同给同缺，缺省没有模型；自动体检缺省不开（D8：常驻服务无人看着时不花额度）。
 */
export function parseGuiEnv(env: NodeJS.ProcessEnv): {
  project: string
  llm: { baseUrl: string; model: string; apiKey?: string; maxTokens?: number } | undefined
  autoCheckup: boolean
} {
  const project = env.PLASTIC_PROJECT?.trim() ?? ''
  if (project === '') throw new Error('缺少环境变量 PLASTIC_PROJECT（serve 模式的固定项目绝对路径）')
  if (!isAbsolute(project)) throw new Error(`PLASTIC_PROJECT 必须是绝对路径：${project}`)

  // 模型线路：地址与模型同给同缺；只给一个时拼不出可用的调用，直接报错而不是留半套
  const baseUrl = env.PLASTIC_LLM_BASE_URL?.trim() ?? ''
  const model = env.PLASTIC_LLM_MODEL?.trim() ?? ''
  if ((baseUrl === '') !== (model === '')) {
    throw new Error('PLASTIC_LLM_BASE_URL 与 PLASTIC_LLM_MODEL 必须同时给或同时不给')
  }
  const maxTokensRaw = env.PLASTIC_LLM_MAX_TOKENS?.trim() ?? ''
  let maxTokens: number | undefined
  if (maxTokensRaw !== '') {
    const value = Number(maxTokensRaw)
    if (!Number.isInteger(value) || value <= 0) throw new Error(`PLASTIC_LLM_MAX_TOKENS 必须是正整数：${maxTokensRaw}`)
    maxTokens = value
  }
  const apiKey = env.PLASTIC_LLM_API_KEY?.trim() ?? ''

  return {
    project,
    llm: baseUrl === ''
      ? undefined
      : {
          baseUrl,
          model,
          ...(apiKey === '' ? {} : { apiKey }),
          ...(maxTokens === undefined ? {} : { maxTokens }),
        },
    autoCheckup: env.PLASTIC_AUTO_CHECKUP === '1',
  }
}

/** `plastic-mcp serve` 的进程入口：起 core + 工具 + HTTP 服务，SIGINT/SIGTERM 时先停服务再关 core。 */
export async function runServeCli(argv: string[], config: ServeCliConfig, log: MemoryLogger): Promise<void> {
  const args = parseServeArgs(argv)
  const core = await createMemoryCore({ root: config.root, client: config.client, log })
  const tools = createMemoryTools(core, {
    client: config.client,
    ...(config.project === undefined ? {} : { project: config.project }),
  })
  let server: MemoryHttpServer
  try {
    server = await startMemoryServer({
      tools, port: args.port, log,
      ...(config.gui === undefined ? {} : { gui: config.gui }),
      ...(args.token === undefined ? {} : { token: args.token }),
    })
  } catch (error) {
    await core.close()
    throw error
  }
  log.info(`HTTP 模式已启动：${server.url}（仅本机绑定${args.token === undefined ? '，未启用鉴权' : '，Bearer 鉴权已启用'}）`)
  log.info(staticRootOf(DEFAULT_WEBUI_DIR) === undefined
    ? 'WebUI 产物不存在，当前只提供 /api/gui 与 /mcp'
    : `静态托管：${DEFAULT_WEBUI_DIR}`)

  let closing = false
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    void server.close()
      .catch(() => {})
      .then(() => core.close())
      .catch(() => {})
      .finally(() => process.exit(code))
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
}
