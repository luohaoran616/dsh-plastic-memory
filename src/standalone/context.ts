/**
 * 上下文平面：独立端（MCP server、hook、页面后端）共用的无宿主装配——存储 + 设置 + 类型表 + 快照 + 写入管线 + 检索。
 * 与 GUI 平面（plane.ts）的差别：这里没有视图、命令与调度，只有「把记忆带进模型上下文」和「把模型的写入落库」两件事。
 * serve 进程里 MCP 工具与 GUI 平面建在同一个上下文平面上：一张文件表、一份设置、一张类型表（顺带收掉
 * 上一轮记的「serve 进程里两个 FileTable 不互斥」）。
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { z } from 'zod'
import { formatIndexLine } from '@plastic/core/index-line.ts'
import { createMemorySearch, type SearchInput, type SearchResult } from '@plastic/core/factory.ts'
import type { RootLock } from '@plastic/core/root-lock.ts'
import { FileTable } from '@plastic/core/storage/file-table.ts'
import { createRootLock } from '@plastic/core/storage/root-lock.ts'
import { SidecarStore } from '@plastic/core/storage/sidecar.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { MemoryStore } from '@plastic/core/store.ts'
import { PendingDecisionsStore } from '../governance/decisions.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../governance/schema.ts'
import { MemorySettings, createSettingsRegistry } from '../governance/memory-settings.ts'
import { SnapshotStore } from '../governance/snapshots.ts'
import { runSavePipeline, type PipelineResult, type SaveInput } from '../pipeline.ts'
import { prereadSnapshot } from '../runtime.ts'
import { assembleSnapshot, type SnapshotUsage } from '../snapshot.ts'
import type { TypeRegistry } from '../type-registry.ts'
import { goneCopies } from '../tools/workspace-gate.ts'

/** 上下文平面的参数：记忆根必给；项目、客户端标识、日志、时钟、写锁可选（锁缺省自建一把，同进程多平面注入同一把）。 */
export interface ContextPlaneOptions {
  memoryRoot: string
  /** 客户端标识（PLASTIC_CLIENT）：写入路径拿它标记记录来源（`mcp:<client>`）。 */
  client?: string
  /** 各端配置里写死的那个项目（PLASTIC_PROJECT）：resolveProject 缺省时用它。不带时快照只带全局、save 无项目落点。 */
  project?: string
  log?: MemoryLogger
  now?: () => number
  /** 记忆根写锁：注入则用注入的那把，缺省自建一把。 */
  lock?: RootLock
}

/** 侧表存储的实例类型（schema 槽位定死，泛型跟着定死）。 */
type PlaneSidecar = SidecarStore<
  z.infer<typeof memorySnapshotSchema>,
  z.infer<typeof pendingDecisionSchema>,
  z.infer<typeof scanCacheSchema>,
  z.infer<typeof adviceIgnoreSchema>
>

/** 上下文平面。settings 是具体类（GUI 平面要它的 snapshot/mutate）；registry 是转发对象，refresh 后引用不用换。 */
export interface ContextPlane {
  readonly memoryRoot: string
  readonly client: string
  readonly project: string | undefined
  readonly lock: RootLock
  readonly sidecar: PlaneSidecar
  readonly store: MemoryStore
  readonly snapshots: SnapshotStore
  readonly decisions: PendingDecisionsStore
  readonly settings: MemorySettings
  readonly registry: TypeRegistry
  /** 重读设置文档；场景与类型配置变了就重建类型表、回 true（MCP 工具面据此重注册工具）。 */
  refresh(): Promise<boolean>
  /**
   * project 参数 → 会话项目路径：`'global'` 或不存在的路径回 undefined（快照只带全局、save 无项目落点）；
   * 缺省用装配时的 project；给定的必须是已存在目录的绝对路径，realpath 之后返回。
   */
  resolveProject(project?: string): Promise<string | undefined>
  search(input: SearchInput): Promise<SearchResult>
  /** 快照原文 + 用量。纯读：不冻结、不计召回、不跑目录维护（与 DSH 冻结快照的两点差别）。workspacePath 缺省只带全局。 */
  snapshot(workspacePath: string | undefined): Promise<{ text: string } & SnapshotUsage>
  /** 写入走与 DSH 同一条管线（结构去重、疑似密钥拦截、更新、取代、有效期、快照先行）。 */
  save(input: SaveInput, workspacePath: string | undefined, sessionId: string): Promise<PipelineResult>
}

