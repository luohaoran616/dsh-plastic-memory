import type { IncomingMessage, ServerResponse } from 'node:http'
import { GUI_VIEW_FILES } from '@plastic/core/gui/contract.ts'
import { sendJson } from './rest.ts'

/**
 * 独立页面专用的 `/api/gui/*`（D4）：命令行、视图原文、记忆根内文件、打开文件四个端点。
 * 鉴权不在这一层：serve.ts 按 `/api` 的既有规则先验 `Authorization`，这里只管路径、方法与写保护。
 *
 * 安全约定（D6、R5）：两个写端点只收 `content-type: application/json`；带 `Origin` 且不是服务自己的来源一律拒
 * （服务自己的来源另认同端口的 localhost 别名，见 originAllowed）。
 * 跨站网页发不出带 JSON content-type 的简单请求（那要先过 CORS 预检），所以这两道合起来挡住借浏览器发起的跨站写。
 * 读端点没有副作用，浏览器也读不到跨站响应（同源策略），不再加 Origin 检查。
 *
 * 错误体统一 `{ error: { code, message } }`：code 是前端分支用的稳定码，message 只作说明。
 * 响应一律走 rest.ts 的 sendJson；sendError 只写扁平的 `{ error: string }`，表达不了这里的码。
 */

/** GUI 平面的 HTTP 侧形状：Task 3 的 GuiPlane 结构一致，bin.ts 直接赋值由 typecheck 证明。 */
export interface GuiPlanePort {
  memoryRoot: string
  run(rawInput: string): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  readView(name: string): Promise<{ status: 'ready'; text: string } | { status: 'missing' }>
  readFile(path: string): Promise<string | undefined>
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
  dispose(): Promise<void>
}

const COMMANDS_PATH = '/api/gui/commands'
const VIEWS_PREFIX = '/api/gui/views/'
const FILE_PATH = '/api/gui/file'
const OPEN_PATH = '/api/gui/open'

/** 可读视图名：四个全局视图由契约给，体检视图与会话归属视图与它们并列（Task 3 的 GuiViewName）。 */
const VIEW_NAMES: ReadonlySet<string> = new Set([...Object.keys(GUI_VIEW_FILES), 'checkups', 'workspaces'])

/** 读体上限 256 KiB：四个请求都是小 JSON，超过这个量级不是页面发出来的。 */
const MAX_BODY_BYTES = 256 * 1024

/** 命令行上限 64 KiB：一行命令只带子命令与一段 JSON 参数。 */
const MAX_LINE_BYTES = 64 * 1024

/** 错误体统一入口：码是稳定契约，message 只给人看。 */
function sendGuiError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: { code, message } }, headers)
}

/** 方法不对回 405 并带上 allow；返回 false 表示已经把响应写完。 */
function allowMethod(req: IncomingMessage, res: ServerResponse, method: string): boolean {
  if (req.method === method) return true
  sendGuiError(res, 405, 'gui/method', `方法不允许：${req.method ?? ''}`, { allow: method })
  return false
}

/**
 * 读请求体并卡上限。超限后继续把剩下的字节收完再回 413：立刻断流会让浏览器拿到连接重置而不是这个错误码。
 * 超限之后的字节只丢不存，内存占用停在上限附近。
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; status: number; code: string; message: string }> {
  const chunks: Buffer[] = []
  let size = 0
  let isOverflow = false
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      isOverflow = true
      chunks.length = 0
      continue
    }
    if (!isOverflow) chunks.push(buffer)
  }
  if (isOverflow) return { ok: false, status: 413, code: 'gui/too-large', message: `请求体超过 ${maxBytes} 字节上限` }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

/** 请求体收成 JSON 对象；语法错、不是对象、数组都按同一个 400（判断不了字段之前先要求形状）。 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * 两个写端点共用的门槛：content-type 必须是 application/json，Origin 存在时必须等于服务自己的来源（D6）。
 * 被拒的请求体不再读，resume 一下让剩余字节流干净，浏览器才收得到错误码。
 */
function acceptJsonWrite(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): boolean {
  const contentType = req.headers['content-type'] ?? ''
  const mediaType = contentType.split(';', 1)[0]!.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    req.resume()
    sendGuiError(res, 415, 'gui/content-type', '写接口只接受 application/json')
    return false
  }
  const origin = req.headers.origin
  if (origin !== undefined && !originAllowed(origin.trim(), allowedOrigin)) {
    req.resume()
    sendGuiError(res, 403, 'gui/bad-origin', `来源不被允许：${origin}`)
    return false
  }
  return true
}

/**
 * 来源判定（R5）：请求带的 origin 必须等于服务自己的来源。
 * 绑定地址是 127.0.0.1 时，同端口的 localhost 是同一个服务的别名：浏览器把 origin 设成发起页自己的来源，
 * 用户用 http://localhost:<port> 打开本服务的页面时，写请求带的就是这个别名，端口必须一致。
 * 别名只换主机名、端口照抄，别的端口是别的服务；外来源与 null 照拒。
 */
