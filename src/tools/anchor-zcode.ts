/**
 * ZCode 的会话锚适配器（设计说明 §A3）：对规范会话库 <zcodeDir>/db/db.sqlite 只读定位与开窗。
 * 定位：tool_usage 的近十分钟时间窗（(started_at, tool_name) 索引）找 tool_name 以 memory_save 结尾的调用，
 * 再到该会话近十分钟的 part 里找 state.input.title/text 与收到的入参全等的那条（全等才认，最新优先）；
 * 锚的起点 = 当轮首条真实用户消息的 sequence（往回扫不超过 TURN_SCAN_BACK，找不到取 0），终点 = 当前最大 sequence。
 * 只走索引、只取近十分钟：不搬整块工具输出、不做全表扫描。
 * node:sqlite 在函数内动态加载：宿主的 Node 没有它时抛错，由调度器按探针失败降级，不影响模块加载。
 */
import { existsSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  ANCHOR_TEXT_CAP, ANCHOR_WINDOW_CAP, isZcodeSessionId,
  type AnchorAdapter, type AnchorEvent, type AnchorWindow, type SourceAnchor,
} from './anchor.ts'

const TEN_MINUTES_MS = 10 * 60 * 1000
/** 当轮起点往回扫的上限：再远就不找了，按整会话锚（起点 0）兜底。 */
const TURN_SCAN_BACK = 200

export interface ZcodeAnchorOptions {
  /** 客户端根目录（缺省 ~/.zcode/cli），库在 <root>/db/db.sqlite */
  zcodeDir: string
}

export function zcodeDbPath(zcodeDir: string): string {
  return join(zcodeDir, 'db', 'db.sqlite')
}

interface Sidecars { wal: boolean, shm: boolean }
type Row = Record<string, unknown>

interface MessageDoc { role?: unknown, synthetic?: unknown }
interface PartDoc {
  type?: unknown
  text?: unknown
  tool?: unknown
  state?: { input?: unknown, output?: unknown }
}

/**
 * 只读打开，方式看旁路文件（2026-11-26 实测的规则）：库在 WAL 模式且没有活跃连接时，普通只读打开也会留下
 * 0 字节的 -wal 与 32KB 的 -shm 空壳。所以有 -wal（ZCode 在线，定位时的常态）用普通只读——能读到 WAL 里
 * 未合并的新写入；没有就用 immutable 打开——SQLite 不建旁路文件，什么都不留。
 * 竞态下冒出来的空壳由 sweepOwnSidecars 兜底（见 close）。
 */
async function openReadonly(dbPath: string): Promise<{ db: DatabaseSync, close: () => Promise<void> }> {
  const { DatabaseSync: SqliteDatabase } = await import('node:sqlite')
  const before: Sidecars = { wal: existsSync(`${dbPath}-wal`), shm: existsSync(`${dbPath}-shm`) }
  const db = before.wal
    ? new SqliteDatabase(dbPath, { readOnly: true })
    : new SqliteDatabase(`file:${dbPath}?immutable=1`, { readOnly: true })
  return {
    db,
    close: () => {
      db.close()
      return sweepOwnSidecars(dbPath, before)
    },
  }
}

/**
 * 竞态兜底：打开前没有、关闭后冒出来的旁路空壳（-wal 0 字节）删掉；-wal 非空说明有并发写入者，整套不动。
 * 导出仅供用例直接守这段规则（正常路径到不了它：有 -wal 走普通只读，没有走 immutable，两者都留不下文件）。
 */
export async function sweepOwnSidecars(dbPath: string, before: Sidecars): Promise<void> {
  const walPath = `${dbPath}-wal`
  if (before.wal || !existsSync(walPath)) return
  let size = -1
  try { size = statSync(walPath).size } catch { return }
  if (size !== 0) return
  await unlink(walPath).catch(() => {})
  if (!before.shm) await unlink(`${dbPath}-shm`).catch(() => {})
}

