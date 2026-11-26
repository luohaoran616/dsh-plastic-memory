/**
 * Antigravity 的会话锚适配器（设计说明 §A3）：对每会话一份的明文转写只读定位与开窗。
 * 实测（2026-11-26，brain/bdebe3c4… 的 memory_search 调用）：MCP 调用在转写里是包装名 `call_mcp_tool`，
 * 真工具名在 `args.ToolName`、完整入参在 `args.Arguments`（JSON 字符串，一字不差），
 * PLANNER_RESPONSE 行先于工具执行写入（调用行 11:08:25Z，结果步 11:08:27Z）。
 * 定位：最近十分钟改动过的转写里，从尾部往前找 `call_mcp_tool(ToolName=memory_save)` 且 Arguments
 * 解析后 title/text 与收到的入参全等的行（最新命中优先）；解析不出（截断等）退回转义子串比对
 * （title 全等 + text 前 120 字）。锚：起点 = 命中行之前最近的 USER_INPUT 的 step_index（找不到取 0），
 * 终点 = 文件最大 step_index。开窗按行流式读，窗口外的行只看 step_index 不整体解析。
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  ANCHOR_TEXT_CAP, ANCHOR_WINDOW_CAP, isAntigravitySessionId,
  type AnchorAdapter, type AnchorEvent, type AnchorWindow, type SourceAnchor,
} from './anchor.ts'

const TEN_MINUTES_MS = 10 * 60 * 1000
/** 定位只读转写尾部：命中只可能在最近几分钟，256 KB 足够覆盖一个长 turn。 */
const LOCATE_TAIL_BYTES = 256 * 1024
/** 转义子串退避比对时 text 取的前缀长度（spec §A2）。 */
const FALLBACK_TEXT_HEAD = 120

const STEP_HEAD = /^\{"step_index":\s*(\d+)/
const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/

export interface AntigravityAnchorOptions {
  /** 客户端根目录（缺省 ~/.gemini/antigravity），会话转写在 <root>/brain/<uuid>/.system_generated/logs/transcript.jsonl */
  antigravityDir: string
}

export function antigravityBrainPath(antigravityDir: string): string {
  return join(antigravityDir, 'brain')
}

function transcriptPath(brainDir: string, sessionId: string): string {
  return join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl')
}

interface StepDoc {
  step_index?: unknown
  type?: unknown
  content?: unknown
  tool_calls?: Array<{ name?: unknown, args?: unknown }>
}

/** 客户端锚适配器：定位与开窗都只读转写文件；会话 id 是 brain/ 下的目录名（裸 uuid），不进任何路径拼接。 */
export function createAntigravityAnchorAdapter(options: AntigravityAnchorOptions): AnchorAdapter {
  const brainDir = antigravityBrainPath(options.antigravityDir)
  return {
    scheme: 'antigravity',
    async locateCall(args, now) {
      if (!existsSync(brainDir)) return undefined
      return locateInTranscripts(brainDir, args, now)
    },
    async readWindow(anchor, window) {
      const id = anchor.sessionId.startsWith('antigravity:') ? anchor.sessionId.slice('antigravity:'.length) : ''
      // 形状不对的 id 当读不了：不拼路径、不读文件
      if (id === '') throw new Error(`不是 Antigravity 锚：${anchor.sessionId}`)
      if (!isAntigravitySessionId(id)) throw new Error(`Antigravity 会话 id 形状不认识：${anchor.sessionId}`)
      return readWindowInTranscript(brainDir, id, anchor.eventRange, window)
    },
  }
}

/** 近十分钟改动过的转写（新改动优先）：目录数是个位数，按转写文件 mtime 筛即可。 */
function candidateTranscripts(brainDir: string, now: number): Array<{ dir: string, path: string }> {
  const since = now - TEN_MINUTES_MS
  const candidates: Array<{ dir: string, path: string, mtime: number }> = []
  let entries: string[] = []
  try {
    entries = readdirSync(brainDir)
  } catch {
    return []
  }
  for (const dir of entries) {
    const path = transcriptPath(brainDir, dir)
    if (!existsSync(path)) continue
    try {
      const mtime = statSync(path).mtimeMs
      if (mtime >= since) candidates.push({ dir, path, mtime })
    } catch {
      // 正被客户端改写的文件 stat 失败：跳过这个候选
    }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime).map(({ dir, path }) => ({ dir, path }))
}

/** 读文件尾部并丢弃半截首行（start>0 时首个 \n 之前是残行）。 */
async function readTail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const start = Math.max(0, size - bytes)
    const length = size - start
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text
  } finally {
    await handle.close()
  }
}

async function locateInTranscripts(brainDir: string, args: { title: string, text: string }, now: number): Promise<SourceAnchor | undefined> {
  for (const candidate of candidateTranscripts(brainDir, now)) {
    let lines: string[]
    try {
      lines = (await readTail(candidate.path, LOCATE_TAIL_BYTES)).split('\n').filter(line => line.trim() !== '')
    } catch {
      continue
    }
    // 从尾部往前找最新命中
    let hitStep: number | undefined
    for (let i = lines.length - 1; i >= 0; i--) {
      const step = matchSaveCall(lines[i]!, args)
      if (step !== undefined) { hitStep = step; break }
    }
    if (hitStep === undefined) continue
    return { sessionId: `antigravity:${candidate.dir}`, eventRange: [nearestUserInput(lines, hitStep), maxStepIndex(lines)] }
  }
  return undefined
}

