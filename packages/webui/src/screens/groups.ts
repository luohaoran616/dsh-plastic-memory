/** 浏览与归档共用的分组：全局一组，其余按项目目录分组（D5「浏览按项目/全局分组」）。 */
import type { RecordView } from '../gateway.impl.ts'
import { baseName, type Translate } from '../i18n.tsx'

export interface RecordGroup {
  key: string
  /** 「全局」或项目名。 */
  label: string
  /** 项目的绝对路径；全局组没有。 */
  path: string | undefined
  records: RecordView[]
}

/** 全局组固定在前，项目组按记录到达顺序（服务端已按相关度/时间排过）。 */
export function groupRecords(records: RecordView[], t: Translate): RecordGroup[] {
  const groups = new Map<string, RecordGroup>()
  for (const record of records) {
    const key = record.scope === 'global' ? 'global' : `workspace:${record.workspacePath ?? ''}`
    const group = groups.get(key)
    if (group !== undefined) {
      group.records.push(record)
      continue
    }
    groups.set(key, record.scope === 'global'
      ? { key, label: t('scope.global'), path: undefined, records: [record] }
      : { key, label: baseName(record.workspacePath ?? ''), path: record.workspacePath, records: [record] })
  }
  return [...groups.values()]
}
