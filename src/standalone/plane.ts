import { spawn } from 'node:child_process'
import { readFile as readText, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { formatIndexLine } from '@plastic/core/index-line.ts'
import type { RootLock } from '@plastic/core/root-lock.ts'
import { agentsMdPath, createAgentsMdWriter } from '@plastic/core/storage/agents-md.ts'
import { FileTable } from '@plastic/core/storage/file-table.ts'
import { createRootLock } from '@plastic/core/storage/root-lock.ts'
import { SidecarStore } from '@plastic/core/storage/sidecar.ts'
import { MemoryStore, type MemoryLogger } from '@plastic/core/store.ts'
import { buildTypeRegistry, PRESET_SCENES } from '../type-registry.ts'
import { AutoCheckupSettingStore } from '../governance/auto-checkups.ts'
import { AdviceIgnoreStore } from '../governance/advice-ignores.ts'
import { CheckupRecordStore } from '../governance/checkup-records.ts'
import { PendingDecisionsStore } from '../governance/decisions.ts'
import { createInstructionReader, type ReadInstructions } from '../governance/instructions.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../governance/schema.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import { SnapshotStore } from '../governance/snapshots.ts'
import { goneCopies } from '../tools/workspace-gate.ts'
import { AutoCheckupScheduler, type AutoCheckupTimer } from '../gui/auto-checkup.ts'
import { CheckupSuggestions } from '../gui/checkup-suggestions.ts'
import { createMemoryCommand } from '../gui/commands.ts'
import {
  GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_WORKSPACE_MAP_FILE, MEMORY_COMMAND_NAME,
} from '../gui/contract.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../gui/view-writer.ts'
import { createStandaloneHost } from './host.ts'

export { STANDALONE_SESSION_ID } from './host.ts'

/** 可读的视图文件：四个全局视图、体检视图、会话归属对照。 */
export type GuiViewName = 'pending' | 'health' | 'library' | 'deleted' | 'checkups' | 'workspaces'

/** 无宿主装配的参数：记忆根、写死的项目，以及可选的模型、自动体检、打开实现、指令读取、日志与时钟。 */
export interface GuiPlaneOptions {
  memoryRoot: string
  /** 各端配置里写死的那个项目（PLASTIC_PROJECT）；不带作用域的命令按它定位。 */
  project: string
  llm?: SemanticLlm | null
  /** 缺省 false：不启动自动体检调度器（spec D8）。 */
  autoCheckup?: boolean
  /** 打开与显示文件的实现；缺省 xdg-open。 */
  open?: (path: string, action: 'open' | 'reveal') => Promise<boolean>
  instructions?: ReadInstructions
  log?: MemoryLogger
  now?: () => number
  /** 记忆根写锁：注入则用注入的那把，缺省自建一把。同一进程里 core 与平面共用一个记忆根时注入同一把。 */
  lock?: RootLock
}

/** 无宿主装配的平面：/memory 命令入口、视图文件读取、记忆根内文件的读取与打开、释放。 */
export interface GuiPlane {
  readonly memoryRoot: string
  readonly project: string
  /** 跑一条 `/memory` 命令行，与宿主命令处理器同一个入口。 */
  run(rawInput: string): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  readView(name: GuiViewName): Promise<{ status: 'ready'; text: string } | { status: 'missing' }>
  /** 记忆根内的文件全文；根外（含符号链接指向根外）或读不到为 undefined。 */
  readFile(path: string): Promise<string | undefined>
  /** 根外拒绝并返回 false。 */
  openPath(path: string, action: 'open' | 'reveal'): Promise<boolean>
  dispose(): Promise<void>
}

/** 视图名 → 视图目录里的文件名（同名标识符由契约给）。 */
const VIEW_FILES: Readonly<Record<GuiViewName, string>> = {
  pending: GUI_VIEW_FILES.pending, health: GUI_VIEW_FILES.health,
  library: GUI_VIEW_FILES.library, deleted: GUI_VIEW_FILES.deleted,
  checkups: GUI_CHECKUP_VIEW_FILE, workspaces: GUI_WORKSPACE_MAP_FILE,
}

/**
 * 无宿主时的指令文件读取：不能 import 宿主的指令文件包（那会把框架运行时带进独立装配的闭包），
 * 一律按「取不到」返回并带原因；要按项目读 AGENTS.md / CLAUDE.md 时由调用方注入 instructions。
 * 结果是 createInstructionReader 的三种之一，调用方不处理异常。
 */
export const standaloneInstructions: ReadInstructions = createInstructionReader(async () => {
  throw new Error('独立装配不加载宿主的指令文件包，指令文件按取不到处理')
})

/** 缺省的打开实现：xdg-open；reveal 打开文件所在目录。返回命令是否起得起来，打不开为 false。 */
const xdgOpen = (path: string, action: 'open' | 'reveal'): Promise<boolean> => new Promise(resolve => {
  const child = spawn('xdg-open', [action === 'reveal' ? dirname(path) : path], { stdio: 'ignore', detached: true })
  child.once('error', () => resolve(false))
  child.once('spawn', () => { child.unref(); resolve(true) })
})

/** 去掉 `/memory` 前缀：命令处理器收的是命令名之后的原文，界面与 HTTP 层习惯传整行。 */
function commandInput(rawInput: string): string {
  const text = rawInput.trim()
  const prefix = `/${MEMORY_COMMAND_NAME}`
  if (text === prefix) return ''
  return text.startsWith(`${prefix} `) || text.startsWith(`${prefix}\t`) ? text.slice(prefix.length).trim() : text
}

/** 目标在根内：按路径段比较（`/a/mem` 不算 `/a/mem-sibling` 的祖先），根自身算根内。 */
function isWithin(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * 无宿主装配：把 /memory 命令处理器与视图平面按 src/index.ts 的接线顺序装起来，不接框架运行时。
 * 创建时就写一遍全局视图、体检视图与会话归属（首次启动、别的进程删了 .state/gui 时页面也有内容可读）；
 * 返回的 readFile / openPath 只碰记忆根内的真实文件，符号链接指到根外同样拒绝。
 */
export async function createGuiPlane(options: GuiPlaneOptions): Promise<GuiPlane> {
  const memoryRoot = options.memoryRoot
  const project = options.project
  const log = options.log ?? console
  const now = options.now ?? Date.now
  const open = options.open ?? xdgOpen
  // 健康视图带给右侧栏，判断冻结快照是否早于这次启动
  const bootedAt = now()
  // 独立进程没有配置面：治理始终按开启运行，自动体检由 autoCheckup 开关决定
  const isGovernanceEnabled = () => true
  const llmOf = () => options.llm ?? null

  // 记忆根写锁：这个装配实例一把，注入文件表、侧表、待决账本、视图写入器（同实例内按计数嵌套）
  const rootLock = options.lock ?? createRootLock({ root: memoryRoot, log })
  // 侧表（快照、待决账本、扫描缓存、建议忽略、体检记录、自动体检设置）住 <memoryRoot>/.state/。
  // 探针：独立面够不着宿主 storageDomain，不写「没有旧 KV」的结清标记，宿主下次再探
  const sidecar = new SidecarStore({
    root: memoryRoot,
    lock: rootLock,
    schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema },
    /** 探针：独立面够不着宿主 storageDomain，不写结清标记，宿主下次再探。 */
    openLegacyKv: async () => undefined,
    log,
    now,
  })
  // 类型表取 schema 缺省（通用场景、没有自建类型）；独立装配没有配置热更新，建一次就够
  const registry = buildTypeRegistry({ template: 'custom', customTypes: {}, scenes: PRESET_SCENES, removedPresetTypes: [] })
  for (const warning of registry.warnings) log.warn(`[plastic-memory] ${warning}`)
  // 纯逻辑层不 import 框架包，日志经 MemoryLogger 注入；索引行的陈旧度按类型表的 recall 现算（同宿主接线）
  const fileTable = new FileTable({
    root: memoryRoot,
    lock: rootLock,
    stats: sidecar.recallStats,
    formatIndexLine: (r, file) => formatIndexLine(r, { passive: registry.get(r.type).recall === 'passive', file }),
    log,
  })
  const store = new MemoryStore(fileTable, log, sidecar.recallStats)
  // 五个治理存储：forget 的快照先行、待决账本清理与 GUI 视图都要它们，独立进程里同样全接
  const decisions = new PendingDecisionsStore(sidecar.pending, rootLock)
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
  const scanCache = sidecar.scanCache
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const checkups = new CheckupRecordStore(sidecar.checkups)
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  // 提升到 AGENTS.md 的目标与宿主同一个位置（从 DSH_HOME 独立解析，不从 memoryRoot 反推）
  const agentsMd = createAgentsMdWriter(agentsMdPath())
  // 独立装配读不到宿主的指令文件包：缺省一律按取不到，调用方可注入按项目读的实现
  const instructions = options.instructions ?? standaloneInstructions
  // 没有真会话：固定项目、深度 0、固定会话 id；自动体检用同一个模型来源（宿主里是默认模型）
  const host = createStandaloneHost({ project, llm: llmOf })
  // 记忆页的打开按钮：只放行记忆根内的真实路径（符号链接解析后再比），根外返回 false
  const resolveInRoot = async (path: string): Promise<string | undefined> => {
    let base: string
    let target: string
    try {
      [base, target] = await Promise.all([realpath(memoryRoot), realpath(path)])
    } catch {
      return undefined
    }
    return isWithin(base, target) ? target : undefined
  }
  // 体检视图与自动体检调度共用的读法：设置表、完成记录、目录清单，不读记忆文件
  const checkupSource = { store, checkups, autoCheckups, cache: scanCache, isGovernanceEnabled, now }
  // 体检之后的后续段：给冲突逐条生成处理建议（手动、自动体检共用一份），进程内的「正在生成」标记随待处理视图写出
  let views: ViewWriter | undefined
  const checkupSuggestions = new CheckupSuggestions({
    store, decisions, checkups, getReadEvent: () => null, instructions,
    views: { request: async names => { await views?.request(names) }, requestCheckups: async () => { await views?.requestCheckups() } },
    now, log,
  })
  // 四个全局视图的收集：视图写入器与自动体检（体检前后比出新增）共用
  const collectViews = () => collectGlobalViews({
    store, decisions, snapshots, cache: scanCache, ignores, checkups, autoCheckups, registry, memoryRoot,
    isGovernanceEnabled, bootedAt, log, now,
    generatingSuggestions: () => checkupSuggestions.generatingIds(),
  })
  const writer = new ViewWriter({
    memoryRoot, log, lock: rootLock, now,
    collect: collectViews,
    collectCheckups: () => collectCheckupView(checkupSource),
  })
  views = writer
  // 创建即写出：全局视图、体检视图、这个项目自己的会话归属（首次启动、别的进程删了 .state/gui 时页面不空白）
  await writer.requestWorkspace(project, project)
  await writer.rewriteAll()
  await writer.requestCheckups()
  // 卸载时取消手动体检之后还在跑的后续段（不等在途的模型调用）
  const unload = new AbortController()
  let scheduler: AutoCheckupScheduler | undefined
  const command = createMemoryCommand({
    memoryRoot, store, decisions, snapshots, cache: scanCache, checkups, autoCheckups, ignores, registry, agentsMd, views: writer, instructions,
    onAutoCheckupChanged: () => { void scheduler?.recheck() },
    suggestions: checkupSuggestions, signal: unload.signal,
    host, log, now, isGovernanceEnabled,
    isLegacyImportSettled: () => sidecar.isLegacyImportSettled(),
    getReadEvent: () => null,
  })
  if (options.autoCheckup === true) {
    // 独立进程自己的计时：setTimeout / setInterval，停掉函数返回给调度器；不拖住进程退出
    const timer: AutoCheckupTimer = {
      timeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs)
        handle.unref()
        return () => clearTimeout(handle)
      },
      interval: (callback, delayMs) => {
        const handle = setInterval(callback, delayMs)
        handle.unref()
        return () => clearInterval(handle)
      },
    }
    const created = new AutoCheckupScheduler({
      scan: { store, registry, decisions, cache: scanCache, ignores, instructions },
      checkups,
      views: { collectViews, rewriteAll: async () => views?.rewriteAll() },
      status: () => collectCheckupView(checkupSource),
      host: { defaultLlm: llmOf },
      isGovernanceEnabled,
      timer,
      onChecked: async () => { await writer.requestCheckups() },
      onClaimChanged: async () => { await writer.requestCheckups() },
      suggestions: checkupSuggestions,
      now, log,
    })
    scheduler = created
    created.start()
  }

  let isDisposed = false
  return {
    memoryRoot,
    project,
    run: rawInput => command.handler({ rawInput: commandInput(rawInput) }),
    readView: async name => {
      const path = join(memoryRoot, GUI_VIEW_DIR, VIEW_FILES[name])
      try {
        return { status: 'ready', text: await readText(path, 'utf8') }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('[plastic-memory] 读不到 GUI 视图文件', err)
        return { status: 'missing' }
      }
    },
    readFile: async path => {
      const target = await resolveInRoot(path)
      if (target === undefined) return undefined
      return await readText(target, 'utf8').catch(() => undefined)
    },
    openPath: async (path, action) => {
      // 交给 opener 的是解析后的目标：校验过的那一份就是被打开的那一份
      const target = await resolveInRoot(path)
      if (target === undefined) return false
      return await open(target, action)
    },
    dispose: async () => {
      if (isDisposed) return
      isDisposed = true
      unload.abort(new DOMException('plane disposed', 'AbortError'))
      await scheduler?.dispose()
      // 被取消的后续段要到之后的微任务才收尾，那时写入器已撤下：这里先清标记、重写一次待处理视图
      checkupSuggestions.clearMarks()
      await writer.request(['pending']).catch(() => {})
      await writer.dispose()
    },
  }
}
