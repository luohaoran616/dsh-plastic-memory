import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryCore } from '@plastic/core/factory.ts'
import { memoryRecordSchema, type MemoryRecord } from '@plastic/core/record-schema.ts'
import { WORKSPACE_MARKER, workspaceDirName } from '@plastic/core/storage/paths.ts'
import type { LocatedRecord, MemoryLogger } from '@plastic/core/storage/table.ts'
import { importZcode, parseImportZcodeArgs, type ZcodeImportReport } from './import-zcode.ts'
import { baseEnv } from './spec-helpers.ts'
import { createMemoryTools } from './tools.ts'

// 夹具照 Task 4 上下文 §2 的真实格式造：metadata 嵌套 type / originSessionId、description 折行、
// [[wiki 链接]] 正文、MEMORY.md 索引、未知 type、解析失败的坏文件、跨项目的同名记忆（幂等键碰撞）。

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const ALPHA = 'alpha-4371d60a124eec63'
const BETA = 'beta-6c2a1f0d3e5b7a91'

const silentLog: MemoryLogger = { info() {}, warn() {}, error() {} }

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Fixture {
  base: string
  /** ZCode 记忆库根（--src）。 */
  src: string
  /** 目标 plastic 记忆根（--root）。 */
  root: string
  /** 两个项目都映射的映射文件：apply 用例用它（未映射项目不会被导入）。 */
  mapFile: string
  /** 只映射 alpha 的映射文件：dry-run 与「未映射项目跳过」用例用它。 */
  partialMapFile: string
  workspaceAlpha: string
  workspaceBeta: string
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'pm-zcode-import-'))
  tempDirs.push(base)
  const src = join(base, 'zcode-memories')
  const root = join(base, 'plastic-root')
  const workspaceAlpha = join(base, 'projects', 'alpha')
  const workspaceBeta = join(base, 'projects', 'beta')
  const mapFile = join(base, 'project-map.json')
  const partialMapFile = join(base, 'project-map-alpha-only.json')
  const alphaDir = join(src, 'projects', ALPHA, 'memory')
  const betaDir = join(src, 'projects', BETA, 'memory')
  await mkdir(alphaDir, { recursive: true })
  await mkdir(betaDir, { recursive: true })

  // 索引文件不迁
  await writeFile(join(alphaDir, 'MEMORY.md'), '# Memory Index\n\n- [ZCode hooks config gotcha](zcode-hooks-config-gotcha.md) — 索引行\n')

  await writeFile(join(alphaDir, 'zcode-hooks-config-gotcha.md'), [
    '---',
    'name: zcode-hooks-config-gotcha',
    'description: ZCode config-file hooks must nest events under hooks.events.* —',
    '  Claude Code plugin-style keys are rejected; where to verify hook execution',
    'metadata:',
    '  node_type: memory',
    '  type: project',
    '  originSessionId: sess_alpha-0001',
    '---',
    '',
    'Hard-won 2026-08-21 while activating the engram hooks: hook events MUST be nested as `hooks.events.<EventName>`.',
    'See [[engram-project]] for the project context.',
    '',
  ].join('\n'))

  await writeFile(join(alphaDir, 'user-ai-memory-skill.md'), [
    '---',
    'name: user-ai-memory-skill',
    'description: User maintains their own ai-memory skill alongside ZCode memory',
    'metadata:',
    '  node_type: memory',
    '  type: user',
    '  originSessionId: sess_alpha-0002',
    '---',
    '',
    'The user built `ai-memory` at `~/.pi/agent/skills/ai-memory`.',
    'See [[memory-systems-division]].',
    '',
  ].join('\n'))

  await writeFile(join(alphaDir, 'mcp-lazy-discovery-research.md'), [
    '---',
    'name: mcp-lazy-discovery-research',
    'description: MCP lazy discovery research notes',
    'metadata:',
    '  type: reference',
    '  originSessionId: sess_alpha-0003',
    '---',
    '',
    'Research lives at `docs/ai/mcp-lazy-discovery.md`.',
    '',
  ].join('\n'))

  // 未知 type 且没有 description：summary 退回正文首行
  await writeFile(join(alphaDir, 'mystery-type-note.md'), [
    '---',
    'name: mystery-type-note',
    'metadata:',
    '  type: mystery',
    '  originSessionId: sess_alpha-0004',
    '---',
    '',
    '未知类型的记忆也要迁进来。',
    '',
  ].join('\n'))

  // 没有 frontmatter 围栏：解析失败，跳过并记账
  await writeFile(join(alphaDir, 'no-frontmatter.md'), [
    '# 没有 frontmatter 的文件',
    '',
    '这行只是普通 Markdown。',
    '',
  ].join('\n'))

  // beta 只在 partialMapFile 里缺席：dry-run 按 global 预告，apply 下被跳过
  await writeFile(join(betaDir, 'feedback-writing-style.md'), [
    '---',
    'name: feedback-writing-style',
    'description: User wants prose without arrow chains',
    'metadata:',
    '  type: feedback',
    '  originSessionId: sess_beta-0001',
    '---',
    '',
    'Use full sentences, not arrow chains.',
    '',
  ].join('\n'))

  // 跨项目同名：alpha 那条先导入，beta 这条按幂等键跳过
  await writeFile(join(betaDir, 'zcode-hooks-config-gotcha.md'), [
    '---',
    'name: zcode-hooks-config-gotcha',
    'description: beta 项目里的同名记忆',
    'metadata:',
    '  type: feedback',
    '  originSessionId: sess_beta-0002',
    '---',
    '',
    'beta 项目的同名正文。',
    '',
  ].join('\n'))

  await writeFile(mapFile, JSON.stringify({ [ALPHA]: workspaceAlpha, [BETA]: workspaceBeta }, null, 2))
  await writeFile(partialMapFile, JSON.stringify({ [ALPHA]: workspaceAlpha }, null, 2))
  return { base, src, root, mapFile, partialMapFile, workspaceAlpha, workspaceBeta }
}