/** 客户端锚适配器：定位与开窗共用同一条只读打开路径，id 只进 SQL 参数、不进任何路径拼接。 */
export function createZcodeAnchorAdapter(options: ZcodeAnchorOptions): AnchorAdapter {
  const dbPath = zcodeDbPath(options.zcodeDir)
  return {
    scheme: 'zcode',
    async locateCall(args, now) {
      const { db, close } = await openReadonly(dbPath)
      try {
        return locateInDb(db, args, now)
      } finally {
        await close()
      }
    },
    async readWindow(anchor, window) {
      // 形状不对的 id 当读不了：不拼路径、不发查询
      const id = anchor.sessionId.startsWith('zcode:') ? anchor.sessionId.slice('zcode:'.length) : ''
      if (id === '') throw new Error(`不是 ZCode 锚：${anchor.sessionId}`)
      if (!isZcodeSessionId(id)) throw new Error(`ZCode 会话 id 形状不认识：${anchor.sessionId}`)
      const { db, close } = await openReadonly(dbPath)
      try {
        return readWindowInDb(db, id, anchor.eventRange, window)
      } finally {
        await close()
      }
    },
  }
}

/** 候选会话来自 tool_usage 的时间窗（新会话优先）；第一个有全等命中的会话就是「刚刚发出这次调用」的会话。 */
function locateInDb(db: DatabaseSync, args: { title: string, text: string }, now: number): SourceAnchor | undefined {
  const since = now - TEN_MINUTES_MS
  const usages = db.prepare(
    "SELECT session_id FROM tool_usage WHERE started_at >= ? AND tool_name LIKE '%memory_save' ORDER BY started_at DESC",
  ).all(since) as Row[]
  const sessions: string[] = []
  for (const row of usages) {
    const sid = row.session_id
    if (typeof sid === 'string' && !sessions.includes(sid)) sessions.push(sid)
  }
  for (const sid of sessions) {
    const callSeq = findCallSequence(db, sid, since, args)
    if (callSeq === undefined) continue
    return { sessionId: `zcode:${sid}`, eventRange: [turnStart(db, sid, callSeq), Math.max(callSeq, maxSequence(db, sid))] }
  }
  return undefined
}

/** 全等才认：该会话近十分钟的 part 里，tool 以 memory_save 结尾且 state.input.title/text 与入参全等的最新一条。 */
function findCallSequence(db: DatabaseSync, sid: string, since: number, args: { title: string, text: string }): number | undefined {
  const messages = db.prepare(
    'SELECT id, sequence FROM message WHERE session_id = ? AND time_created >= ? AND sequence IS NOT NULL',
  ).all(sid, since) as Row[]
  if (messages.length === 0) return undefined
  const seqOf = new Map<string, number>()
  const ids: string[] = []
  for (const m of messages) {
    if (typeof m.id === 'string') {
      ids.push(m.id)
      if (typeof m.sequence === 'number') seqOf.set(m.id, m.sequence)
    }
  }
  if (ids.length === 0) return undefined
  const placeholders = ids.map(() => '?').join(', ')
  const parts = db.prepare(
    `SELECT message_id, sequence, data FROM part WHERE message_id IN (${placeholders}) AND data LIKE '%memory_save%'`,
  ).all(...ids) as Row[]
  const hits = parts
    .map(p => ({
      seq: typeof p.message_id === 'string' ? seqOf.get(p.message_id) : undefined,
      pseq: typeof p.sequence === 'number' ? p.sequence : 0,
      data: typeof p.data === 'string' ? p.data : '',
    }))
    .filter((h): h is { seq: number, pseq: number, data: string } => h.seq !== undefined)
    .sort((a, b) => (b.seq - a.seq) || (b.pseq - a.pseq))
  for (const hit of hits) {
    const doc = safeParse(hit.data) as PartDoc | undefined
    if (doc?.type !== 'tool' || typeof doc.tool !== 'string' || !doc.tool.endsWith('memory_save')) continue
    if (typeof doc.state?.input !== 'object' || doc.state.input === null) continue
    const input = doc.state.input as { title?: unknown, text?: unknown }
    if (input.title === args.title && input.text === args.text) return hit.seq
  }
  return undefined
}

