import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAnchorLocator, type SourceAnchor } from '../src/tools/anchor.ts'
import { createAntigravityAnchorAdapter, antigravityBrainPath } from '../src/tools/anchor-antigravity.ts'

// Antigravity 锚适配器：按 Task 0 实测的真实行形状（call_mcp_tool 包装 + Arguments JSON 字符串）
// 造临时转写，守定位的全等规则、ToolName 过滤、截断退避、时间窗与开窗的方向/上限/跳过计数。

const FIXTURE = fileURLToPath(new URL('./fixtures/antigravity-transcript.jsonl', import.meta.url))
const NOW = 1_800_000_000_000
const UUID = 'c0ffee00-1234-4000-8000-000000000042'
const UUID2 = 'deadbeef-5678-4000-8000-000000000099'
const TITLE = '部署端口'
const TEXT = '部署脚本的端口是 8443，落在 gate 主机'
const fixtureContent = await readFile(FIXTURE, 'utf8')

let root: string
let brain: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-anchor-ag-'))
  brain = antigravityBrainPath(join(root, 'ag'))
  await mkdir(brain, { recursive: true })
  await seedTranscript(UUID, fixtureContent, NOW - 2000)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function seedTranscript(id: string, content: string, mtimeMs: number): Promise<void> {
  const path = join(brain, id, '.system_generated', 'logs', 'transcript.jsonl')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  // utimes 以秒为单位
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000)
}

/** 造一步 PLANNER_RESPONSE 的 JSONL 行（按实测形状：call_mcp_tool + Arguments/ServerName/ToolName 都是 JSON 字符串）。 */
function plannerLine(stepIndex: number, toolName: string, argsObject: object): string {
  return JSON.stringify({
    step_index: stepIndex, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    created_at: '2026-11-26T11:01:02Z', content: null, thinking: '调工具',
    tool_calls: [{
      name: 'call_mcp_tool',
      args: { Arguments: JSON.stringify(argsObject), ServerName: JSON.stringify('plastic-memory'), ToolName: JSON.stringify(toolName) },
    }],
    truncated_fields: null,
  })
}