/** 侧表四张的 schema 槽位（与 GUI 平面同一份）。 */
const SIDE_SCHEMAS = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }

export async function createContextPlane(options: ContextPlaneOptions): Promise<ContextPlane> {
  const memoryRoot = options.memoryRoot
  const log = options.log ?? console
  const now = options.now ?? Date.now
  // 记忆根写锁：这个平面实例一把，注入文件表与侧表（同实例内按计数嵌套）
  const rootLock = options.lock ?? createRootLock({ root: memoryRoot, log })
  // 侧表与设置文档都住 <memoryRoot>/.state/（快照、待决账本、扫描缓存、建议忽略、召回统计、settings.json）
  const sidecar = new SidecarStore({
    root: memoryRoot,
    lock: rootLock,
    schemas: SIDE_SCHEMAS,
    /** 探针：独立面够不着宿主 storageDomain，不写结清标记，宿主下次再探。 */
    openLegacyKv: async () => undefined,
    log,
    now,
  })
  // 设置语义 + 设置驱动的类型表：文档变了重建背后的表（场景写错按 buildTypeRegistry 的警告运行，不抛）
  const settings = new MemorySettings(sidecar.settings, log)
  const backed = await createSettingsRegistry(settings, log)
  // 索引行的 passive 标注按类型表现算（转发对象，refresh 后同一引用读到的就是新表）
  const fileTable = new FileTable({
    root: memoryRoot,
    lock: rootLock,
    stats: sidecar.recallStats,
    formatIndexLine: (r, file) => formatIndexLine(r, { passive: backed.registry.get(r.type).recall === 'passive', file }),
    log,
  })
  const store = new MemoryStore(fileTable, log, sidecar.recallStats)
  // 管线要的两件治理存储：改写、替代的快照先行与撤销记录，独立端同接
  const decisions = new PendingDecisionsStore(sidecar.pending, rootLock)
  const snapshots = new SnapshotStore(sidecar.snapshots, { findGone: goneCopies(store) })
  const search = createMemorySearch({ store, log })
  const resolveProject = async (project?: string): Promise<string | undefined> => {
    if (project === 'global') return undefined
    const requested = project ?? options.project
    if (requested === undefined || !isAbsolute(requested)) return undefined
    try {
      return await realpath(requested)
    } catch {
      return undefined
    }
  }
  return {
    memoryRoot,
    client: options.client ?? 'unknown',
    project: options.project,
    lock: rootLock,
    sidecar,
    store,
    snapshots,
    decisions,
    settings,
    registry: backed.registry,
    refresh: () => backed.refresh(),
    resolveProject,
    search,
    snapshot: async workspacePath => {
      const pre = await prereadSnapshot(store, workspacePath)
      const value = await settings.current()
      return assembleSnapshot({
        records: pre.records,
        files: pre.files,
        quarantinedCount: pre.quarantinedCount,
        registry: backed.registry,
        workspacePath,
        budget: value.snapshotTokenBudget,
        overflow: value.snapshotOverflow,
        evidenceLookup: value.evidenceLookup,
        memoryRoot,
        now: now(),
      })
    },
    // 事件区间占位（独立端没有宿主事件流，证据锚按整会话兜底）；无子会话委派
    save: (input, workspacePath, sessionId) => runSavePipeline(input, {
      store,
      registry: backed.registry,
      workspacePath,
      session: { id: sessionId, lastSeq: 0 },
      snapshots,
      decisions,
      now,
    }),
  }
}
