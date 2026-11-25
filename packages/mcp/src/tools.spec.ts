import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { splitFrontmatter } from '@plastic/core/storage/frontmatter.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '@plastic/core/storage/paths.ts'

// 真子进程 + 真 stdio：用例起的是 packages/mcp/src/bin.ts 本身，按 MCP 协议走 StdioClientTransport，
// 不调内部函数。Node 内置类型剥离直接跑 .ts（与仓库 tests/helpers/spawn-worker.ts 同一办法）。

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 外层环境只借 HOME/PATH 这类必要变量：PLASTIC_* 一律由用例显式给，避免宿主 shell 的同名变量串进断言。 */
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>
for (const key of ['PLASTIC_MEMORY_ROOT', 'PLASTIC_CLIENT', 'PLASTIC_PROJECT', 'PLASTIC_MCP_TEST_HOLD_LOCK']) delete baseEnv[key]

interface RunningServer {
  client: Client
  root: string
  /** 子进程 stderr 到目前为止的全部内容（协议通道外的日志应只出现在这里）。 */
  stderr: () => string
}

const servers: RunningServer[] = []
const tempDirs: string[] = []

async function startServer(options: { root?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<RunningServer> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'pm-mcp-tools-'))
  if (options.root === undefined) tempDirs.push(root)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: { ...baseEnv, PLASTIC_MEMORY_ROOT: root, PLASTIC_CLIENT: 'zcode', ...options.env },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
  const client = new Client({ name: 'plastic-mcp-tools-spec', version: '0.0.0' })
  await client.connect(transport)
  const server = { client, root, stderr: () => stderr }
  servers.push(server)
  return server
}

/** 调一个工具并把第一段文本解析成 JSON；isError 或非文本块直接抛，免得断言在空值上噪声失败。 */
async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
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

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** 直接跑 bin（不经 MCP 客户端）：用于「配置缺失直接退出」这类启动期断言。 */
function runBin(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN], { cwd: PACKAGE_ROOT, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
  })
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.client.close().catch(() => {})
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface MemorySaveResult { id: string; path: string }
interface MemorySearchResult { hits: Array<{ id: string; title: string; summary: string; path: string }> }
/** 记忆根里的文件清单（相对路径 + 大小 + mtime）：只读体检前后应逐字相同。 */
async function treeOf(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }) as string[]
  const rows = await Promise.all(entries.sort().map(async entry => {
    const s = await stat(join(dir, entry))
    return `${entry}:${s.isFile() ? s.size : 'dir'}:${s.mtimeMs}`
  }))
  return rows
}

/** 手写一条记忆文件（frontmatter + 正文），用来给只读体检造现场。 */
function memoryFile(frontmatter: string[], body: string): string {
  return `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`
}

interface MemoryRecordView {
  id: string
  title: string
  text: string
  type: string
  scope: 'global' | 'workspace'
  workspacePath?: string
  summary: string
  status: string
  confidence: number
  path: string
  source?: { sessionId: string; eventRange: [number, number]; sourceMode: string }
}

