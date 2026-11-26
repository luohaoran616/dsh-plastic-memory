import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { splitFrontmatter } from '@plastic/core/storage/frontmatter.ts'
import { GLOBAL_DIR, workspaceDirName } from '@plastic/core/storage/paths.ts'
import { baseEnv, callJson } from './spec-helpers.ts'

// Review Focus #5 的钉子测试：MCP 端禁止全局直写。
// project: "global" 只能落成「workspace 作用域 + needs-promote-review: true」，任何人确认后才由 WebUI 提升；
// 任何入参组合都不能让 MCP 把记录直接写进 <root>/global/。

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

interface RunningServer { client: Client; root: string }

const servers: RunningServer[] = []
const tempDirs: string[] = []

async function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const root = await mkdtemp(join(tmpdir(), 'pm-mcp-global-'))
  tempDirs.push(root)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    cwd: PACKAGE_ROOT,
    env: { ...baseEnv, PLASTIC_MEMORY_ROOT: root, PLASTIC_CLIENT: 'zcode', ...env },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => { /* 告警只进 stderr；用例不依赖内容 */ })
  const client = new Client({ name: 'plastic-mcp-global-spec', version: '0.0.0' })
  await client.connect(transport)
  const server = { client, root }
  servers.push(server)
  return server
}

/** 读落盘文件里的 frontmatter 键值：守卫要看的是写进文件的标记，不只是内存里的返回。 */
async function frontmatterOf(path: string): Promise<Record<string, unknown>> {
  return splitFrontmatter(await readFile(path, 'utf8')).data
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.client.close().catch(() => {})
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Saved { id: string; path: string }
interface RecordView { id: string; scope: string; workspacePath?: string; status: string; globalCandidate?: boolean }

const globalDirOf = (root: string) => `${join(root, GLOBAL_DIR)}${sep}`

describe('MCP 全局守卫（R12 / Review Focus #5）', () => {
  it('project: "global" 走写入管线降级：workspace 记录带 globalCandidate: true，不写进 global 作用域', async () => {
    const { client, root } = await startServer({ PLASTIC_PROJECT: '/proj/alpha' })
    const saved = await callJson<Saved>(client, 'memory_save', {
      title: '全局候选约定', text: '所有项目都适用的约定', project: 'global', origin: 'user-stated', type: 'knowledge',
    })
    expect(saved.path.startsWith(`${join(root, workspaceDirName('/proj/alpha'))}${sep}`)).toBe(true)
    expect(saved.path.startsWith(globalDirOf(root))).toBe(false)
    expect(await frontmatterOf(saved.path)).toMatchObject({ globalCandidate: true })

    const read = await callJson<RecordView>(client, 'memory_read', { id: saved.id })
    expect(read).toMatchObject({
      scope: 'workspace', workspacePath: '/proj/alpha', status: 'active', globalCandidate: true,
    })

    // 不在 global 作用域：只查全局看不到它，按当前项目（= PLASTIC_PROJECT）看得到
    expect((await callJson<{ hits: unknown[] }>(client, 'memory_search', { query: '全局候选', project: 'global' })).hits).toHaveLength(0)
    const local = await callJson<{ hits: Array<{ id: string }> }>(client, 'memory_search', { query: '全局候选' })
    expect(local.hits.map(hit => hit.id)).toEqual([saved.id])
  })

  it('PLASTIC_PROJECT=global 也走同一条守卫：不落 global 作用域、带标记、workspace 退回进程 cwd', async () => {
    const { client, root } = await startServer({ PLASTIC_PROJECT: 'global' })
    const saved = await callJson<Saved>(client, 'memory_save', {
      title: '环境配置里的全局', text: '环境变量不能成为绕行通道', origin: 'model-observed', type: 'knowledge',
    })
    expect(saved.path.startsWith(globalDirOf(root))).toBe(false)
    expect(await frontmatterOf(saved.path)).toMatchObject({ globalCandidate: true })
    const read = await callJson<RecordView>(client, 'memory_read', { id: saved.id })
    expect(read).toMatchObject({ scope: 'workspace', workspacePath: PACKAGE_ROOT, globalCandidate: true })
  })

  it('非 global 写入不带标记；大小写不同只是普通项目路径，不算全局', async () => {
    const { client, root } = await startServer({ PLASTIC_PROJECT: '/proj/default' })
    const cases: Array<{ project?: string; expectedWorkspace: string }> = [
      { expectedWorkspace: '/proj/default' },
      { project: '/proj/beta', expectedWorkspace: '/proj/beta' },
      { project: 'Global', expectedWorkspace: join(PACKAGE_ROOT, 'Global') },
    ]
    for (const [index, entry] of cases.entries()) {
      const saved = await callJson<Saved>(client, 'memory_save', {
        title: `普通写入 ${index}`, text: `正文 ${index}`, origin: 'user-stated', type: 'knowledge', ...(entry.project === undefined ? {} : { project: entry.project }),
      })
      expect(saved.path.startsWith(globalDirOf(root))).toBe(false)
      expect(saved.path.startsWith(`${join(root, workspaceDirName(entry.expectedWorkspace))}${sep}`)).toBe(true)
      expect(await frontmatterOf(saved.path)).not.toHaveProperty('globalCandidate')
      expect(await callJson<RecordView>(client, 'memory_read', { id: saved.id })).toMatchObject({
        scope: 'workspace', workspacePath: entry.expectedWorkspace,
      })
    }
  })

  it('工具面没有任何绕过路径：没有提升工具，memory_save 也没有 scope 入参', async () => {
    const { client } = await startServer()
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'memory_forget', 'memory_health', 'memory_read', 'memory_recall', 'memory_save', 'memory_search', 'memory_source',
    ])
    for (const tool of tools) expect(tool.name).not.toContain('promote')
    const save = tools.find(tool => tool.name === 'memory_save')!
    const schema = save.inputSchema as { properties?: Record<string, unknown> }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'confidence', 'force', 'id', 'origin', 'project', 'summary', 'supersedes', 'tags', 'text', 'title', 'type', 'validFrom', 'validTo',
    ])
    expect(Object.keys(schema.properties ?? {})).not.toContain('scope')
    expect(Object.keys(schema.properties ?? {})).not.toContain('globalCandidate')
  })
})