/** 全等才认：PLANNER_RESPONSE 里的 call_mcp_tool(ToolName=memory_save)，Arguments 解析后与入参逐字段相等。 */
function matchSaveCall(line: string, args: { title: string, text: string }): number | undefined {
  // 便宜的预筛：这行得提到 memory_save
  if (!line.includes('memory_save')) return undefined
  const doc = safeParse(line) as StepDoc | undefined
  if (doc?.type !== 'PLANNER_RESPONSE' || !Array.isArray(doc.tool_calls)) return undefined
  const step = typeof doc.step_index === 'number' ? doc.step_index : undefined
  if (step === undefined) return undefined
  for (const call of doc.tool_calls) {
    if (call.name !== 'call_mcp_tool' || call.args === null || typeof call.args !== 'object') continue
    const callArgs = call.args as Record<string, unknown>
    if (unwrapJson(callArgs.ToolName) !== 'memory_save') continue
    // 主形态（实测）：Arguments 是 JSON 字符串，解析后精确比
    const parsed = parseArguments(callArgs.Arguments)
    if (parsed !== undefined) {
      if (parsed.title === args.title && parsed.text === args.text) return step
      continue
    }
    // 退避（编码未知或被截断）：转义子串比对——title 全等、text 前 120 字
    if (line.includes(escapeJsonBody(args.title)) && line.includes(escapeJsonBody(args.text.slice(0, FALLBACK_TEXT_HEAD)))) return step
  }
  return undefined
}

/** 双重编码的解码：'"memory_search"' → 'memory_search'；不是字符串或解不出来原样返回。 */
function unwrapJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function parseArguments(raw: unknown): { title?: unknown, text?: unknown } | undefined {
  if (typeof raw !== 'string') return undefined
  const parsed = safeParse(raw)
  return parsed !== undefined && typeof parsed === 'object' ? parsed as { title?: unknown, text?: unknown } : undefined
}

/** JSON 字符串里转义后的正文（不含首尾引号）：退避比对用，与转写行的原始字节对上。 */
function escapeJsonBody(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

function nearestUserInput(lines: string[], atStep: number): number {
  let best: number | undefined
  for (const line of lines) {
    const m = STEP_HEAD.exec(line)
    const step = m === null ? undefined : Number(m[1])
    if (step === undefined || step >= atStep) continue
    if (!line.includes('"USER_INPUT"')) continue
    if (best === undefined || step > best) best = step
  }
  return best ?? 0
}

function maxStepIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = STEP_HEAD.exec(lines[i]!)
    if (m !== null) return Number(m[1])
  }
  return 0
}

/**
 * 开窗读，与 DSH 的 sourceWindow 同语义：起点前多读 2 步作上下文，默认宽度 = 区间长，window 收窄，
 * 封顶 ANCHOR_WINDOW_CAP 行可读事件。一行一个事件：USER_INPUT → user（只取 <USER_REQUEST> 里的正文），
 * PLANNER_RESPONSE → assistant（有正文取正文，没有列工具调用名），GENERIC → tool（工具结果等模型产出）；
 * SYSTEM_MESSAGE、CHECKPOINT 等结构步骤与解析不出的行计入 skipped。
 */
async function readWindowInTranscript(brainDir: string, sessionId: string, eventRange: [number, number], window?: number): Promise<AnchorWindow> {
  const path = transcriptPath(brainDir, sessionId)
  if (!existsSync(path)) throw new Error('Antigravity 里没有这个会话（已删除或不在这台机器上）')
  const [start, end] = eventRange
  const width = Math.min(Math.max(window ?? end - start, 1), ANCHOR_WINDOW_CAP)
  const lo = Math.max(0, start - 2)
  const hi = start + width
  const events: AnchorEvent[] = []
  let skipped = 0
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const m = STEP_HEAD.exec(line)
      if (m === null) continue
      const step = Number(m[1])
      if (step < lo || step > hi) continue // 窗口外只看 step_index，不整体解析
      const rendered = renderStep(safeParse(line) as StepDoc | undefined)
      if (rendered === undefined) { skipped++; continue }
      if (events.length >= ANCHOR_WINDOW_CAP) break
      events.push({ seq: step, role: rendered.role, text: cap(rendered.body) })
    }
  } finally {
    lines.close()
    input.destroy()
  }
  const first = events[0]?.seq ?? start
  const last = events.length > 0 ? events[events.length - 1]!.seq : end
  return { events, skipped, range: [first, last] }
}

function renderStep(doc: StepDoc | undefined): { role: string, body: string } | undefined {
  if (doc === undefined) return undefined
  const content = typeof doc.content === 'string' ? doc.content : ''
  switch (doc.type) {
    case 'USER_INPUT': {
      const m = USER_REQUEST.exec(content)
      const body = (m !== null ? m[1]! : content).trim()
      return body === '' ? undefined : { role: 'user', body }
    }
    case 'PLANNER_RESPONSE': {
      if (content.trim() !== '') return { role: 'assistant', body: content.trim() }
      // 没有正文：列工具调用名（MCP 调用解出真名，内置工具标注来源）
      const names = (Array.isArray(doc.tool_calls) ? doc.tool_calls : []).map(call => {
        if (call.name !== 'call_mcp_tool') return `${typeof call.name === 'string' ? call.name : '(未知工具)'}（内置）`
        const toolName = call.args !== null && typeof call.args === 'object'
          ? unwrapJson((call.args as Record<string, unknown>).ToolName)
          : undefined
        return `${typeof toolName === 'string' ? toolName : 'mcp 工具'}`
      })
      return names.length > 0 ? { role: 'assistant', body: names.map(name => `调用 ${name}`).join('，') } : undefined
    }
    case 'GENERIC':
      return content.trim() === '' ? undefined : { role: 'tool', body: content }
    default:
      return undefined
  }
}

const cap = (text: string): string => text.length > ANCHOR_TEXT_CAP ? `${text.slice(0, ANCHOR_TEXT_CAP)}…` : text

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
