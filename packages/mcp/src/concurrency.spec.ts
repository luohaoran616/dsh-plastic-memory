import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createMemoryCore, type MemoryCore } from '@plastic/core/factory.ts'
import type { MemoryRecord } from '@plastic/core/record-schema.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { workspaceDirName } from '@plastic/core/storage/paths.ts'

// Review Focus #1 / #2 的两个钉子测试：真 node:sqlite 写锁、真临时记忆根、真 plastic-mcp 子进程。
// 锁协议不在这里重造：两进程用的都是 core 的 <root>/.state/lock/write-lock.sqlite 上的 BEGIN IMMEDIATE。

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROJECT = '/proj/concurrent'
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
for (const key of ['PLASTIC_MEMORY_ROOT', 'PLASTIC_CLIENT', 'PLASTIC_PROJECT', 'PLASTIC_MCP_TEST_HOLD_LOCK']) delete baseEnv[key]

const silentLog: MemoryLogger = { info() {}, warn() {}, error() {} }
const WRITES_PER_SIDE = 20

interface ChildServer {
  client: Client
  transport: StdioClientTransport
  /** 子进程被回收（transport 的 close 回调）时 resolve：kill -9 之后据此确认锁已由操作系统释放。 */
  closed: Promise<void>
}

const children: ChildServer[] = []
const cores: MemoryCore[] = []
const tempDirs: string[] = []

async function startChild(env: Record<string, string>): Promise<ChildServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    cwd: PACKAGE_ROOT,
    env: { ...baseEnv, ...env },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => { /* 告警只进 stderr；用例不依赖内容 */ })
  const client = new Client({ name: 'plastic-mcp-concurrency-spec', version: '0.0.0' })
  await client.connect(transport)
  let markClosed!: () => void
  const closed = new Promise<void>(resolve => { markClosed = resolve })
  client.onclose = () => markClosed()
  const child = { client, transport, closed }
  children.push(child)
  return child
}

async function startCore(root: string): Promise<MemoryCore> {
  const core = await createMemoryCore({ root, client: 'host', log: silentLog })
  cores.push(core)
  return core
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  // SDK 的 callTool 返回联合类型（普通结果 / task 结果），按普通 CallToolResult 收窄
  const result = await client.callTool({ name, arguments: args }) as unknown as {
    content: Array<{ type: string; text?: string }>
    isError?: boolean
  }
  const block = result.content[0]
  if (result.isError === true || block === undefined || block.type !== 'text' || block.text === undefined) {
    throw new Error(`${name} 调用失败：${JSON.stringify(result)}`)
  }
  return JSON.parse(block.text) as T
}

