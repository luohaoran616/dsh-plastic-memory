/**
 * 独立端的设置语义：出厂值、叠加解析、路径操作、校验，以及带热更新的类型表。
 * 设置文档（`.state/settings.json`，形状见 core 的 settings-doc.ts）只存「显式改动」：
 * 有效设置 = 出厂值 ⊕ set − unset，与 DSH 宿主「配置叠在 schema 默认值上」的模型同构，
 * DSH 插件下一轮接入同一份文档时不丢它已有的 yaml 定制。
 * 文件由 core 的 DocFileTable 管（锁、原子写、签名缓存），本模块只管语义，不碰文件系统。
 */

import { isDeepStrictEqual } from 'node:util'
import type { DocFileTable } from '@plastic/core/storage/settings-doc.ts'
import type { SettingsDoc } from '@plastic/core/storage/schema.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import type { MemoryTypeDefinition } from '@plastic/core/types.ts'
import { GENERAL_SCENE, OVERFLOW_MODES, type OverflowMode } from '@plastic/core/contract-codes.ts'
import { ACCENTS, type Accent } from '../gui/contract.ts'
import {
  BUILTIN_TYPES, PRESET_SCENES, buildTypeRegistry,
  type SceneConfig, type TypeRegistry, type TypeRegistryConfig,
} from '../type-registry.ts'
import type { HealthSensitivity } from './health-presets.ts'

// —— 取值词表（client/settings/config.ts 手抄一份并镜像，这边是源头） ——

/** 证据下钻的三档。 */
export const EVIDENCE_LEVELS = ['off', 'strict', 'active'] as const
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number]
/** 全局提升的去处。 */
export const PROMOTE_TARGETS = ['plugin-global', 'agents-md'] as const
export type PromoteTarget = (typeof PROMOTE_TARGETS)[number]
/** 自建类型的召回方式与治理优先级（MemoryTypeDefinition 的两个枚举字段）。 */
export const RECALL_MODES = ['core', 'search', 'passive'] as const
export const PRIORITIES = ['high', 'medium', 'low'] as const
/** 提醒灵敏度三档。 */
export const SENSITIVITIES = ['conservative', 'normal', 'proactive'] as const

/** 自建类型定义（MemoryTypeDefinition 去掉 name；customTypes 的键就是 name）。 */
export type CustomTypeDefinition = Omit<MemoryTypeDefinition, 'name'>

/** 设置文档的有效值：DSH Config 里设置页可编辑子集的形状（writeMode、search、subagent 不在独立端设置模型里）。 */
export interface MemorySettingsSection {
  /** 当前场景 id：GENERAL_SCENE（通用）或 scenes 的键。 */
  template: string
  /** 自建类型，和预设同名的一项是改过的预设。 */
  customTypes: Record<string, CustomTypeDefinition>
  scenes: Record<string, SceneConfig>
  removedPresetTypes: string[]
  snapshotTokenBudget: number
  snapshotOverflow: OverflowMode
  evidenceLookup: EvidenceLevel
  /** 独立端没有消费者：页面置灰并写明原因，值照存（DSH 插件接入后它消费）。 */
  governance: {
    enabled: boolean
    health: { sensitivity: HealthSensitivity }
    globalPromoteTarget: PromoteTarget
  }
  accent: Accent
  /** 展示用：独立端按进程环境解析，设置里改不动实际位置；缺省空串。 */
  memoryRoot: string
}

