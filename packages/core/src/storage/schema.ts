import { z } from 'zod'
import { CHECKUP_INITIATORS } from '../contract-codes.ts'
import { autoCheckupFrequencySchema, checkupCauseSchema, checkupResultSchema } from '../gui/contract.ts'

/** 易变召回统计的侧表行（`.state/recall-stats.json` 里的一条，见 storage/sidecar.ts）。
 *  文件永不承载这两个字段——否则每次 search 命中都产生文件 diff（git 噪音）。 */
export const recallStatsSchema = z.object({
  id: z.string(),
  recallCount: z.number(),
  lastRecalledAt: z.number().nullable(),
})
export type RecallStats = z.infer<typeof recallStatsSchema>

/** 旧宿主 KV 导入的完成标记 `.state/kv-import.json`。source = none 表示宿主没有 storageDomain，无可导。
 *  counts 是成功落成文件（新建或早已存在）的旧 KV 条目数。
 *  discarded 只对 source = kv 有意义：true = 旧 KV 行已删净；false 或缺失（早先版本写的标记）= 待清理，
 *  后续启动重试删除、不重导。 */
export const kvImportMarkerSchema = z.object({
  version: z.literal(1),
  importedAt: z.number(),
  source: z.enum(['kv', 'none']),
  counts: z.object({ snapshots: z.number(), pending: z.number() }),
  discarded: z.boolean().optional(),
})
export type KvImportMarker = z.infer<typeof kvImportMarkerSchema>

/**
 * 体检记录表的一行（`.state/checkups/<sha1(id)>.json`，见 storage/sidecar.ts），每个范围一条。id 是范围键：
 * `global` 或项目的绝对路径（见 gui/contract.ts checkupKey）；另有键 `all` 的一条，只有 lastResult。
 * completed 是完成记录：这个范围最近一次做完的体检（规则检查和内容检查都写完：缓存、账本、提升候选），即「上次体检」。
 * 还没有做完过的范围没有它。
 * failure 是自动体检的连续失败（次数、下次重试时间、最近一次的原因），modelUnavailable 是最近一次自动体检的尝试碰上模型用不了的原因；
 * 都由调度器写，这个范围写完成记录时一并清掉（见 governance/checkup-records.ts）。
 * lastResult 是最近一次界面手动或自动体检的结果（见 gui/contract.ts checkupResultSchema），写完成记录、记失败都不动它。
 */
export const checkupRecordSchema = z.object({
  id: z.string(),
  completed: z.object({
    startedAt: z.number(),
    completedAt: z.number(),
    by: z.enum(CHECKUP_INITIATORS),
  }).optional(),
  /** 自动体检连续没做完：次数、最近一次失败的时刻、原因。重试时间不存，生成体检视图时按当时的有效频率现算（见 gui/views.ts）。 */
  failure: z.object({
    count: z.number().int().positive(),
    failedAt: z.number(),
    cause: checkupCauseSchema,
  }).optional(),
  modelUnavailable: checkupCauseSchema.optional(),
  lastResult: checkupResultSchema.optional(),
})
export type CheckupRecord = z.infer<typeof checkupRecordSchema>
export type CheckupCompletion = NonNullable<CheckupRecord['completed']>

/**
 * 自动体检设置表的一行（`.state/auto-checkups/<sha1(id)>.json`，见 storage/sidecar.ts），一个范围一条。id 是范围键：
 * `all`（「全部」的默认值）、`global` 或项目的绝对路径（见 gui/contract.ts checkupKey）。frequency 是 manual 或 1–90 天。
 * 没有某个范围的条目 = 跟随 `all`；没有 `all` = 仅手动，所以表空着就是全部仅手动。
 */
export const autoCheckupSettingSchema = z.object({
  id: z.string(),
  frequency: autoCheckupFrequencySchema,
})
export type AutoCheckupSetting = z.infer<typeof autoCheckupSettingSchema>

/**
 * 设置文档 `.state/settings.json`（见 storage/settings-doc.ts）：记忆库的显式改动，叠在各端自己的出厂值上。
 * 与 DSH 宿主的配置模型同构——set 是显式写下的值（嵌套对象，按键合并），unset 是从出厂值里删掉的路径（字典里的键）。
 * revision 是版本号，每次写入加一；提交时带读到的版本号，别处先改过就冲突。
 * 这里只管文件形状：有哪些字段、取值范围由插件的设置语义管（governance/memory-settings.ts），存储层不认识它们。
 */
export const settingsDocSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  set: z.record(z.string(), z.unknown()),
  unset: z.array(z.array(z.string())),
})
export type SettingsDoc = z.infer<typeof settingsDocSchema>
