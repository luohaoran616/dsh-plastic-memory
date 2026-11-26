import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createAnchorLocator, type SourceAnchor } from '../src/tools/anchor.ts'
import { createZcodeAnchorAdapter, sweepOwnSidecars, zcodeDbPath } from '../src/tools/anchor-zcode.ts'

// ZCode 锚适配器：按真实 DDL（tests/fixtures/zcode-schema.sql）建临时库、按真实行形状造数据
// （2026-11-26 实测的键位：message.data 的 role/synthetic、part.data 的 type/tool/state.input），
// 守定位的全等规则、时间窗、开窗的方向/上限/跳过计数与旁路文件卫生。

const SCHEMA = fileURLToPath(new URL('./fixtures/zcode-schema.sql', import.meta.url))
const NOW = 1_800_000_000_000
const SID_A = 'sess_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SID_B = 'sess_0f9e8d7c-1b2a-4c3d-8e5f-6a7b8c9d0e1f'
const SID_C = 'sess_55555555-6666-4777-8888-9999aaaabbbb'
const SID_D = 'sess_77777777-8888-4999-8aaa-bbbbccccdddd'
const SID_F = 'sess_12121212-3434-4567-8989-ababcbcbdede'
const TOOL = 'mcp__plugin_plastic-memory_plastic-memory__memory_save'
const TITLE = '部署端口'
const TEXT = '部署脚本的端口是 8443，落在 gate 主机'

let root: string
let zcodeDir: string
let db: DatabaseSync

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-anchor-zcode-'))
  zcodeDir = join(root, 'zcode')
  db = await buildDb(zcodeDir)
  // node:sqlite 默认启用外键：message/part/tool_usage 都引用 session，先种会话行
  for (const sid of [SID_A, SID_B, SID_C, SID_D, SID_F]) insertSession(db, sid)
  seedMainTurn(db, SID_A)
  seedOldCall(db, SID_B)
  seedNearMiss(db, SID_C)
  seedWithoutUserTurn(db, SID_D)
})
afterEach(async () => {
  db?.close()
  await rm(root, { recursive: true, force: true })
})

async function buildDb(dir: string): Promise<DatabaseSync> {
  await mkdir(join(dir, 'db'), { recursive: true })
  const d = new DatabaseSync(zcodeDbPath(dir))
  d.exec(await readFile(SCHEMA, 'utf8'))
  return d
}

function insertSession(d: DatabaseSync, sid: string): void {
  d.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'proj', 'slug', '/tmp/proj', '会话', '1.0', ?, ?)")
    .run(sid, NOW, NOW)
}

function insertMessage(d: DatabaseSync, sid: string, seq: number, time: number, data: object): void {
  d.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`${sid}#${seq}`, sid, time, time, JSON.stringify(data), seq)
}

function insertPart(d: DatabaseSync, sid: string, msgSeq: number, partSeq: number, time: number, data: object): void {
  d.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`${sid}#${msgSeq}:${partSeq}`, `${sid}#${msgSeq}`, sid, time, time, JSON.stringify(data), partSeq)
}

function insertUsage(d: DatabaseSync, sid: string, callId: string, startedAt: number): void {
  d.prepare("INSERT INTO tool_usage (id, session_id, tool_call_id, tool_name, status, started_at) VALUES (?, ?, ?, ?, 'completed', ?)")
    .run(callId, sid, callId, TOOL, startedAt)
}

const callPart = (callId: string, title: string, text: string, partSeq: number) => ({
  type: 'tool', callID: callId, blockIndex: partSeq, tool: TOOL, metadata: {},
  state: { status: 'completed', input: { title, text }, output: '{"ok":true}' },
})
const resultPart = (output: string, partSeq: number) => ({
  type: 'tool', callID: 'call_res', blockIndex: partSeq, tool: TOOL, metadata: {},
  state: { status: 'completed', input: { title: TITLE, text: TEXT }, output },
})
const textPart = (text: string, partSeq: number) => ({ type: 'text', text, blockIndex: partSeq, time: NOW })
const reasoningPart = (text: string, partSeq: number) => ({ type: 'reasoning', text, blockIndex: partSeq, time: NOW })