/** 出厂值：与 DSH Config 的 schema 默认值逐字段一致（tests/memory-settings-mirror.spec.ts 守住）。 */
export const DEFAULT_MEMORY_SETTINGS: MemorySettingsSection = {
  template: GENERAL_SCENE,
  customTypes: {},
  scenes: structuredClone(PRESET_SCENES),
  removedPresetTypes: [],
  snapshotTokenBudget: 4000,
  snapshotOverflow: 'relax',
  evidenceLookup: 'strict',
  governance: { enabled: true, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' },
  accent: 'ella',
  memoryRoot: '',
}

/** 一次设置写入的操作：set 整值覆盖该路径，unset 删掉该路径的显式值（回落出厂值）。 */
export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** 路径的每一段必须是非空字符串，拒绝原型链键（安全：deepSet 是普通对象赋值，`__proto__` 会改原型）。 */
function isSafePath(path: unknown): path is readonly string[] {
  return Array.isArray(path) && path.length > 0 && path.every((seg) => {
    if (typeof seg !== 'string' || seg === '') return false
    return seg !== '__proto__' && seg !== 'constructor' && seg !== 'prototype'
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** prefix 与 path 逐段相等且不长于 path。 */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((seg, i) => seg === path[i])
}

/** 在树上整值覆盖 path（沿途克隆，遇标量按缺省的空对象往下开）。返回新树，不动原树。 */
function deepSet(tree: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path
  if (rest.length === 0) return { ...tree, [head]: value }
  const child = tree[head]
  const base = isPlainObject(child) ? child : {}
  return { ...tree, [head]: deepSet(base, rest, value) }
}

/** 从树上删掉 path（缺了就是没有可删的），删空的对象父级一并剪掉。返回新树；没有可删的回 undefined。 */
function deepDelete(tree: Record<string, unknown>, path: readonly string[]): Record<string, unknown> | undefined {
  const [head, ...rest] = path
  if (!Object.hasOwn(tree, head)) return undefined
  if (rest.length === 0) {
    const copy = { ...tree }
    delete copy[head]
    return copy
  }
  const child = tree[head]
  if (!isPlainObject(child)) return undefined
  const next = deepDelete(child, rest)
  if (next === undefined) return undefined
  const copy = { ...tree, [head]: next }
  if (Object.keys(next).length === 0) delete copy[head]
  return copy
}

/**
 * 把操作落到文档的 set 与 unset 上（纯函数，不改入参 doc）：
 * set 深写入 set 树，并丢掉它是自己前缀（含相等）的 unset 条目——设置一个路径覆盖先前对它及其祖先的删除；
 * unset 从 set 树删除（空对象父级剪掉），丢掉被它覆盖（相等或更深）的 unset 条目，再记进 unset 列表。
 * set 与 unset 都没变时不加版本号。路径不合法收集进 issues，整个操作不落。
 */
export function applySettingsOps(doc: SettingsDoc, ops: readonly SettingsPathOp[]): { ok: true; doc: SettingsDoc } | { ok: false; issues: string[] } {
  const issues: string[] = []
  let set: Record<string, unknown> = { ...doc.set }
  let unset: string[][] = doc.unset.map(path => [...path])
  for (const [i, op] of ops.entries()) {
    if (!isSafePath(op.path)) {
      issues.push(`第 ${i + 1} 个操作的路径不合法：${JSON.stringify(op.path)}`)
      continue
    }
    if (op.op === 'set') {
      set = deepSet(set, op.path, op.value)
      unset = unset.filter(u => !isPrefix(u, op.path))
    } else {
      const next = deepDelete(set, op.path)
      if (next !== undefined) set = next
      unset = unset.filter(u => !isPrefix(op.path, u))
      unset.push([...op.path])
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  if (isDeepStrictEqual(set, doc.set) && isDeepStrictEqual(unset, doc.unset)) return { ok: true, doc }
  return { ok: true, doc: { version: 1, revision: doc.revision + 1, set, unset } }
}

// —— 校验 ——

const TYPE_NAME_RE = /^[a-z]+(?:-[a-z]+)*$/
const BUILTIN_TYPE_NAMES = BUILTIN_TYPES.map(t => t.name)

function oneOfIssue<T extends string>(choices: readonly T[], value: unknown, label: string): string | undefined {
  return (choices as readonly unknown[]).includes(value) ? undefined : `${label}: 必须是 ${choices.join(' / ')} 之一`
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

/**
 * 校验有效设置。只卡会让类型表崩掉或数值无意义的项（枚举、正整数、类型名格式、与内置类型重名）；
 * 场景里列了不存在的类型、removedPresetTypes 里的陌生名字都由 buildTypeRegistry 警告并忽略，不在这拒。
 * 回问题列表，空数组 = 合法。上层的页面提交与 resolve 都走它。
 */
export function validateMemorySettings(value: unknown): string[] {
  const issues: string[] = []
  if (!isPlainObject(value)) return [`设置段必须是对象`]
  if (!isNonEmptyString(value.template)) issues.push('template: 必须是非空字符串')
  const budget = value.snapshotTokenBudget
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget <= 0) issues.push('snapshotTokenBudget: 必须是正整数')
  issues.push(...pickIssue(oneOfIssue(OVERFLOW_MODES, value.snapshotOverflow, 'snapshotOverflow')))
  issues.push(...pickIssue(oneOfIssue(EVIDENCE_LEVELS, value.evidenceLookup, 'evidenceLookup')))
  issues.push(...pickIssue(oneOfIssue(ACCENTS, value.accent, 'accent')))

  const gov = value.governance
  if (!isPlainObject(gov)) {
    issues.push('governance: 必须是对象')
  } else {
    if (typeof gov.enabled !== 'boolean') issues.push('governance.enabled: 必须是布尔值')
    const health = gov.health
    if (!isPlainObject(health)) {
      issues.push('governance.health: 必须是对象')
    } else {
      issues.push(...pickIssue(oneOfIssue(SENSITIVITIES, health.sensitivity, 'governance.health.sensitivity')))
    }
    issues.push(...pickIssue(oneOfIssue(PROMOTE_TARGETS, gov.globalPromoteTarget, 'governance.globalPromoteTarget')))
  }

  const types = value.customTypes
  if (!isPlainObject(types)) {
    issues.push('customTypes: 必须是对象')
  } else {
    for (const [name, def] of Object.entries(types)) {
      if (!TYPE_NAME_RE.test(name)) { issues.push(`customTypes.${name}: 类型名必须是小写字母和连字符`); continue }
      if (BUILTIN_TYPE_NAMES.includes(name)) { issues.push(`customTypes.${name}: 与内置类型重名，内置五类不可覆盖`); continue }
      if (!isPlainObject(def)) { issues.push(`customTypes.${name}: 必须是对象`); continue }
      for (const field of ['label', 'description', 'whenToSave'] as const) {
        if (!isNonEmptyString(def[field])) issues.push(`customTypes.${name}.${field}: 必须是非空字符串`)
      }
      if (def.howToUse !== undefined && typeof def.howToUse !== 'string') issues.push(`customTypes.${name}.howToUse: 必须是字符串`)
      issues.push(...pickIssue(oneOfIssue(RECALL_MODES, def.recall, `customTypes.${name}.recall`)))
      const decay = def.decayDays
      if (decay !== null && (typeof decay !== 'number' || !Number.isSafeInteger(decay) || decay <= 0)) {
        issues.push(`customTypes.${name}.decayDays: 必须是 null 或正整数`)
      }
      issues.push(...pickIssue(oneOfIssue(PRIORITIES, def.governancePriority, `customTypes.${name}.governancePriority`)))
    }
  }

  const scenes = value.scenes
  if (!isPlainObject(scenes)) {
    issues.push('scenes: 必须是对象')
  } else {
    for (const [id, scene] of Object.entries(scenes)) {
      if (id === GENERAL_SCENE) { issues.push(`scenes.${id}: ${GENERAL_SCENE} 是通用场景的保留 id，不能作为场景`); continue }
      if (!isPlainObject(scene)) { issues.push(`scenes.${id}: 必须是对象`); continue }
      if (!isNonEmptyString(scene.label)) issues.push(`scenes.${id}.label: 必须是非空字符串`)
      if (!Array.isArray(scene.types) || !scene.types.every(name => typeof name === 'string')) {
        issues.push(`scenes.${id}.types: 必须是字符串数组`)
      }
    }
  }

  if (!Array.isArray(value.removedPresetTypes) || !value.removedPresetTypes.every(name => typeof name === 'string')) {
    issues.push('removedPresetTypes: 必须是字符串数组')
  }
  if (typeof value.memoryRoot !== 'string') issues.push('memoryRoot: 必须是字符串')
  return issues
}

function pickIssue(issue: string | undefined): string[] {
  return issue === undefined ? [] : [issue]
}

// —— 叠加解析 ——

/** 深合并：两边都是对象才逐键并，其余（数组、标量）整值替换。 */
function overlay(base: unknown, over: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(over)) return over
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(over)) out[key] = overlay(base[key], value)
  return out
}

/** 有效设置 = 出厂值 ⊕（set − unset）：unset 只删显式改动（回落出厂值），出厂值本身不受 unset 影响。返回全新对象，不合法抛 MemorySettingsError。 */
export function resolveMemorySettings(doc: SettingsDoc | undefined): MemorySettingsSection {
  let set: Record<string, unknown> = { ...(doc?.set ?? {}) }
  for (const path of doc?.unset ?? []) {
    const next = deepDelete(set, path)
    if (next !== undefined) set = next
  }
  const value = overlay(structuredClone(DEFAULT_MEMORY_SETTINGS), set) as Record<string, unknown>
  const issues = validateMemorySettings(value)
  if (issues.length > 0) throw new MemorySettingsError(issues)
  // 克隆一份：结果不与文档缓存共享子树，消费方改了也不影响下次解析
  return structuredClone(value) as unknown as MemorySettingsSection
}

/** 设置不合法（页面提交被 400 拒；文件读得出但语义不对按出厂值运行并报警）。 */
export class MemorySettingsError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`记忆设置不合法：${issues.join('；')}`)
    this.issues = issues
    this.name = 'MemorySettingsError'
  }
}

