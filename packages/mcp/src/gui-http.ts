import type { IncomingMessage, ServerResponse } from 'node:http'
import { GUI_VIEW_FILES } from '@plastic/core/gui/contract.ts'
import { sendJson } from './http-util.ts'

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
 * 响应一律走 http-util.ts 的 sendJson；sendError 只写扁平的 `{ error: string }`，表达不了这里的码。
 */

/** 设置路径操作（与插件 memory-settings.ts 的 SettingsPathOp 同形；端口按结构匹配，mcp 包不 import 插件源码）。 */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** 设置快照（GET 的响应体）：unavailable = 坏文件或语义不对，页面按不可用显示、写入被拒。 */
export type SettingsSnapshot =
  | { status: 'ready'; revision: number; value: unknown; writable: true }
  | { status: 'unavailable'; reason: 'corrupt' | 'invalid'; detail: string }

export type SettingsMutateResult =
  | { ok: true; value: unknown; revision: number }
  | { ok: false; reason: 'conflict'; current?: { revision: number; value: unknown } }
  | { ok: false; reason: 'invalid'; issues: string[] }
  | { ok: false; reason: 'unavailable'; detail: string }

/** 快照端点的平面结果（与插件 plane.ts 的 GuiSnapshotResult 同形）。 */
export type GuiSnapshotResult =
  | { status: 'ready'; text: string; usedTokens: number; injectedCount: number }
  | { status: 'bad-project'; project?: string }

/** GUI 平面的 HTTP 侧形状：Task 3 的 GuiPlane 结构一致，bin.ts 直接赋值由 typecheck 证明。 */
export interface GuiPlanePort {
  memoryRoot: string
  run(rawInput: string): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  readView(name: string): Promise<{ status: 'ready'; text: string } | { status: 'missing' }>
  readFile(path: string): Promise<string | undefined>
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
  readSettings(): Promise<SettingsSnapshot>
  mutateSettings(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<SettingsMutateResult>
  snapshot(project?: string): Promise<GuiSnapshotResult>
  dispose(): Promise<void>
}

const COMMANDS_PATH = '/api/gui/commands'
const VIEWS_PREFIX = '/api/gui/views/'
const FILE_PATH = '/api/gui/file'
const OPEN_PATH = '/api/gui/open'
const SETTINGS_PATH = '/api/gui/settings'
const SNAPSHOT_PATH = '/api/gui/snapshot'

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

/** `GET /api/gui/settings`：设置快照原样回（ready 与 unavailable 都是 200，页面按 status 分支）。 */
async function handleReadSettings(plane: GuiPlanePort, res: ServerResponse): Promise<void> {
  sendJson(res, 200, await plane.readSettings())
}

/** `POST /api/gui/settings` 的请求体：ops 必须是操作数组，expectedRevision 可选正数或 0。 */
function parseSettingsBody(body: Record<string, unknown>): { ops: SettingsPathOp[]; expectedRevision?: number } | { error: string } {
  const rawOps = body.ops
  if (!Array.isArray(rawOps)) return { error: 'ops 必须是操作数组' }
  const ops: SettingsPathOp[] = []
  for (const [i, raw] of rawOps.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: `ops[${i}] 必须是对象` }
    const op = raw as Record<string, unknown>
    if (op.op !== 'set' && op.op !== 'unset') return { error: `ops[${i}].op 只能是 set 或 unset` }
    if (!Array.isArray(op.path) || op.path.length === 0 || !op.path.every(seg => typeof seg === 'string' && seg !== '')) {
      return { error: `ops[${i}].path 必须是非空字符串数组` }
    }
    if (op.op === 'set') ops.push({ op: 'set', path: op.path as string[], value: op.value })
    else ops.push({ op: 'unset', path: op.path as string[] })
  }
  const rawRevision = body.expectedRevision
  if (rawRevision !== undefined && (typeof rawRevision !== 'number' || !Number.isSafeInteger(rawRevision) || rawRevision < 0)) {
    return { error: 'expectedRevision 必须是非负整数' }
  }
  return { ops, ...(rawRevision === undefined ? {} : { expectedRevision: rawRevision }) }
}

/** `POST /api/gui/settings`：提交一批操作；冲突 409、内容不合法 400、坏文件 409（settings/unavailable），都不写。 */
async function handleMutateSettings(plane: GuiPlanePort, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req, res)
  if (body === undefined) return
  const parsed = parseSettingsBody(body)
  if ('error' in parsed) {
    sendGuiError(res, 400, 'settings/bad-request', parsed.error)
    return
  }
  const result = await plane.mutateSettings(parsed.ops, parsed.expectedRevision)
  if (result.ok) {
    sendJson(res, 200, { status: 'ready', revision: result.revision, value: result.value, writable: true })
    return
  }
  if (result.reason === 'conflict') {
    sendGuiError(res, 409, 'settings/conflict', `版本号对不上：请重读设置后再提交${result.current === undefined ? '' : `（当前 ${result.current.revision}）`}`,
      result.current === undefined ? {} : { 'x-plastic-settings-revision': String(result.current.revision) })
    return
  }
  if (result.reason === 'invalid') {
    sendGuiError(res, 400, 'settings/invalid', `设置不合法：${result.issues.join('；')}`)
    return
  }
  sendGuiError(res, 409, 'settings/unavailable', result.detail)
}

/** `GET /api/gui/snapshot`：快照原文与用量；project 缺省用装配的项目，不存在或非绝对路径 400。 */
async function handleSnapshot(plane: GuiPlanePort, res: ServerResponse, url: URL): Promise<void> {
  const project = url.searchParams.get('project') ?? undefined
  const snap = await plane.snapshot(project === undefined || project === '' ? undefined : project)
  if (snap.status === 'bad-project') {
    sendGuiError(res, 400, 'snapshot/bad-project', `project 必须是已存在目录的绝对路径${snap.project === undefined ? '' : `：${snap.project}`}`)
    return
  }
  sendJson(res, 200, { text: snap.text, usedTokens: snap.usedTokens, injectedCount: snap.injectedCount })
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
  if (path === SETTINGS_PATH) {
    if (req.method === 'GET') await handleReadSettings(plane, res)
    else if (req.method === 'POST') {
      if (acceptJsonWrite(req, res, allowedOrigin)) await handleMutateSettings(plane, req, res)
    } else {
      sendGuiError(res, 405, 'gui/method', `方法不允许：${req.method ?? ''}`, { allow: 'GET, POST' })
    }
    return true
  }
  if (path === SNAPSHOT_PATH) {
    if (allowMethod(req, res, 'GET')) await handleSnapshot(plane, res, url)
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