describe('MCP 工具面（D2）', () => {
  it('stdio 连接后列出的工具恰为 D2 五个名字，输入面与 D2 一字不差', async () => {
    const { client } = await startServer()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'memory_forget', 'memory_health', 'memory_read', 'memory_save', 'memory_search',
    ])
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const tool of tools) expect(tool.description?.trim().length ?? 0).toBeGreaterThan(0)

    const schemaOf = (name: string) => byName.get(name)!.inputSchema as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(Object.keys(schemaOf('memory_save').properties ?? {}).sort()).toEqual(['origin', 'project', 'text', 'title', 'type'])
    expect(schemaOf('memory_save').required?.slice().sort()).toEqual(['origin', 'text', 'title'])
    expect(Object.keys(schemaOf('memory_search').properties ?? {}).sort()).toEqual(['project', 'query', 'topK'])
    expect(schemaOf('memory_search').required).toEqual(['query'])
    expect(Object.keys(schemaOf('memory_read').properties ?? {})).toEqual(['id'])
    expect(schemaOf('memory_read').required).toEqual(['id'])
    expect(Object.keys(schemaOf('memory_forget').properties ?? {})).toEqual(['id'])
    expect(schemaOf('memory_forget').required).toEqual(['id'])
    expect(Object.keys(schemaOf('memory_health').properties ?? {})).toEqual([])
  })

  it('memory_save → memory_search → memory_read 往返；frontmatter 带 mcp 来源与派生 summary', async () => {
    const server = await startServer()
    const text = '第一行摘要\n第二行正文细节'
    const saved = await callJson<MemorySaveResult>(server.client, 'memory_save', {
      title: '包管理用 pnpm', text, origin: 'user-stated',
    })
    expect(saved.id).toMatch(/^mem_/)

    const written = splitFrontmatter(await readFile(saved.path, 'utf8'))
    expect(written.body).toBe(text)
    expect(written.data).toMatchObject({
      id: saved.id,
      name: '包管理用 pnpm',
      type: 'knowledge',
      summary: '第一行摘要',
      status: 'active',
      confidence: 0.9,
      source: { sessionId: 'mcp:zcode', eventRange: [0, 0], sourceMode: 'user-explicit' },
    })
    expect(written.data['needs-promote-review']).toBeUndefined()

    const searched = await callJson<MemorySearchResult>(server.client, 'memory_search', { query: 'pnpm' })
    expect(searched.hits).toEqual([{ id: saved.id, title: '包管理用 pnpm', summary: '第一行摘要', path: saved.path }])

    const read = await callJson<MemoryRecordView>(server.client, 'memory_read', { id: saved.id })
    expect(read).toMatchObject({
      id: saved.id,
      title: '包管理用 pnpm',
      text,
      type: 'knowledge',
      scope: 'workspace',
      workspacePath: PACKAGE_ROOT,
      summary: '第一行摘要',
      status: 'active',
      confidence: 0.9,
      path: saved.path,
      source: { sessionId: 'mcp:zcode', eventRange: [0, 0], sourceMode: 'user-explicit' },
    })
  })

  it('memory_search 的 topK 缺省 8、可覆盖', async () => {
    const { client } = await startServer()
    for (let i = 0; i < 10; i++) {
      await callJson(client, 'memory_save', { title: `alpha note ${i}`, text: `alpha 正文 ${i}`, origin: 'model-observed' })
    }
    expect((await callJson<MemorySearchResult>(client, 'memory_search', { query: 'alpha' })).hits).toHaveLength(8)
    expect((await callJson<MemorySearchResult>(client, 'memory_search', { query: 'alpha', topK: 3 })).hits).toHaveLength(3)
  })

  it('origin 映射 sourceMode 与置信上限：model-observed → environment-observed / 0.8', async () => {
    const { client } = await startServer()
    const saved = await callJson<MemorySaveResult>(client, 'memory_save', {
      title: '观察到的环境事实', text: '这台机器的包管理器是 pnpm', origin: 'model-observed',
    })
    const read = await callJson<MemoryRecordView>(client, 'memory_read', { id: saved.id })
    expect(read.source).toEqual({ sessionId: 'mcp:zcode', eventRange: [0, 0], sourceMode: 'environment-observed' })
    expect(read.confidence).toBe(0.8)

    const invalid = await client.callTool({ name: 'memory_save', arguments: { title: 't', text: 'x', origin: 'user-guessed' } })
    expect(invalid.isError).toBe(true)
  })

  it('memory_forget 只走软删：文件进 .archive/，memory_read 返回已删状态', async () => {
    const { client } = await startServer()
    const saved = await callJson<MemorySaveResult>(client, 'memory_save', {
      title: '将被遗忘的记录', text: '可恢复的正文', origin: 'user-stated',
    })
    await expect(readFile(saved.path, 'utf8')).resolves.toContain('可恢复的正文')

    expect(await callJson(client, 'memory_forget', { id: saved.id })).toEqual({ ok: true })
    const read = await callJson<MemoryRecordView>(client, 'memory_read', { id: saved.id })
    expect(read.status).toBe('deleted')
    expect(read.path).toContain(`${sep}.archive${sep}`)
    expect(splitFrontmatter(await readFile(read.path, 'utf8')).data).toMatchObject({ id: saved.id, status: 'deleted' })

    expect(await callJson(client, 'memory_forget', { id: 'mem_not_there' })).toEqual({ ok: false })
  })

  it('project 入参决定 workspace 作用域；缺省按 PLASTIC_PROJECT（未配置时按进程 cwd）推导', async () => {
    const { client, root } = await startServer({ env: { PLASTIC_PROJECT: '/proj/default' } })
    const alpha = '/proj/alpha'
    const saved = await callJson<MemorySaveResult>(client, 'memory_save', {
      title: 'alpha 独有 note', text: 'alpha 正文', project: alpha, origin: 'user-stated',
    })
    expect(saved.path.startsWith(`${join(root, workspaceDirName(alpha))}${sep}`)).toBe(true)

    const read = await callJson<MemoryRecordView>(client, 'memory_read', { id: saved.id })
    expect(read).toMatchObject({ scope: 'workspace', workspacePath: alpha })

    // 缺省搜索看 PLASTIC_PROJECT 的可见集合（global + /proj/default），看不到 alpha 的记录
    expect((await callJson<MemorySearchResult>(client, 'memory_search', { query: 'alpha 独有' })).hits).toHaveLength(0)
    const alphaHits = await callJson<MemorySearchResult>(client, 'memory_search', { query: 'alpha 独有', project: alpha })
    expect(alphaHits.hits.map(hit => hit.id)).toEqual([saved.id])

    // project 缺省写进 PLASTIC_PROJECT，不落 cwd
    const fallback = await callJson<MemorySaveResult>(client, 'memory_save', {
      title: '缺省项目 note', text: '按 PLASTIC_PROJECT 落盘', origin: 'user-stated',
    })
    expect(fallback.path.startsWith(`${join(root, workspaceDirName('/proj/default'))}${sep}`)).toBe(true)
    expect((await callJson<MemoryRecordView>(client, 'memory_read', { id: fallback.id })).workspacePath).toBe('/proj/default')
  })

  it('memory_health 返回 0–100 的 score、issueCount 与 topIssues，且只读（文件树逐字不变）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-tools-'))
    tempDirs.push(root)
    const globalDir = join(root, GLOBAL_DIR)
    await mkdir(globalDir, { recursive: true })
    const common = [
      'type: knowledge', 'tags: []', 'status: active', 'confidence: 0.9', 'summary: 体检样例',
      'createdAt: 2026-01-01T00:00:00.000Z', 'updatedAt: 2026-01-01T00:00:00.000Z', 'lastConfirmedAt: 2026-01-01T00:00:00.000Z',
    ]
    await writeFile(join(globalDir, 'expired.md'), memoryFile([
      'id: mem_health_expired', 'name: 已过期条目', ...common, 'validTo: 2026-01-02T00:00:00.000Z',
    ], '过期正文'))
    await writeFile(join(globalDir, 'orphan.md'), memoryFile([
      'id: mem_health_orphan', 'name: 孤儿替代条目', ...common, 'supersedes:', '  - mem_missing',
    ], '孤儿正文'))
    await writeFile(join(globalDir, 'malformed.md'), '---\nname: [未闭合\n---\n\n坏文件\n')

    const before = await treeOf(root)
    const server = await startServer({ root })
    const health = await callJson<{ score: number; issueCount: number; topIssues: string[] }>(server.client, 'memory_health')
    expect(Number.isInteger(health.score)).toBe(true)
    expect(health.score).toBeGreaterThanOrEqual(0)
    expect(health.score).toBeLessThanOrEqual(100)
    // 口径（写在工具 description 里）：1 个坏文件 10 分 + 1 条过期 4 分 + 1 条孤儿 3 分
    expect(health).toMatchObject({ score: 83, issueCount: 3 })
    expect(health.topIssues).toHaveLength(3)
    const lines = health.topIssues.join('\n')
    expect(lines).toContain('隔离区')
    expect(lines).toContain('过期')
    expect(lines).toContain('supersedes')
    // 只读：不写记忆文件、不建侧表与锁库
    expect(await treeOf(root)).toEqual(before)
  })

  it('缺 PLASTIC_MEMORY_ROOT 或给相对路径：启动即退出并报错，stdout 不产出协议内容', async () => {
    const missing = await runBin({ PLASTIC_CLIENT: 'zcode' })
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('PLASTIC_MEMORY_ROOT')

    const relative = await runBin({ PLASTIC_CLIENT: 'zcode', PLASTIC_MEMORY_ROOT: 'relative/root' })
    expect(relative.code).toBe(1)
    expect(relative.stdout).toBe('')
    expect(relative.stderr).toContain('绝对路径')
  })

  it('日志走 stderr：core 的告警不出现在 stdout 协议通道上', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-tools-'))
    tempDirs.push(root)
    // 用一个标记不符的 workspace 目录触发 core 的告警：写路径照常成功，告警只能走 logger
    const project = '/proj/marker'
    const dir = join(root, workspaceDirName(project))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, WORKSPACE_MARKER), '/proj/other\n')
    const server = await startServer({ root })
    const saved = await callJson<MemorySaveResult>(server.client, 'memory_save', {
      title: '标记不符的写入', text: '仍要能落盘', project, origin: 'user-stated',
    })
    expect(saved.path.startsWith(`${dir}${sep}`)).toBe(true)
    await waitFor(() => server.stderr().includes('[plastic-memory]'))
    expect(server.stderr()).toContain('标记指向别的路径')
  })
})