/** 主会话：两轮对话，第二轮里发起 memory_save（当轮起点 = seq 2，最大 seq 5）。 */
function seedMainTurn(d: DatabaseSync, sid: string): void {
  insertMessage(d, sid, 0, NOW - 6000, { role: 'user', time: NOW - 6000, agent: 'build' })
  insertPart(d, sid, 0, 0, NOW - 6000, textPart('第一轮：部署脚本在哪', 0))
  insertMessage(d, sid, 1, NOW - 5000, { role: 'assistant', time: NOW - 5000 })
  insertPart(d, sid, 1, 0, NOW - 5000, reasoningPart('先答位置', 0))
  insertPart(d, sid, 1, 1, NOW - 5000, textPart('部署脚本在 scripts/deploy.sh', 1))
  insertMessage(d, sid, 2, NOW - 4000, { role: 'user', time: NOW - 4000, agent: 'build' })
  insertPart(d, sid, 2, 0, NOW - 4000, textPart('第二轮：帮我记一条', 0))
  insertMessage(d, sid, 3, NOW - 3000, { role: 'assistant', time: NOW - 3000 })
  insertPart(d, sid, 3, 0, NOW - 3000, reasoningPart('调 memory_save', 0))
  insertPart(d, sid, 3, 1, NOW - 3000, textPart('好的，这就记', 1))
  insertPart(d, sid, 3, 2, NOW - 3000, callPart('call_a1', TITLE, TEXT, 2))
  insertMessage(d, sid, 4, NOW - 2000, { role: 'user', time: NOW - 2000, synthetic: true })
  insertPart(d, sid, 4, 0, NOW - 2000, resultPart('{"ok":true,"id":"mem_x1"}', 0))
  insertMessage(d, sid, 5, NOW - 1000, { role: 'assistant', time: NOW - 1000 })
  insertPart(d, sid, 5, 0, NOW - 1000, textPart('已经记好了', 0))
  insertUsage(d, sid, 'call_a1', NOW - 900)
}

/** 十一分钟前的老调用（时间窗之外）。 */
function seedOldCall(d: DatabaseSync, sid: string): void {
  const t = NOW - 11 * 60 * 1000
  insertMessage(d, sid, 0, t, { role: 'user', time: t })
  insertPart(d, sid, 0, 0, t, textPart('老的请求', 0))
  insertMessage(d, sid, 1, t + 1000, { role: 'assistant', time: t + 1000 })
  insertPart(d, sid, 1, 0, t + 1000, callPart('call_b1', '老记忆', '十一分钟前的调用文本', 0))
  insertUsage(d, sid, 'call_b1', t + 1500)
}

/** 近十分钟内有近似调用（text 差一截），不许串锚。 */
function seedNearMiss(d: DatabaseSync, sid: string): void {
  insertMessage(d, sid, 0, NOW - 3000, { role: 'user', time: NOW - 3000 })
  insertPart(d, sid, 0, 0, NOW - 3000, textPart('近似请求', 0))
  insertMessage(d, sid, 1, NOW - 2500, { role: 'assistant', time: NOW - 2500 })
  insertPart(d, sid, 1, 0, NOW - 2500, callPart('call_c1', TITLE, `${TEXT}，另外端口还备了 8080`, 0))
  insertUsage(d, sid, 'call_c1', NOW - 2400)
}

/** 没有任何真实用户消息的会话（后台型）：起点取 0。 */
function seedWithoutUserTurn(d: DatabaseSync, sid: string): void {
  insertMessage(d, sid, 0, NOW - 2000, { role: 'user', time: NOW - 2000, synthetic: true })
  insertPart(d, sid, 0, 0, NOW - 2000, resultPart('{"ok":true}', 0))
  insertMessage(d, sid, 1, NOW - 1500, { role: 'assistant', time: NOW - 1500 })
  insertPart(d, sid, 1, 0, NOW - 1500, callPart('call_d1', '后台锚', '后台任务写入的文本', 0))
  insertUsage(d, sid, 'call_d1', NOW - 1400)
}

const anchorA: SourceAnchor = { sessionId: `zcode:${SID_A}`, eventRange: [2, 5] }

