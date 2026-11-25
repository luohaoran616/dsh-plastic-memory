import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createMemoryCore, type MemoryCore } from '@plastic/core/factory.ts'
import { memoryRecordSchema, type MemoryRecord } from '@plastic/core/record-schema.ts'
import { splitFrontmatter, type ParsedMemoryFile } from '@plastic/core/storage/frontmatter.ts'
import { isMemoryFileName } from '@plastic/core/storage/paths.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { deriveSummary, newMemoryId } from './tools.ts'

/**
 * ZCode 记忆导入器（D7）：把 `~/.zcode/cli/memories/projects/<hash>/memory/*.md` 搬进 plastic 记忆库。
 * 缺省 dry-run 只出报告、零写入；`--apply` 才经 core 的 `store.create` 落盘（享受同一把跨进程写锁，不碰文件）。
 *
 * ZCode 的 frontmatter 与 plastic 的记录格式不同（`metadata.type`、`metadata.originSessionId` 在嵌套对象里），
 * 所以只借 core 的 `splitFrontmatter` 做「切围栏 + YAML 解析 + 取正文」，字段自己取，不喂 `decodeRecord`。
 *
 * 幂等键（D7）：目标库里已存在同名且 `imported-from` 以 zcode 开头的记录就跳过。映射文件（JSON：
 * hash 目录名 → 项目绝对路径）可缺省；缺省或未列出的项目按 global 作用域导入，报告里标注。
 */

/** D7 的已知值映射表：ZCode 的 `metadata.type` → plastic 的类型名。`user` 与 `feedback` 都是用户对做法/分工的要求，
 *  归 行为偏好（reference 与 knowledge 各自同名直通）。 */
export const ZCODE_TYPE_MAP: Readonly<Record<string, string>> = {
  project: 'project',
  reference: 'reference',
  knowledge: 'knowledge',
  user: 'preference',
  feedback: 'preference',
}

/** 未知 type 的落点（D7「未知值归 general」）：general 不是内置类型名，但 core 的 type 是自由字符串，作自定义类型写入合法。 */
export const UNKNOWN_ZCODE_TYPE = 'general'

/** 导入记录的置信度：与手建文件同一档位。ZCode 记忆没有可映射的 sourceMode，不冒充 agent 推断下调。 */
const IMPORT_CONFIDENCE = 0.9

/** `imported-from` 的前缀（D7 的幂等判定按它）。 */
const ZCODE_IMPORT_PREFIX = 'zcode'

const PROJECTS_DIR = 'projects'
const MEMORY_DIR = 'memory'

export const IMPORT_ZCODE_USAGE = 'plastic-mcp import-zcode --src <dir> --root <root> [--map <file>] [--report <file>] [--apply]'

export type ImportSkipReason = 'exists' | 'duplicate-in-source' | 'parse-error'

export interface ZcodeImportEntry {
  /** 相对 `--src` 的源文件路径。 */
  source: string
  title: string | null
  /** ZCode 的 metadata.type；缺 type 时为 null。 */
  zcodeType: string | null
  /** 实际写入的 plastic 类型名；解析失败时为 null。 */
  type: string | null
  scope: 'global' | 'workspace' | null
  workspacePath: string | null
  /** 写入的 `imported-from` 值；解析失败时为 null。 */
  importedFrom: string | null
  action: 'would-import' | 'imported' | 'skipped'
  reason?: ImportSkipReason
  error?: string
}

export interface ZcodeImportProject {
  /** 项目 hash 目录名（`projects/` 下的一级目录）。 */
  hash: string
  files: number
  scope: 'global' | 'workspace'
  workspacePath: string | null
  note: string
}

export interface ZcodeImportSummary {
  projects: number
  /** 扫到的记忆文件数（不含 MEMORY.md 索引）。 */
  scanned: number
  /** 应导入条数（dry-run 是计划数；apply 时与 imported 相等）。 */
  wouldImport: number
  /** 实际写入条数（dry-run 恒零）。 */
  imported: number
  skipped: number
  skippedByReason: Record<ImportSkipReason, number>
}

export interface ZcodeImportReport {
  mode: 'dry-run' | 'apply'
  source: string
  root: string
  mapFile: string | null
  typeMap: Record<string, string>
  summary: ZcodeImportSummary
  /** 未知类型清单（spec 要求）：ZCode 值 → 归到的类型名 → 受影响的记录名。 */
  unknownTypes: Array<{ zcodeType: string | null; mappedTo: string; titles: string[] }>
  warnings: string[]
  projects: ZcodeImportProject[]
  entries: ZcodeImportEntry[]
}