/** 跨进程信号文件：一个文件名就是一个一次性事件。等的是条件，不是时长。 */
async function waitForSignal(dir: string, name: string): Promise<void> {
  const path = join(dir, name)
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

function record(id: string, partial: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, name: '并发记录', type: 'knowledge', scope: 'workspace', workspacePath: PROJECT,
    tags: [], content: '正文', summary: '摘要',
    source: { sessionId: 'host', eventRange: [0, 0], sourceMode: 'user-explicit' },
    createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null, recallCount: 0,
    status: 'active', confidence: 0.9, ...partial,
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) await child.client.close().catch(() => {})
  for (const core of cores.splice(0)) await core.close().catch(() => {})
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('跨进程并发与崩溃恢复', () => {
  it('同 root 下一个 core 实例 + 一个 plastic-mcp 子进程各写 20 条：全部成功、互不覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-concurrent-'))
    tempDirs.push(root)
    const core = await startCore(root)
    const child = await startChild({ PLASTIC_MEMORY_ROOT: root, PLASTIC_CLIENT: 'zcode', PLASTIC_PROJECT: PROJECT })

    // 两侧用同样的标题，把「同名文件」也压进并发场景：core 的排他占名应追加 id 片段，不覆盖对方的文件。
    const titles = Array.from({ length: WRITES_PER_SIDE }, (_, i) => `并发 note ${i}`)
    const hostIds = titles.map((_, i) => `mem_host_${i}`)
    const hostWrites = titles.map((title, i) => core.store.create(record(hostIds[i]!, {
      name: title, content: `host-${i}`, summary: `host 摘要 ${i}`,
    })))
    const mcpWrites = titles.map((title, i) => callJson<{ id: string; path: string }>(child.client, 'memory_save', {
      title, text: `mcp-${i}`, project: PROJECT, origin: 'model-observed',
    }))
    const [, mcpRecords] = await Promise.all([Promise.all(hostWrites), Promise.all(mcpWrites)])

    expect(mcpRecords).toHaveLength(WRITES_PER_SIDE)
    const ids = new Set([...hostIds, ...mcpRecords.map(r => r.id)])
    expect(ids.size).toBe(WRITES_PER_SIDE * 2)

    // 40 条全部可读回，内容各自正确（没有任何一笔被对方的写入覆盖）
    for (let i = 0; i < WRITES_PER_SIDE; i++) {
      expect((await core.store.get(`mem_host_${i}`, { workspacePath: PROJECT }))?.content).toBe(`host-${i}`)
      expect((await core.store.get(mcpRecords[i]!.id, { workspacePath: PROJECT }))?.content).toBe(`mcp-${i}`)
    }

    // 同一项目目录里 40 个记忆文件：同名标题没有互相覆盖
    const dir = join(root, workspaceDirName(PROJECT))
    const files = (await readdir(dir)).filter(name => name.endsWith('.md') && name !== 'MEMORY.md')
    expect(files).toHaveLength(WRITES_PER_SIDE * 2)

    // 子进程侧检索也看到全部 40 条（两边写进的是同一个记忆根、同一个作用域）
    const searched = await callJson<{ hits: Array<{ id: string }> }>(child.client, 'memory_search', {
      query: '并发', project: PROJECT, topK: 100,
    })
    expect(searched.hits.map(hit => hit.id).sort()).toEqual([...ids].sort())
  }, 60_000)

  it('子进程持锁时被 kill -9：主实例下一笔写入立即成功（< 1s），无 stale lock 等待', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-crash-'))
    const signals = await mkdtemp(join(tmpdir(), 'pm-mcp-crash-signals-'))
    tempDirs.push(root, signals)
    const core = await startCore(root)
    // 预热：先把锁库、workspace 目录、索引与侧表都建起来，下面测的才是「kill 之后的下一笔」而不是首次写入的初始化开销
    await core.store.create(record('mem_before_kill', { name: '预热写入', content: '预热' }))
    // PLASTIC_MCP_TEST_HOLD_LOCK：测试专用钩子。memory_save 落盘成功后，子进程在同一把记忆根写锁内写 held，
    // 等 go 才返回（用例不发 go，要的是它持锁时被 kill）。持锁事实由 held 文件确定性证明，不靠 sleep 竞态。
    const child = await startChild({
      PLASTIC_MEMORY_ROOT: root, PLASTIC_CLIENT: 'zcode', PLASTIC_PROJECT: PROJECT,
      PLASTIC_MCP_TEST_HOLD_LOCK: signals,
    })

    // 真实 MCP stdio 请求：写入一条记录，然后在锁内停住。响应永远不会回来（进程会被杀），只等它落定。
    const pending = callJson<{ id: string }>(child.client, 'memory_save', {
      title: '持锁记录', text: '锁内等待', project: PROJECT, origin: 'user-stated',
    }).catch((err: unknown) => err)
    await waitForSignal(signals, 'held')

    const pid = child.transport.pid
    expect(pid).not.toBeNull()
    process.kill(pid!, 'SIGKILL')
    // 子进程被回收后再写：锁由操作系统释放，不与用例自己的等待竞速
    await child.closed
    await pending

    const started = performance.now()
    await core.store.create(record('mem_after_kill', { name: 'kill -9 之后的写入', content: '立即成功' }))
    const elapsed = performance.now() - started
    expect(elapsed, `kill -9 之后首笔写入耗时 ${elapsed.toFixed(1)}ms`).toBeLessThan(1000)
    expect((await core.store.get('mem_after_kill', { workspacePath: PROJECT }))?.content).toBe('立即成功')
  }, 60_000)
})