describe('定位（写入侧）', () => {
  it('全等命中：锚指向该会话，起点是当轮首条用户消息、终点是当前最大 sequence', async () => {
    const adapter = createZcodeAnchorAdapter({ zcodeDir })
    expect(await adapter.locateCall({ title: TITLE, text: TEXT }, NOW)).toEqual({
      sessionId: `zcode:${SID_A}`, eventRange: [2, 5],
    })
  })
  it('title 或 text 差一个字就不认', async () => {
    const adapter = createZcodeAnchorAdapter({ zcodeDir })
    expect(await adapter.locateCall({ title: TITLE, text: `${TEXT}。` }, NOW)).toBeUndefined()
    expect(await adapter.locateCall({ title: '部署端口x', text: TEXT }, NOW)).toBeUndefined()
  })
  it('只找近十分钟：老调用在窗内能找到、出窗就找不到；近旁的近似调用不串锚', async () => {
    const adapter = createZcodeAnchorAdapter({ zcodeDir })
    const t = NOW - 11 * 60 * 1000
    expect(await adapter.locateCall({ title: '老记忆', text: '十一分钟前的调用文本' }, t + 2000)).toEqual({
      sessionId: `zcode:${SID_B}`, eventRange: [0, 1],
    })
    expect(await adapter.locateCall({ title: '老记忆', text: '十一分钟前的调用文本' }, NOW)).toBeUndefined()
    expect(await adapter.locateCall({ title: TITLE, text: `${TEXT}，另外端口还备了 8080` }, NOW)).toEqual({
      sessionId: `zcode:${SID_C}`, eventRange: [0, 1],
    })
  })
  it('当轮没有真实用户消息时起点取 0（整会话锚兜底）', async () => {
    const adapter = createZcodeAnchorAdapter({ zcodeDir })
    expect(await adapter.locateCall({ title: '后台锚', text: '后台任务写入的文本' }, NOW)).toEqual({
      sessionId: `zcode:${SID_D}`, eventRange: [0, 1],
    })
  })
  it('经调度器出锚并记一行日志', async () => {
    const lines: string[] = []
    const locator = createAnchorLocator({ zcodeDir, log: l => lines.push(l) })
    const anchor = await locator.locate({ title: TITLE, text: TEXT })
    expect(anchor?.sessionId).toBe(`zcode:${SID_A}`)
    expect(lines.some(l => l === `锚定 zcode:${SID_A} [2, 5]`)).toBe(true)
  })
  it('库结构变了：适配器抛错、定位回 undefined，调度器只警告一次', async () => {
    const broken = join(root, 'broken')
    const d = await buildDb(broken)
    d.exec('DROP TABLE tool_usage')
    d.close()
    const adapter = createZcodeAnchorAdapter({ zcodeDir: broken })
    await expect(adapter.locateCall({ title: TITLE, text: TEXT }, NOW)).rejects.toThrow()
    const lines: string[] = []
    const locator = createAnchorLocator({ zcodeDir: broken, retryDelaysMs: [1, 1], log: l => lines.push(l) })
    await expect(locator.locate({ title: TITLE, text: TEXT })).resolves.toBeUndefined()
    expect(lines.filter(l => l.includes('只警告一次'))).toHaveLength(1)
    expect(lines.at(-1)).toContain('未定位')
  })
})