export interface ImportZcodeOptions {
  /** ZCode 记忆库根目录（`~/.zcode/cli/memories` 这种）。 */
  src: string
  /** 目标 plastic 记忆根。 */
  root: string
  /** 项目 hash → 真实路径的映射文件（JSON）；缺省时所有项目按 global 处理。 */
  mapFile?: string
  /** 缺省 dry-run：只出报告、零写入。 */
  apply?: boolean
  /** 报告同时写一份到这个文件（Task 7 Step 2 要落盘给人过目）。 */
  reportFile?: string
  /** 缺省交给 core 的缺省 logger（console）；CLI 路径传 stderr 版本，stdout 只留报告 JSON。 */
  log?: MemoryLogger
}

export interface ImportZcodeCliOptions {
  src: string
  root: string
  mapFile?: string
  reportFile?: string
  apply: boolean
}

const VALUE_FLAGS = new Set(['--src', '--root', '--map', '--report'])

/** 解析 `import-zcode` 子命令参数：缺必填项与未知参数都按用法错误抛出（bin 的 fail 统一收口）。 */
export function parseImportZcodeArgs(argv: string[]): ImportZcodeCliOptions {
  const values = new Map<string, string>()
  let apply = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`未知参数：${arg}\n用法：${IMPORT_ZCODE_USAGE}`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 需要值\n用法：${IMPORT_ZCODE_USAGE}`)
    values.set(arg, value)
    i += 1
  }
  const src = values.get('--src')
  const root = values.get('--root')
  if (src === undefined) throw new Error(`缺少 --src（ZCode 记忆库根目录）\n用法：${IMPORT_ZCODE_USAGE}`)
  if (root === undefined) throw new Error(`缺少 --root（目标 plastic 记忆根）\n用法：${IMPORT_ZCODE_USAGE}`)
  const mapFile = values.get('--map')
  const reportFile = values.get('--report')
  return {
    src: resolve(src),
    root: resolve(root),
    apply,
    ...(mapFile === undefined ? {} : { mapFile: resolve(mapFile) }),
    ...(reportFile === undefined ? {} : { reportFile: resolve(reportFile) }),
  }
}

/** bin 的 import-zcode 分支：解析参数 → 跑导入 → 报告写 stdout（报告文件由 importZcode 自己落盘）。 */
export async function runImportZcodeCli(argv: string[], log?: MemoryLogger): Promise<void> {
  const report = await importZcode({ ...parseImportZcodeArgs(argv), log })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

export async function importZcode(options: ImportZcodeOptions): Promise<ZcodeImportReport> {
  const src = resolve(options.src)
  const root = resolve(options.root)
  const apply = options.apply === true
  const mapFile = options.mapFile === undefined ? undefined : resolve(options.mapFile)
  const reportFile = options.reportFile === undefined ? undefined : resolve(options.reportFile)

  await assertLibrary(src)
  const projectMap = mapFile === undefined ? {} : await loadMapFile(mapFile)
  const projects = await scanProjects(src)

  const core = await createMemoryCore({ root, client: 'import-zcode', ...(options.log === undefined ? {} : { log: options.log }) })
  try {
    const existingTitles = await importedTitles(core)
    const entries: ZcodeImportEntry[] = []
    const plannedTitles = new Set<string>()
    const unknownTypes = new Map<string | null, string[]>()
    const summary: ZcodeImportSummary = {
      projects: projects.length,
      scanned: 0,
      wouldImport: 0,
      imported: 0,
      skipped: 0,
      skippedByReason: { exists: 0, 'duplicate-in-source': 0, 'parse-error': 0 },
    }

    const skip = (entry: ZcodeImportEntry, reason: ImportSkipReason): void => {
      entry.action = 'skipped'
      entry.reason = reason
      summary.skipped += 1
      summary.skippedByReason[reason] += 1
      entries.push(entry)
    }

    for (const project of projects) {
      const workspacePath = projectMap[project.hash]
      const scope = workspacePath === undefined ? 'global' as const : 'workspace' as const
      for (const file of project.files) {
        summary.scanned += 1
        const base = {
          source: file.relPath,
          title: null, zcodeType: null, type: null,
          scope, workspacePath: workspacePath ?? null, importedFrom: null,
        } satisfies Omit<ZcodeImportEntry, 'action'>

        let raw: string
        try {
          raw = await readFile(file.path, 'utf8')
        } catch (err) {
          skip({ ...base, action: 'skipped', error: `读文件失败：${describe(err)}` }, 'parse-error')
          continue
        }
        const parsed = parseZcodeMemory(raw)
        if (!parsed.ok) {
          skip({ ...base, action: 'skipped', error: parsed.error }, 'parse-error')
          continue
        }

        const memory = parsed.memory
        const mapping = mapZcodeType(memory.zcodeType)
        const entry: ZcodeImportEntry = {
          ...base,
          title: memory.title,
          zcodeType: memory.zcodeType,
          type: mapping.type,
          importedFrom: memory.importedFrom,
          action: apply ? 'imported' : 'would-import',
        }
        if (existingTitles.has(memory.title)) {
          skip(entry, 'exists')
          continue
        }
        if (plannedTitles.has(memory.title)) {
          skip(entry, 'duplicate-in-source')
          continue
        }
        if (!mapping.known) {
          const titles = unknownTypes.get(memory.zcodeType) ?? []
          titles.push(memory.title)
          unknownTypes.set(memory.zcodeType, titles)
        }

        if (apply) {
          const stamp = Date.now()
          const record: MemoryRecord = memoryRecordSchema.parse({
            id: newMemoryId(stamp),
            name: memory.title,
            type: mapping.type,
            scope,
            ...(workspacePath === undefined ? {} : { workspacePath }),
            tags: [],
            content: memory.content,
            summary: memory.summary,
            createdAt: stamp, updatedAt: stamp, lastConfirmedAt: stamp,
            lastRecalledAt: null, recallCount: 0, status: 'active',
            confidence: IMPORT_CONFIDENCE,
            'imported-from': memory.importedFrom,
          })
          await core.store.create(record)
          summary.imported += 1
        }
        summary.wouldImport += 1
        plannedTitles.add(memory.title)
        entries.push(entry)
      }
    }

    const report = buildReport({ mode: apply ? 'apply' : 'dry-run', src, root, mapFile, projectMap, projects, summary, unknownTypes, entries })
    if (reportFile !== undefined) {
      await mkdir(dirname(reportFile), { recursive: true })
      await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    }
    return report
  } finally {
    await core.close()
  }
}

/** `metadata.type` → plastic 类型名；未知值（含缺 type）归 `general`，由调用方记进报告。 */
export function mapZcodeType(zcodeType: string | null): { type: string; known: boolean } {
  if (zcodeType !== null && Object.hasOwn(ZCODE_TYPE_MAP, zcodeType)) return { type: ZCODE_TYPE_MAP[zcodeType], known: true }
  return { type: UNKNOWN_ZCODE_TYPE, known: false }
}

interface ParsedZcodeMemory {
  title: string
  summary: string
  content: string
  zcodeType: string | null
  importedFrom: string
}

/** 按 Task 4 上下文 §2 的真实格式取字段：顶层 name/description，嵌套 metadata.type / metadata.originSessionId。 */
function parseZcodeMemory(raw: string): { ok: true; memory: ParsedZcodeMemory } | { ok: false; error: string } {
  let parsed: ParsedMemoryFile
  try {
    parsed = splitFrontmatter(raw)
  } catch (err) {
    return { ok: false, error: describe(err) }
  }
  const data = parsed.data
  const title = typeof data.name === 'string' ? data.name.trim() : ''
  if (title === '') return { ok: false, error: 'frontmatter 缺少 name（记录名）' }
  const metadata = isRecord(data.metadata) ? data.metadata : {}
  const zcodeType = typeof metadata.type === 'string' && metadata.type.trim() !== '' ? metadata.type.trim() : null
  const sessionId = typeof metadata.originSessionId === 'string' ? metadata.originSessionId.trim() : ''
  const description = typeof data.description === 'string' ? data.description.trim() : ''
  return {
    ok: true,
    memory: {
      title,
      // D7：description → summary；ZCode 没写 description 时退回正文首行（summary 是必填字段，不能留空）
      summary: description === '' ? deriveSummary(parsed.body) : description,
      content: parsed.body,
      zcodeType,
      importedFrom: sessionId === '' ? ZCODE_IMPORT_PREFIX : `${ZCODE_IMPORT_PREFIX}:${sessionId}`,
    },
  }
}

/** 目标库里已导入过的 title 集合：走 core 的读路径（含 .archive/），按 `imported-from` 前缀认自己的记录。 */
async function importedTitles(core: MemoryCore): Promise<Set<string>> {
  // 含 .archive/：软删过的也算已存在，重跑导入不会把用户删掉的记忆再灌回来
  const read = await core.store.readRaw(undefined, { includeArchive: true })
  const titles = new Set<string>()
  for (const { record } of read.records) {
    if ((record['imported-from'] ?? '').startsWith(ZCODE_IMPORT_PREFIX)) titles.add(record.name)
  }
  return titles
}

interface ProjectScan {
  hash: string
  files: Array<{ path: string; relPath: string }>
}

async function assertLibrary(src: string): Promise<void> {
  const info = await stat(src).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) throw new Error(`--src 不是目录：${src}`)
  const projects = await stat(resolve(src, PROJECTS_DIR)).catch(() => undefined)
  if (projects === undefined || !projects.isDirectory()) throw new Error(`--src 下没有 ${PROJECTS_DIR} 目录，不像 ZCode 记忆库：${src}`)
}

async function scanProjects(src: string): Promise<ProjectScan[]> {
  const hashes = (await readdir(resolve(src, PROJECTS_DIR), { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  const projects: ProjectScan[] = []
  for (const hash of hashes) {
    const dir = resolve(src, PROJECTS_DIR, hash, MEMORY_DIR)
    let names: string[]
    try {
      // MEMORY.md 是索引，core 的 isMemoryFileName 一并挡掉（大小写不敏感）
      names = (await readdir(dir)).filter(isMemoryFileName).sort()
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTDIR') throw err
      projects.push({ hash, files: [] })
      continue
    }
    projects.push({
      hash,
      files: names.map(name => ({
        path: resolve(dir, name),
        relPath: `${PROJECTS_DIR}/${hash}/${MEMORY_DIR}/${name}`,
      })),
    })
  }
  return projects
}

async function loadMapFile(file: string): Promise<Record<string, string>> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    throw new Error(`读不到映射文件：${file}（${describe(err)}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`映射文件不是合法 JSON：${file}（${describe(err)}）`)
  }
  if (!isRecord(parsed)) throw new Error(`映射文件顶层必须是对象（键是项目 hash 目录名，值是项目绝对路径）：${file}`)
  const map: Record<string, string> = {}
  for (const [hash, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`映射文件里 ${hash} 的值必须是项目绝对路径：${JSON.stringify(value)}`)
    }
    if (!isAbsolute(value)) throw new Error(`映射文件里 ${hash} 的项目路径必须是绝对路径：${value}`)
    map[hash] = value
  }
  return map
}

