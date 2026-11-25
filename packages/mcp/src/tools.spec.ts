import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { splitFrontmatter } from '@plastic/core/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '@plastic/core/storage/paths.ts'
import { baseEnv, callJson } from './spec-helpers.ts'
import { deriveSummary, SUMMARY_MAX_CHARS } from './tools.ts'

// 真子进程 + 真 stdio：用例起的是 packages/mcp/src/bin.ts 本身，按 MCP 协议走 StdioClientTransport，
// 不调内部函数。Node 内置类型剥离直接跑 .ts（与仓库 tests/helpers/spawn-worker.ts 同一办法）。

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

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

  it('memory_health 的 orphan 口径与插件一致：已归档的 superseded 不算孤儿，已删的才算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-tools-'))
    tempDirs.push(root)
    const globalDir = join(root, GLOBAL_DIR)
    const archiveDir = join(globalDir, ARCHIVE_DIR)
    await mkdir(archiveDir, { recursive: true })
    const common = [
      'type: knowledge', 'tags: []', 'confidence: 0.9', 'summary: 链条摘要',
      'createdAt: 2026-01-01T00:00:00.000Z', 'updatedAt: 2026-01-01T00:00:00.000Z', 'lastConfirmedAt: 2026-01-01T00:00:00.000Z',
    ]
    // 正常替代链归档后的现场：维护点把被置成 superseded 的旧记录搬进 .archive/，新记录 active 并引用它
    await writeFile(join(archiveDir, 'chain-old.md'), memoryFile([
      'id: mem_chain_old', 'name: 被取代的旧记录', ...common, 'status: superseded',
    ], '旧正文'))
    await writeFile(join(globalDir, 'chain-new.md'), memoryFile([
      'id: mem_chain_new', 'name: 替代后的新记录', ...common, 'status: active', 'supersedes:', '  - mem_chain_old',
    ], '新正文'))
    // 对照组：引用一条已软删（归档且 status: deleted）的记录，仍算孤儿
    await writeFile(join(archiveDir, 'gone.md'), memoryFile([
      'id: mem_chain_gone', 'name: 已删除记录', ...common, 'status: deleted', 'deletedAt: 2026-01-03T00:00:00.000Z',
    ], '已删正文'))
    await writeFile(join(globalDir, 'refs-deleted.md'), memoryFile([
      'id: mem_chain_ref_deleted', 'name: 引用已删记录', ...common, 'status: active', 'supersedes:', '  - mem_chain_gone',
    ], '引用正文'))

    const server = await startServer({ root })
    const health = await callJson<{ score: number; issueCount: number; topIssues: string[] }>(server.client, 'memory_health')
    // 只有「引用已删记录」那一条扣 3 分；替代链上的归档 superseded 不算孤儿
    expect(health).toMatchObject({ score: 97, issueCount: 1 })
    expect(health.topIssues).toHaveLength(1)
    expect(health.topIssues[0]).toContain('supersedes')
    expect(health.topIssues[0]).toContain('mem_chain_ref_deleted')
    expect(health.topIssues.join('\n')).not.toContain('mem_chain_new')
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

describe('deriveSummary 边界', () => {
  it('首行非空取首行；首行为空时折空白取全文', () => {
    expect(deriveSummary('  首行摘要  \n第二行细节')).toBe('首行摘要')
    expect(deriveSummary('\n\n  第一段\n\t第二段  ')).toBe('第一段 第二段')
  })

  it('超过 120 字符截断并加省略号，按 code point 计不切坏 emoji', () => {
    const exact = '字'.repeat(SUMMARY_MAX_CHARS)
    expect(deriveSummary(exact)).toBe(exact)

    const truncated = deriveSummary('字'.repeat(SUMMARY_MAX_CHARS + 5))
    expect([...truncated]).toHaveLength(SUMMARY_MAX_CHARS + 1)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated.slice(0, -1)).toBe('字'.repeat(SUMMARY_MAX_CHARS))

    const emoji = deriveSummary('😀'.repeat(SUMMARY_MAX_CHARS + 1))
    expect([...emoji]).toHaveLength(SUMMARY_MAX_CHARS + 1)
    expect(emoji.endsWith('…')).toBe(true)
    // 保留的是 120 个完整 emoji，没有切出半个代理对
    expect([...emoji.slice(0, -1)].every(char => char === '😀')).toBe(true)
  })
})