const userLine = (stepIndex: number, text: string): string => JSON.stringify({
  step_index: stepIndex, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
  created_at: '2026-11-26T11:01:00Z', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`, model: null, truncated_fields: null,
})

const anchorFixture: SourceAnchor = { sessionId: `antigravity:${UUID}`, eventRange: [4, 7] }

describe('定位（写入侧）', () => {
  it('全等命中：锚指向该会话，起点是命中行前最近的 USER_INPUT、终点是文件最大 step_index', async () => {
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    expect(await adapter.locateCall({ title: TITLE, text: TEXT }, NOW)).toEqual(anchorFixture)
  })
  it('title 或 text 差一个字就不认', async () => {
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    expect(await adapter.locateCall({ title: TITLE, text: `${TEXT}。` }, NOW)).toBeUndefined()
    expect(await adapter.locateCall({ title: '部署端口x', text: TEXT }, NOW)).toBeUndefined()
  })
  it('只看近十分钟改动过的转写：出窗就找不到', async () => {
    await seedTranscript(UUID, fixtureContent, NOW - 11 * 60 * 1000)
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    expect(await adapter.locateCall({ title: TITLE, text: TEXT }, NOW)).toBeUndefined()
    expect(await adapter.locateCall({ title: TITLE, text: TEXT }, NOW - 10 * 60 * 1000 + 3000)).toEqual(anchorFixture)
  })
  it('多个候选时最新的改动优先', async () => {
    await seedTranscript(UUID2, fixtureContent, NOW - 500)
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    expect(await adapter.locateCall({ title: TITLE, text: TEXT }, NOW))
      .toEqual({ sessionId: `antigravity:${UUID2}`, eventRange: [4, 7] })
  })
  it('ToolName 过滤：memory_search 的调用即使 title/text 字段相同也不认', async () => {
    await seedTranscript(UUID2, [
      userLine(0, '带相同字段的检索'),
      plannerLine(1, 'memory_search', { title: TITLE, text: TEXT, query: '' }),
    ].join('\n'), NOW - 500)
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    expect(await adapter.locateCall({ title: TITLE, text: TEXT }, NOW)).toEqual(anchorFixture) // 命中的仍是 fixture 那次 memory_save
    const only = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag-empty') })
    expect(await only.locateCall({ title: TITLE, text: TEXT }, NOW)).toBeUndefined()
  })
  it('Arguments 被截断（解析不出）退回转义子串比对：title 全等 + text 前 120 字', async () => {
    const longText = '长'.repeat(200)
    // 模拟截断：Arguments 是被切断的半截 JSON（title 完整、text 只剩前 130 字）
    const truncatedArguments = `{"title":${JSON.stringify(TITLE)},"text":${JSON.stringify(longText.slice(0, 130))}`
    const line = JSON.stringify({
      step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
      created_at: '2026-11-26T11:01:02Z', content: null,
      tool_calls: [{ name: 'call_mcp_tool', args: { Arguments: truncatedArguments, ToolName: JSON.stringify('memory_save') } }],
      truncated_fields: ['args'],
    })
    await seedTranscript(UUID2, [userLine(0, '长文本的保存'), line].join('\n'), NOW - 500)
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    // 退避只验 title + 前 120 字：前 120 字相同的长文本也命中（这是设计取舍），前 120 字不同的不命中
    expect(await adapter.locateCall({ title: TITLE, text: longText }, NOW))
      .toEqual({ sessionId: `antigravity:${UUID2}`, eventRange: [0, 1] })
    expect(await adapter.locateCall({ title: TITLE, text: `${'短'.repeat(120)}` }, NOW)).toBeUndefined()
  })
  it('经调度器出锚并记一行日志', async () => {
    const lines: string[] = []
    const locator = createAnchorLocator({ antigravityDir: join(root, 'ag'), log: l => lines.push(l) })
    const anchor = await locator.locate({ title: TITLE, text: TEXT })
    expect(anchor).toEqual(anchorFixture)
    expect(lines.some(l => l === `锚定 antigravity:${UUID} [4, 7]`)).toBe(true)
  })
})

describe('开窗（回查侧）', () => {
  it('默认宽度覆盖区间并前读 2 步：USER_REQUEST 提正文、PLANNER 列调用名、GENERIC 标 tool、结构步骤计入 skipped', async () => {
    const win = await createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') }).readWindow(anchorFixture)
    expect(win.range).toEqual([2, 6])
    expect(win.skipped).toBe(2)
    expect(win.events).toEqual([
      { seq: 2, role: 'tool', text: '检索结果：没有主题重复的记忆。' },
      { seq: 4, role: 'user', text: '第二轮：把端口这条正式记下来' },
      { seq: 5, role: 'assistant', text: '调用 memory_save' },
      { seq: 6, role: 'tool', text: '{"ok": true, "kind": "saved", "id": "mem_fixture"}' },
    ])
  })
  it('window 收窄窗口', async () => {
    const win = await createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') }).readWindow(anchorFixture, 1)
    expect(win.events.map(e => e.seq)).toEqual([2, 4, 5])
    expect(win.skipped).toBe(1)
  })
  it('PLANNER 带正文时取正文当 assistant 行', async () => {
    const withContent = [
      userLine(0, '问题'),
      JSON.stringify({
        step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-11-26T11:01:02Z',
        content: '我先答结论，再调工具。', tool_calls: [{ name: 'call_mcp_tool', args: { ToolName: JSON.stringify('memory_search') } }],
      }),
    ].join('\n')
    await seedTranscript(UUID2, withContent, NOW - 500)
    const win = await createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
      .readWindow({ sessionId: `antigravity:${UUID2}`, eventRange: [0, 1] })
    expect(win.events).toEqual([
      { seq: 0, role: 'user', text: '问题' },
      { seq: 1, role: 'assistant', text: '我先答结论，再调工具。' },
    ])
  })
  it('超过 400 字的可读文本截断', async () => {
    await seedTranscript(UUID2, [userLine(0, 'x'.repeat(500))].join('\n'), NOW - 500)
    const win = await createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
      .readWindow({ sessionId: `antigravity:${UUID2}`, eventRange: [0, 0] })
    expect(win.events).toHaveLength(1)
    expect(win.events[0]!.text).toBe(`${'x'.repeat(400)}…`)
  })
  it('可读事件封顶 24，超出的不渲染', async () => {
    const lines: string[] = []
    for (let i = 0; i < 30; i++) lines.push(userLine(i, `消息${i}`))
    await seedTranscript(UUID2, lines.join('\n'), NOW - 500)
    const win = await createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
      .readWindow({ sessionId: `antigravity:${UUID2}`, eventRange: [0, 29] })
    expect(win.events).toHaveLength(24)
    expect(win.events.at(-1)).toMatchObject({ seq: 23 })
    expect(win.range).toEqual([0, 23])
  })
  it('形状不对的 id 直接拒绝，不碰文件；存在与否再分两种 unavailable', async () => {
    const adapter = createAntigravityAnchorAdapter({ antigravityDir: join(root, 'ag') })
    await expect(adapter.readWindow({ sessionId: 'antigravity:not-a-uuid', eventRange: [0, 0] })).rejects.toThrow('形状不认识')
    await expect(adapter.readWindow({ sessionId: 'sess_c0ffee00-1234-4000-8000-000000000042', eventRange: [0, 0] })).rejects.toThrow('不是 Antigravity 锚')
    const ghost = 'c0ffee00-1234-4000-8000-000000000043'
    await expect(adapter.readWindow({ sessionId: `antigravity:${ghost}`, eventRange: [0, 0] })).rejects.toThrow('没有这个会话')
  })
})