function originAllowed(origin: string, allowedOrigin: string): boolean {
  if (origin === allowedOrigin) return true
  let allowed: URL
  try {
    allowed = new URL(allowedOrigin)
  } catch {
    return false
  }
  if (allowed.hostname !== '127.0.0.1' || allowed.port === '') return false
  return origin === `http://localhost:${allowed.port}`
}

/** 读整个请求体并收窄成 400/413 的失败体；两个写端点的前三步完全一样。 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const body = await readBody(req, MAX_BODY_BYTES)
  if (!body.ok) {
    sendGuiError(res, body.status, body.code, body.message)
    return undefined
  }
  const parsed = parseJsonObject(body.text)
  if (parsed === undefined) {
    sendGuiError(res, 400, 'gui/bad-request', '请求体必须是 JSON 对象')
    return undefined
  }
  return parsed
}

/** `POST /api/gui/commands`：`line` 必须是 `/memory` 开头的一行，逐字交给平面，命令失败也是 200。 */
async function handleCommands(plane: GuiPlanePort, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return
  const line = body.line
  if (typeof line !== 'string' || !line.startsWith('/memory')) {
    sendGuiError(res, 400, 'gui/bad-line', 'line 必须是 /memory 开头的命令行')
    return
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    sendGuiError(res, 413, 'gui/too-large', `命令行超过 ${MAX_LINE_BYTES} 字节上限`)
    return
  }
  sendJson(res, 200, await plane.run(line))
}

/** `POST /api/gui/open`：action 只认 open 与 reveal；平面拒绝（根外）时 ok 为 false，仍是 200。 */
async function handleOpen(plane: GuiPlanePort, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return
  const path = body.path
  const action = body.action
  if (typeof path !== 'string' || path.trim() === '') {
    sendGuiError(res, 400, 'gui/bad-request', 'path 必须是非空字符串')
    return
  }
  if (action !== 'open' && action !== 'reveal') {
    sendGuiError(res, 400, 'gui/bad-request', 'action 只能是 open 或 reveal')
    return
  }
  sendJson(res, 200, { ok: await plane.openPath(path, action) })
}

/** `GET /api/gui/views/<name>`：名字先按契约白名单收窄（平面只认已知视图），原文按 JSON 回。 */
async function handleView(plane: GuiPlanePort, res: ServerResponse, url: URL): Promise<void> {
  const rawName = url.pathname.slice(VIEWS_PREFIX.length)
  let name: string
  try {
    name = decodeURIComponent(rawName)
  } catch {
    sendGuiError(res, 404, 'gui/unknown-view', `未知视图：${rawName}`)
    return
  }
  if (!VIEW_NAMES.has(name)) {
    sendGuiError(res, 404, 'gui/unknown-view', `未知视图：${name}`)
    return
  }
  const view = await plane.readView(name)
  if (view.status === 'missing') {
    sendGuiError(res, 404, 'gui/view-missing', `视图还没生成：${name}`)
    return
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(view.text),
    'cache-control': 'no-store',
  })
  res.end(view.text)
}

/** `GET /api/gui/file?path=`：读不到与根外都是 404，错误体不透露路径为什么不给读。 */
async function handleFile(plane: GuiPlanePort, res: ServerResponse, url: URL): Promise<void> {
  const path = url.searchParams.get('path') ?? ''
  if (path.trim() === '') {
    sendGuiError(res, 400, 'gui/bad-request', 'path 参数必填')
    return
  }
  const text = await plane.readFile(path)
  if (text === undefined) {
    sendGuiError(res, 404, 'gui/file-unavailable', '读不到这个文件，或它不在记忆根内')
    return
  }
  sendJson(res, 200, { text })
}

/** 路径归它管时处理并返回 true。allowedOrigin 是服务自己的来源（如 http://127.0.0.1:7788）。 */
export async function handleGuiRequest(plane: GuiPlanePort, req: IncomingMessage, res: ServerResponse, url: URL, allowedOrigin: string): Promise<boolean> {
  const path = url.pathname
  if (path === COMMANDS_PATH) {
    if (allowMethod(req, res, 'POST') && acceptJsonWrite(req, res, allowedOrigin)) await handleCommands(plane, req, res)
    return true
  }
  if (path === OPEN_PATH) {
    if (allowMethod(req, res, 'POST') && acceptJsonWrite(req, res, allowedOrigin)) await handleOpen(plane, req, res)
    return true
  }
  if (path === FILE_PATH) {
    if (allowMethod(req, res, 'GET')) await handleFile(plane, res, url)
    return true
  }
  if (path.startsWith(VIEWS_PREFIX)) {
    if (allowMethod(req, res, 'GET')) await handleView(plane, res, url)
    return true
  }
  return false
}