// —— 设置门面 ——

/** 设置快照：页面读到的现状。unavailable = 坏文件或语义不对：页面显示不可用，写入被拒。 */
export type MemorySettingsSnapshot =
  | { status: 'ready'; revision: number; value: MemorySettingsSection; writable: true }
  | { status: 'unavailable'; reason: 'corrupt' | 'invalid'; detail: string }

export type MemorySettingsMutateResult =
  | { ok: true; value: MemorySettingsSection; revision: number }
  | { ok: false; reason: 'conflict'; current?: { revision: number; value: MemorySettingsSection } }
  | { ok: false; reason: 'invalid'; issues: string[] }
  | { ok: false; reason: 'unavailable'; detail: string }

/** 设置的读改口子：GUI 平面、类型表都只认这个结构，不认 DocFileTable。 */
export interface MemorySettingsPort {
  snapshot(): Promise<MemorySettingsSnapshot>
  /** 有效设置。文件坏了或语义不对时按出厂值运行，报警一次（同一原因不重复报）。 */
  current(): Promise<MemorySettingsSection>
  /** 带版本号提交一批操作。expectedRevision 不符回 conflict（带当前值供重读）；提交内容不合法回 invalid，什么都不写。 */
  mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<MemorySettingsMutateResult>
}

const EMPTY_DOC: SettingsDoc = { version: 1, revision: 0, set: {}, unset: [] }