/** 当轮起点：调用所在消息之前（含同级）最近一条真实用户消息（role=user 且非 synthetic）的 sequence。 */
function turnStart(db: DatabaseSync, sid: string, atSeq: number): number {
  const row = db.prepare(
    `SELECT sequence FROM message
     WHERE session_id = ? AND sequence IS NOT NULL AND sequence <= ? AND sequence > ?
       AND json_extract(data, '$.role') = 'user' AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0
     ORDER BY sequence DESC LIMIT 1`,
  ).get(sid, atSeq, Math.max(0, atSeq - TURN_SCAN_BACK)) as Row | undefined
  return typeof row?.sequence === 'number' ? row.sequence : 0
}

function maxSequence(db: DatabaseSync, sid: string): number {
  const row = db.prepare('SELECT MAX(sequence) AS m FROM message WHERE session_id = ?').get(sid) as Row | undefined
  return typeof row?.m === 'number' ? row.m : 0
}

/**
 * 开窗读，与 DSH 的 sourceWindow 同语义：起点前多读 2 条作上下文，默认宽度 = 区间长，window 收窄，
 * 封顶 ANCHOR_WINDOW_CAP 行可读事件。一个事件是一条消息里的一个可读块：文本块按消息角色（工具结果消息标 tool），
 * 工具块标 tool（调用行列工具名，结果行取输出）；reasoning 与步进标记计入 skipped。
 */
function readWindowInDb(db: DatabaseSync, sid: string, eventRange: [number, number], window?: number): AnchorWindow {
  if (db.prepare('SELECT id FROM session WHERE id = ?').get(sid) === undefined) {
    throw new Error('ZCode 里没有这个会话（已删除或不在这台机器上）')
  }
  const [start, end] = eventRange
  const width = Math.min(Math.max(window ?? end - start, 1), ANCHOR_WINDOW_CAP)
  const lo = Math.max(0, start - 2)
  const hi = start + width
  const messages = db.prepare(
    'SELECT id, sequence, data FROM message WHERE session_id = ? AND sequence IS NOT NULL AND sequence >= ? AND sequence <= ? ORDER BY sequence ASC',
  ).all(sid, lo, hi) as Row[]
  const events: AnchorEvent[] = []
  let skipped = 0
  messageLoop:
  for (const m of messages) {
    const seq = m.sequence
    if (typeof seq !== 'number' || typeof m.id !== 'string') continue
    const doc = safeParse(typeof m.data === 'string' ? m.data : '') as MessageDoc | undefined
    const role = typeof doc?.role === 'string' ? doc.role : '?'
    // 工具结果消息：role 是 user 但带 synthetic，行角色标 tool（对齐 DSH 的 tool/result）
    const isResult = role === 'user' && doc?.synthetic === true
    const parts = db.prepare(
      'SELECT data FROM part WHERE message_id = ? AND sequence IS NOT NULL ORDER BY sequence ASC',
    ).all(m.id) as Row[]
    for (const p of parts) {
      const part = safeParse(typeof p.data === 'string' ? p.data : '') as PartDoc | undefined
      if (part === undefined) { skipped++; continue }
      if (part.type === 'text' && typeof part.text === 'string') {
        if (events.length >= ANCHOR_WINDOW_CAP) break messageLoop
        events.push({ seq, role: isResult ? 'tool' : role, text: cap(part.text) })
      } else if (part.type === 'tool') {
        if (events.length >= ANCHOR_WINDOW_CAP) break messageLoop
        const name = typeof part.tool === 'string' ? part.tool : '(未知工具)'
        events.push({ seq, role: 'tool', text: isResult ? cap(outputText(part)) : `调用 ${name}` })
      } else {
        // reasoning、步进标记等结构事件：与 DSH 一致计入「未显示」
        skipped++
      }
    }
  }
  const first = events[0]?.seq ?? start
  const last = events.length > 0 ? events[events.length - 1]!.seq : end
  return { events, skipped, range: [first, last] }
}

const cap = (text: string): string => text.length > ANCHOR_TEXT_CAP ? `${text.slice(0, ANCHOR_TEXT_CAP)}…` : text

function outputText(part: PartDoc): string {
  const out = part.state?.output
  return typeof out === 'string' ? out : out === undefined || out === null ? '' : JSON.stringify(out)
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