function buildReport(input: {
  mode: ZcodeImportReport['mode']
  src: string
  root: string
  mapFile: string | undefined
  projectMap: Record<string, string>
  projects: ProjectScan[]
  summary: ZcodeImportSummary
  unknownTypes: Map<string | null, string[]>
  entries: ZcodeImportEntry[]
}): ZcodeImportReport {
  const projects: ZcodeImportProject[] = input.projects.map(project => {
    const workspacePath = input.projectMap[project.hash]
    return {
      hash: project.hash,
      files: project.files.length,
      scope: workspacePath === undefined ? 'global' : 'workspace',
      workspacePath: workspacePath ?? null,
      note: workspacePath === undefined ? '未映射，按 global 处理' : '已映射',
    }
  })
  const unknownTypes = [...input.unknownTypes.entries()]
    .map(([zcodeType, titles]) => ({ zcodeType, mappedTo: UNKNOWN_ZCODE_TYPE, titles }))
    .sort((a, b) => String(a.zcodeType).localeCompare(String(b.zcodeType)))

  const warnings = [
    ...unknownTypes.map(({ zcodeType, titles }) =>
      `未知类型 ${zcodeType ?? '(缺 type)'} 没有已知映射，按 ${UNKNOWN_ZCODE_TYPE} 导入（${titles.length} 条）：${titles.join('、')}`),
    ...projects.filter(project => project.files > 0 && project.scope === 'global')
      .map(project => `项目 ${project.hash} 未在映射文件中，按 global 处理（${project.files} 条）`),
  ]

  return {
    mode: input.mode,
    source: input.src,
    root: input.root,
    mapFile: input.mapFile ?? null,
    typeMap: { ...ZCODE_TYPE_MAP },
    summary: input.summary,
    unknownTypes,
    warnings,
    projects,
    entries: input.entries,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function errnoCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === 'string' ? err.code : undefined
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