/** 设置文档的语义门面：DocFileTable 之上加出厂值叠加、校验和「坏文件按出厂值运行、不覆盖」的取舍。 */
export class MemorySettings implements MemorySettingsPort {
  private readonly table: DocFileTable<SettingsDoc>
  private readonly log: MemoryLogger
  /** 报过警的「按出厂值运行」原因：文件修好或换成新问题才再报。 */
  private warnedFallback: string | undefined

  constructor(table: DocFileTable<SettingsDoc>, log: MemoryLogger) {
    this.table = table
    this.log = log
  }

  async snapshot(): Promise<MemorySettingsSnapshot> {
    const raw = await this.table.read()
    if (raw.status === 'missing') {
      return { status: 'ready', revision: 0, value: structuredClone(DEFAULT_MEMORY_SETTINGS), writable: true }
    }
    if (raw.status === 'corrupt') {
      return { status: 'unavailable', reason: 'corrupt', detail: raw.detail }
    }
    try {
      return { status: 'ready', revision: raw.doc.revision, value: resolveMemorySettings(raw.doc), writable: true }
    } catch (err) {
      return { status: 'unavailable', reason: 'invalid', detail: describe(err) }
    }
  }

  async current(): Promise<MemorySettingsSection> {
    const raw = await this.table.read()
    if (raw.status === 'missing') return structuredClone(DEFAULT_MEMORY_SETTINGS)
    if (raw.status === 'corrupt') return this.fallback(`设置文件读不出来，按出厂值运行、不覆盖它（${raw.detail}）`)
    try {
      return resolveMemorySettings(raw.doc)
    } catch (err) {
      return this.fallback(`设置不合法，按出厂值运行（${describe(err)}）`)
    }
  }