/** 分支用例的小库：缺 originSessionId、缺 metadata.type 各一条（各钉一个分支，不掺进主夹具的计数）。 */
async function branchFixture(): Promise<{ src: string; root: string; mapFile: string }> {
  const base = await mkdtemp(join(tmpdir(), 'pm-zcode-branch-'))
  tempDirs.push(base)
  const src = join(base, 'zcode-memories')
  const root = join(base, 'plastic-root')
  const mapFile = join(base, 'project-map.json')
  const alphaDir = join(src, 'projects', ALPHA, 'memory')
  await mkdir(alphaDir, { recursive: true })

  await writeFile(join(alphaDir, 'no-session-note.md'), [
    '---',
    'name: no-session-note',
    'description: 缺 originSessionId 的记忆',
    'metadata:',
    '  type: project',
    '---',
    '',
    '没有 originSessionId 也要能导入。',
    '',
  ].join('\n'))

  await writeFile(join(alphaDir, 'no-type-note.md'), [
    '---',
    'name: no-type-note',
    'metadata:',
    '  originSessionId: sess_branch-0002',
    '---',
    '',
    '缺 metadata.type 的记忆归 general。',
    '',
  ].join('\n'))

  await writeFile(mapFile, JSON.stringify({ [ALPHA]: join(base, 'projects', 'alpha') }, null, 2))
  return { src, root, mapFile }
}

/** 读记录走 core 的读路径（与导入器自己的判定同源），不直接扫目录。 */
async function locatedOf(root: string): Promise<LocatedRecord[]> {
  const core = await createMemoryCore({ root, client: 'spec', log: silentLog })
  try {
    const read = await core.store.readRaw(undefined, { includeArchive: true })
    return read.records
  } finally {
    await core.close()
  }
}

async function recordsOf(root: string): Promise<MemoryRecord[]> {
  return (await locatedOf(root)).map(located => located.record)
}

/** 记忆根下的文件清单（含 .state）：只读操作前后应逐字相同。 */
async function treeOf(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true }) as string[]
  } catch {
    return []
  }
  const rows: string[] = []
  for (const entry of entries.sort()) {
    const info = await stat(join(dir, entry)).catch(() => undefined)
    rows.push(`${entry}:${info === undefined ? 'gone' : info.isFile() ? `${info.size}:${info.mtimeMs}` : 'dir'}`)
  }
  return rows
}