describe('开窗（回查侧）', () => {
  it('默认宽度覆盖区间并前读 2 条上下文；reasoning 计入 skipped；工具调用与结果都标 tool', async () => {
    const win = await createZcodeAnchorAdapter({ zcodeDir }).readWindow(anchorA)
    expect(win.range).toEqual([0, 5])
    expect(win.skipped).toBe(2)
    expect(win.events).toEqual([
      { seq: 0, role: 'user', text: '第一轮：部署脚本在哪' },
      { seq: 1, role: 'assistant', text: '部署脚本在 scripts/deploy.sh' },
      { seq: 2, role: 'user', text: '第二轮：帮我记一条' },
      { seq: 3, role: 'assistant', text: '好的，这就记' },
      { seq: 3, role: 'tool', text: `调用 ${TOOL}` },
      { seq: 4, role: 'tool', text: '{"ok":true,"id":"mem_x1"}' },
      { seq: 5, role: 'assistant', text: '已经记好了' },
    ])
  })
  it('window 收窄窗口', async () => {
    const win = await createZcodeAnchorAdapter({ zcodeDir }).readWindow(anchorA, 1)
    expect(win.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 3])
  })
  it('超过 400 字的可读文本截断', async () => {
    const sid = SID_F
    insertMessage(db, sid, 0, NOW, { role: 'assistant', time: NOW })
    insertPart(db, sid, 0, 0, NOW, textPart('x'.repeat(500), 0))
    const win = await createZcodeAnchorAdapter({ zcodeDir })
      .readWindow({ sessionId: `zcode:${sid}`, eventRange: [0, 0] })
    expect(win.events).toHaveLength(1)
    expect(win.events[0]!.text).toBe(`${'x'.repeat(400)}…`)
    expect(win.events[0]!.text).toHaveLength(401)
  })
  it('可读事件封顶 24，超出的不渲染', async () => {
    for (let i = 0; i < 30; i++) {
      insertMessage(db, SID_F, i + 100, NOW + i, { role: 'assistant', time: NOW + i })
      insertPart(db, SID_F, i + 100, 0, NOW + i, textPart(`消息${i}`, 0))
    }
    const win = await createZcodeAnchorAdapter({ zcodeDir })
      .readWindow({ sessionId: `zcode:${SID_F}`, eventRange: [100, 129] })
    expect(win.events).toHaveLength(24)
    expect(win.events.at(-1)).toMatchObject({ seq: 123 })
    expect(win.range).toEqual([100, 123])
  })
  it('形状不对的 id 直接拒绝，不碰库；没前缀的也不是本适配器的事', async () => {
    const adapter = createZcodeAnchorAdapter({ zcodeDir })
    await expect(adapter.readWindow({ sessionId: 'zcode:../../etc', eventRange: [0, 0] })).rejects.toThrow('形状不认识')
    await expect(adapter.readWindow({ sessionId: 'zcode:sess_nothex', eventRange: [0, 0] })).rejects.toThrow('形状不认识')
    await expect(adapter.readWindow({ sessionId: SID_A, eventRange: [0, 0] })).rejects.toThrow('不是 ZCode 锚')
  })
  it('会话不存在（已删除或不在这台机器上）', async () => {
    const ghost = 'sess_00000000-0000-4000-8000-000000000000'
    await expect(createZcodeAnchorAdapter({ zcodeDir }).readWindow({ sessionId: `zcode:${ghost}`, eventRange: [0, 0] }))
      .rejects.toThrow('没有这个会话')
  })
})

describe('旁路文件卫生', () => {
  it('没有旁路文件时按 immutable 打开：定位与开窗后目录里只有库文件', async () => {
    const adapter = createZcodeAnchorAdapter({ zcodeDir })
    await adapter.locateCall({ title: TITLE, text: TEXT }, NOW)
    await adapter.readWindow(anchorA)
    expect(await readdir(join(zcodeDir, 'db'))).toEqual(['db.sqlite'])
  })
  it('有 -wal 时按普通只读打开：不新建文件、已有的旁路文件原样保留', async () => {
    const dir = join(root, 'walzcode')
    const d = await buildDb(dir)
    d.exec('PRAGMA journal_mode=wal')
    // WAL 模式下旁路文件在一次写入后才出现（真实 ZCode 是持续写入所以常在）
    d.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('sess_abcdef01-2345-4789-8abc-def012345678', 'proj', 'slug', '/tmp/proj', '会话', '1.0', ?, ?)")
      .run(NOW, NOW)
    const dbDir = join(dir, 'db')
    const before = (await readdir(dbDir)).sort()
    expect(before).toContain('db.sqlite-wal')
    const adapter = createZcodeAnchorAdapter({ zcodeDir: dir })
    await adapter.locateCall({ title: 'x', text: 'y' }, NOW)
    expect((await readdir(dbDir)).sort()).toEqual(before)
    d.close()
    await rm(dir, { recursive: true, force: true })
  })
  it('竞态空壳：关闭后冒出来的 0 字节 -wal 清掉，非空的是并发写入者的、整套不动', async () => {
    const dir = join(root, 'sweep')
    await mkdir(dir, { recursive: true })
    const dbPath = join(dir, 'db.sqlite')
    await writeFile(dbPath, 'x')
    const wal = `${dbPath}-wal`
    const shm = `${dbPath}-shm`
    await writeFile(wal, '')
    await writeFile(shm, '')
    await sweepOwnSidecars(dbPath, { wal: false, shm: false })
    expect(existsSync(wal)).toBe(false)
    expect(existsSync(shm)).toBe(false)
    await writeFile(wal, 'not-empty')
    await writeFile(shm, '')
    await sweepOwnSidecars(dbPath, { wal: false, shm: false })
    expect(existsSync(wal)).toBe(true)
    expect(existsSync(shm)).toBe(true)
    await sweepOwnSidecars(dbPath, { wal: true, shm: false })
    expect(existsSync(wal)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })
})