  private fallback(message: string): MemorySettingsSection {
    if (this.warnedFallback !== message) {
      this.warnedFallback = message
      this.log.warn(`[plastic-memory] ${message}`)
    }
    return structuredClone(DEFAULT_MEMORY_SETTINGS)
  }

  async mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<MemorySettingsMutateResult> {
    let invalid: MemorySettingsError | undefined
    const result = await this.table.mutate((current) => {
      const base = current ?? EMPTY_DOC
      const applied = applySettingsOps(base, ops)
      if (!applied.ok) {
        invalid = new MemorySettingsError(applied.issues)
        throw invalid
      }
      try {
        resolveMemorySettings(applied.doc)
      } catch (err) {
        if (err instanceof MemorySettingsError) {
          invalid = err
          throw err
        }
        throw err
      }
      return applied.doc
    }, expectedRevision).catch((err: unknown) => {
      if (err === invalid) return { ok: false as const, reason: 'invalid' as const, issues: invalid!.issues }
      throw err
    })
    if (!result.ok) {
      if (result.reason === 'invalid') return { ok: false, reason: 'invalid', issues: result.issues }
      if (result.reason === 'corrupt') return { ok: false, reason: 'unavailable', detail: '设置文件读不出来，先修好 .state/settings.json 再提交' }
      if (result.current === undefined) return { ok: false, reason: 'conflict' }
      try {
        return { ok: false, reason: 'conflict', current: { revision: result.current.revision, value: resolveMemorySettings(result.current) } }
      } catch {
        return { ok: false, reason: 'conflict' }
      }
    }
    if (result.doc === undefined) {
      // 到不了这里（fn 总是回下一份文档）；按重读兜底，保持返回形状完整。
      const snap = await this.snapshot()
      return snap.status === 'ready'
        ? { ok: true, value: snap.value, revision: snap.revision }
        : { ok: false, reason: 'unavailable', detail: snap.detail }
    }
    return { ok: true, value: resolveMemorySettings(result.doc), revision: result.doc.revision }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// —— 设置驱动的类型表 ——

/** 设置驱动的类型表：registry 是转发对象，refresh 后各处手里的引用不用换。 */
export interface SettingsBackedRegistry {
  registry: TypeRegistry
  /** 重读设置；场景与类型配置变了就重建表、回 true，否则 false。 */
  refresh(): Promise<boolean>
}

/** 类型表认哪几个设置字段，变了才重建。 */
function registryKey(value: MemorySettingsSection): string {
  return JSON.stringify([value.template, value.customTypes, value.scenes, value.removedPresetTypes])
}

/**
 * 从设置门面建类型表。构造时按当前有效设置建好；此后每次工具调用前 refresh 一次，
 * 文档变了重建背后的表（场景写错按 buildTypeRegistry 的警告运行，不抛）。
 */
export async function createSettingsRegistry(settings: MemorySettingsPort, log: MemoryLogger): Promise<SettingsBackedRegistry> {
  const configOf = (value: MemorySettingsSection): TypeRegistryConfig => ({
    template: value.template,
    customTypes: value.customTypes,
    scenes: value.scenes,
    removedPresetTypes: value.removedPresetTypes,
  })
  const build = async (): Promise<{ built: TypeRegistry; key: string }> => {
    const value = await settings.current()
    const built = buildTypeRegistry(configOf(value))
    for (const warning of built.warnings) log.warn(`[plastic-memory] ${warning}`)
    return { built, key: registryKey(value) }
  }
  let state = await build()
  const registry: TypeRegistry = {
    get: name => state.built.get(name),
    has: name => state.built.has(name),
    all: () => state.built.all(),
    renderSaveDescription: () => state.built.renderSaveDescription(),
  }
  return {
    registry,
    async refresh() {
      const next = await build()
      if (next.key === state.key) return false
      state = next
      return true
    },
  }
}