/** 记忆根下的全部文件（相对路径），用来断言 dry-run 零写入。 */
async function filesOf(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true }) as string[]
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries.sort()) {
    const info = await stat(join(dir, entry)).catch(() => undefined)
    if (info?.isFile() === true) files.push(entry)
  }
  return files
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: PACKAGE_ROOT, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolvePromise({ code, stdout, stderr }))
  })
}

describe('ZCode 记忆导入器', () => {
  it('dry-run：条数正确、索引不迁、未知类型单列、解析失败跳过、未映射只预告，且零写入', async () => {
    const f = await fixture()
    const report = await importZcode({ src: f.src, root: f.root, mapFile: f.partialMapFile })

    expect(report.mode).toBe('dry-run')
    expect(report.summary).toEqual({
      projects: 2, scanned: 7, wouldImport: 5, imported: 0, skipped: 2,
      skippedByReason: { exists: 0, 'duplicate-in-source': 1, 'parse-error': 1, unmapped: 0 },
    })
    expect(report.unknownTypes).toEqual([{ zcodeType: 'mystery', mappedTo: 'general', titles: ['mystery-type-note'] }])
    expect(report.entries.some(entry => entry.source.endsWith('/MEMORY.md'))).toBe(false)
    expect(report.projects).toEqual([
      { hash: ALPHA, files: 5, scope: 'workspace', workspacePath: f.workspaceAlpha, note: '已映射' },
      { hash: BETA, files: 2, scope: 'global', workspacePath: null, note: '未映射，按 global 处理' },
    ])
    expect(report.warnings.some(warning => warning.includes(BETA) && warning.includes('global'))).toBe(true)
    // 源内被丢掉的同名条目要出现在 warnings 里，人工过目报告时看得见
    expect(report.warnings.some(warning => warning.includes('源内同名被跳过') && warning.includes('zcode-hooks-config-gotcha'))).toBe(true)

    // 跳过各有原因：beta 的同名文件与 alpha 撞幂等键，no-frontmatter.md 解析失败
    const duplicate = report.entries.find(entry => entry.reason === 'duplicate-in-source')
    expect(duplicate).toMatchObject({ title: 'zcode-hooks-config-gotcha', action: 'skipped' })
    const broken = report.entries.find(entry => entry.reason === 'parse-error')
    expect(broken?.source).toContain('no-frontmatter.md')
    expect(broken?.error).toContain('frontmatter')

    // 零写入：目标记忆库里一条记录都没有，也没有落下任何文件
    expect(await recordsOf(f.root)).toEqual([])
    expect(await filesOf(f.root)).toEqual([])
  })

  it('apply：title/summary/imported-from/type/scope 按 D7 映射表逐一落库，正文与 wiki 链接原样保留', async () => {
    const f = await fixture()
    const report = await importZcode({ src: f.src, root: f.root, mapFile: f.mapFile, apply: true })
    expect(report.mode).toBe('apply')
    expect(report.summary).toMatchObject({ scanned: 7, wouldImport: 5, imported: 5, skipped: 2 })

    const records = await recordsOf(f.root)
    expect(records).toHaveLength(5)
    const byName = new Map(records.map(record => [record.name, record]))

    expect(byName.get('zcode-hooks-config-gotcha')).toMatchObject({
      type: 'project',
      summary: 'ZCode config-file hooks must nest events under hooks.events.* — Claude Code plugin-style keys are rejected; where to verify hook execution',
      content: 'Hard-won 2026-08-21 while activating the engram hooks: hook events MUST be nested as `hooks.events.<EventName>`.\nSee [[engram-project]] for the project context.',
      scope: 'workspace',
      workspacePath: f.workspaceAlpha,
      'imported-from': 'zcode:sess_alpha-0001',
    })
    expect(byName.get('user-ai-memory-skill')).toMatchObject({
      type: 'preference',
      summary: 'User maintains their own ai-memory skill alongside ZCode memory',
      content: 'The user built `ai-memory` at `~/.pi/agent/skills/ai-memory`.\nSee [[memory-systems-division]].',
      scope: 'workspace',
      workspacePath: f.workspaceAlpha,
      'imported-from': 'zcode:sess_alpha-0002',
    })
    expect(byName.get('mcp-lazy-discovery-research')).toMatchObject({
      type: 'reference',
      'imported-from': 'zcode:sess_alpha-0003',
    })
    expect(byName.get('mystery-type-note')).toMatchObject({
      type: 'general',
      summary: '未知类型的记忆也要迁进来。',
      'imported-from': 'zcode:sess_alpha-0004',
    })
    const betaRecord = byName.get('feedback-writing-style')
    expect(betaRecord).toMatchObject({
      type: 'preference',
      scope: 'workspace',
      workspacePath: f.workspaceBeta,
      'imported-from': 'zcode:sess_beta-0001',
    })
    // 索引文件没有变成记录
    expect(byName.has('Memory Index')).toBe(false)
  })

  it('映射值经 resolve 规范化：尾部斜杠不另造工作区，与 MCP 工具写入落在同一个目录', async () => {
    const f = await fixture()
    const rawMap = join(f.base, 'trailing-slash-map.json')
    // Tab 补全常产生带尾部斜杠的路径；映射值原样用在 core 里会哈希出另一个工作区目录
    const rawValue = `${f.workspaceAlpha}/`
    await writeFile(rawMap, JSON.stringify({ [ALPHA]: rawValue, [BETA]: `${f.workspaceBeta}/` }, null, 2))

    const report = await importZcode({ src: f.src, root: f.root, mapFile: rawMap, apply: true })
    expect(report.projects.find(project => project.hash === ALPHA)?.workspacePath).toBe(f.workspaceAlpha)
    expect(report.projects.find(project => project.hash === BETA)?.workspacePath).toBe(f.workspaceBeta)

    const before = await locatedOf(f.root)
    const imported = before.find(located => located.record.name === 'zcode-hooks-config-gotcha')
    expect(imported?.record.workspacePath).toBe(f.workspaceAlpha)
    // 两个项目各落一个规范后的工作区目录，没有因尾部斜杠另造目录
    expect(new Set(before.map(located => located.dir))).toEqual(new Set([
      join(f.root, workspaceDirName(f.workspaceAlpha)),
      join(f.root, workspaceDirName(f.workspaceBeta)),
    ]))
    expect(imported?.dir).toBe(join(f.root, workspaceDirName(f.workspaceAlpha)))
    expect((await readFile(join(imported!.dir, WORKSPACE_MARKER), 'utf8')).trim()).toBe(f.workspaceAlpha)

    // 同一路径经 MCP 工具写入（传映射文件里的原值）：工具自己 resolve，落点必须与导入记录同目录
    const core = await createMemoryCore({ root: f.root, client: 'spec', log: silentLog })
    try {
      const tools = createMemoryTools(core, { client: 'spec' })
      await tools.save({ title: 'mcp-same-workspace', text: '同一项目的另一条记忆', project: rawValue, origin: 'user-stated' })
    } finally {
      await core.close()
    }
    const mcpSaved = (await locatedOf(f.root)).find(located => located.record.name === 'mcp-same-workspace')
    expect(mcpSaved?.record.workspacePath).toBe(f.workspaceAlpha)
    expect(mcpSaved?.dir).toBe(imported?.dir)
  })

  it('同参数二次 apply 零写入：全部按幂等跳过，记忆根逐文件不变', async () => {
    const f = await fixture()
    const first = await importZcode({ src: f.src, root: f.root, mapFile: f.mapFile, apply: true })
    expect(first.summary.imported).toBe(5)
    const before = await treeOf(f.root)

    const second = await importZcode({ src: f.src, root: f.root, mapFile: f.mapFile, apply: true })
    expect(second.summary).toMatchObject({ scanned: 7, wouldImport: 0, imported: 0, skipped: 7 })
    // 已导入的 5 条按 title 命中；beta 的同名文件也命中已存在标题，坏文件照旧解析失败
    expect(second.summary.skippedByReason).toEqual({ exists: 6, 'duplicate-in-source': 0, 'parse-error': 1, unmapped: 0 })
    // 第二次没有任何条目进入写入动作；beta 的同名文件与坏文件仍各自按原原因跳过
    expect(second.entries.filter(entry => entry.action !== 'skipped')).toEqual([])
    expect(second.entries.filter(entry => entry.reason === 'exists')).toHaveLength(6)
    expect(await treeOf(f.root)).toEqual(before)
    expect(await recordsOf(f.root)).toHaveLength(5)
  })

  it('幂等键按两半判：目标库里的同名手写记录（无 imported-from 前缀）不阻止导入', async () => {
    const f = await fixture()
    const seeded = memoryRecordSchema.parse({
      id: 'mem_manual_same_title',
      name: 'zcode-hooks-config-gotcha',
      type: 'knowledge',
      scope: 'global',
      tags: [],
      content: '手写的同名记录，不能因为撞名就被导入逻辑当成已导入。',
      summary: '手写的同名记录',
      createdAt: 1, updatedAt: 1, lastConfirmedAt: 1,
      lastRecalledAt: null, recallCount: 0,
      status: 'active', confidence: 0.9,
    })
    const core = await createMemoryCore({ root: f.root, client: 'spec', log: silentLog })
    try {
      await core.store.create(seeded)
    } finally {
      await core.close()
    }

    const report = await importZcode({ src: f.src, root: f.root, mapFile: f.mapFile, apply: true })
    expect(report.summary.imported).toBe(5)
    expect(report.entries.find(entry => entry.title === 'zcode-hooks-config-gotcha')?.action).toBe('imported')

    // core 撞名时会追加 id 片段：手写记录与导入记录两条都活着
    const sameName = (await recordsOf(f.root)).filter(record => record.name === 'zcode-hooks-config-gotcha')
    expect(sameName).toHaveLength(2)
    expect(sameName.find(record => record.id === seeded.id)?.['imported-from']).toBeUndefined()
    expect(sameName.some(record => record['imported-from'] === 'zcode:sess_alpha-0001')).toBe(true)
  })

  it('缺 originSessionId 写成裸 zcode；缺 metadata.type 归 general 并进 warnings', async () => {
    const f = await branchFixture()
    const report = await importZcode({ src: f.src, root: f.root, mapFile: f.mapFile, apply: true })
    const byName = new Map((await recordsOf(f.root)).map(record => [record.name, record]))

    expect(byName.get('no-session-note')).toMatchObject({ type: 'project', 'imported-from': 'zcode' })
    expect(byName.get('no-type-note')).toMatchObject({ type: 'general', 'imported-from': 'zcode:sess_branch-0002' })
    expect(report.unknownTypes).toEqual([{ zcodeType: null, mappedTo: 'general', titles: ['no-type-note'] }])
    expect(report.warnings.some(warning => warning.includes('(缺 type)') && warning.includes('no-type-note'))).toBe(true)
  })

  it('--apply 不给 --map：直接报错退出、目标记忆根零写入；无 --apply 的 dry-run 仍照常报告', async () => {
    const f = await fixture()

    // dry-run 不需要映射文件：照常扫、未映射项目按 global 口径预告并逐项目告警，零写入
    const dry = await importZcode({ src: f.src, root: f.root })
    expect(dry.mapFile).toBeNull()
    expect(dry.summary).toMatchObject({ scanned: 7, wouldImport: 5, imported: 0 })
    expect(dry.warnings.filter(warning => warning.includes('按 global 处理'))).toHaveLength(2)
    expect(await filesOf(f.root)).toEqual([])

    // apply 缺 --map：参数校验阶段就抛错，连记忆根都不建
    await expect(importZcode({ src: f.src, root: f.root, apply: true })).rejects.toThrow(/--map/)
    expect(await filesOf(f.root)).toEqual([])

    // 走 bin 也是非零退出：错误进 stderr，stdout 不吐报告
    const result = await runCli(['import-zcode', '--src', f.src, '--root', f.root, '--apply'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--map')
    expect(result.stdout).toBe('')
    expect(await filesOf(f.root)).toEqual([])
    expect(await recordsOf(f.root)).toEqual([])
  })

  it('--apply 漏映射某个项目：该项目条目按 unmapped 跳过并点名，其余项目照常导入', async () => {
    const f = await fixture()
    const report = await importZcode({ src: f.src, root: f.root, mapFile: f.partialMapFile, apply: true })

    expect(report.summary).toMatchObject({ scanned: 7, wouldImport: 4, imported: 4, skipped: 3 })
    expect(report.summary.skippedByReason).toEqual({ exists: 0, 'duplicate-in-source': 0, 'parse-error': 1, unmapped: 2 })
    // warnings 点名被跳过的项目（hash + 条数）
    expect(report.warnings).toContain(`项目 ${BETA} 未在映射文件中，跳过导入（2 条）`)
    const betaEntries = report.entries.filter(entry => entry.source.includes(`projects/${BETA}/`))
    expect(betaEntries).toHaveLength(2)
    expect(betaEntries.every(entry => entry.action === 'skipped' && entry.reason === 'unmapped' && entry.scope === null)).toBe(true)

    // 只有映射到的 alpha 条目落库，都在工作区里；beta 的条目一条都没写
    const records = await recordsOf(f.root)
    expect(records).toHaveLength(4)
    expect(records.every(record => record.scope === 'workspace' && record.workspacePath === f.workspaceAlpha)).toBe(true)
    expect(records.some(record => record.name === 'feedback-writing-style')).toBe(false)
    expect(report.projects).toContainEqual({ hash: BETA, files: 2, scope: null, workspacePath: null, note: '未映射，跳过导入' })
  })

  it('映射文件不合法或 --src 不像 ZCode 库：直接报错，不默默当成没给', async () => {
    const f = await fixture()
    const badJson = join(f.base, 'bad-map.json')
    await writeFile(badJson, '{ not json')
    await expect(importZcode({ src: f.src, root: f.root, mapFile: badJson })).rejects.toThrow(/合法 JSON/)

    const relativeMap = join(f.base, 'relative-map.json')
    await writeFile(relativeMap, JSON.stringify({ [ALPHA]: 'relative/project' }))
    await expect(importZcode({ src: f.src, root: f.root, mapFile: relativeMap })).rejects.toThrow(/绝对路径/)

    const notALibrary = join(f.base, 'not-a-library')
    await mkdir(notALibrary, { recursive: true })
    await expect(importZcode({ src: notALibrary, root: f.root })).rejects.toThrow(/projects/)
    await expect(importZcode({ src: join(f.base, 'missing-src'), root: f.root })).rejects.toThrow(/--src/)
  })

  it('bin 子命令：import-zcode 缺省 dry-run，stdout 是纯 JSON，报告同时落盘', async () => {
    const f = await fixture()
    const reportFile = join(f.base, 'reports', 'zcode-import-dryrun.json')
    const result = await runCli(['import-zcode', '--src', f.src, '--root', f.root, '--map', f.mapFile, '--report', reportFile])
    expect(result.code).toBe(0)
    expect(result.stdout.trimStart().startsWith('{')).toBe(true)

    const printed = JSON.parse(result.stdout) as ZcodeImportReport
    const saved = JSON.parse(await readFile(reportFile, 'utf8')) as ZcodeImportReport
    expect(saved).toEqual(printed)
    expect(printed.mode).toBe('dry-run')
    expect(printed.summary.wouldImport).toBe(5)
    // dry-run 经过 bin 也不写记忆
    expect(await filesOf(f.root)).toEqual([])
  })

  it('CLI 参数解析：缺必填项与未知参数都报用法错误', () => {
    expect(() => parseImportZcodeArgs(['--root', '/r'])).toThrow(/缺少 --src/)
    expect(() => parseImportZcodeArgs(['--src', '/s'])).toThrow(/缺少 --root/)
    expect(() => parseImportZcodeArgs(['--src', '/s', '--root', '/r', '--bogus'])).toThrow(/未知参数/)
    expect(parseImportZcodeArgs(['--src', '/s', '--root', '/r', '--apply'])).toMatchObject({
      src: '/s', root: '/r', apply: true,
    })
  })
})
