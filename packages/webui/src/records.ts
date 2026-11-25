/**
 * REST 视图（`RecordView`：title/text + 完整 frontmatter）→ 记忆卡数据（`MemoryCard`）。
 * 卡片组件是 `client/ui/MemoryCard.tsx` 的副本，认的是上游 `memoryCardSchema` 的字段名，映射只在这里做一次。
 */
import type { MemoryCard } from '@plastic/core/gui/contract.ts'
import type { RecordView } from './gateway.impl.ts'
import type { Translate } from './i18n.tsx'
import type { LocaleKey } from './locales.ts'

export function toCard(record: RecordView): MemoryCard {
  return {
    id: record.id,
    name: record.title,
    type: record.type,
    scope: record.scope,
    ...(record.workspacePath === undefined ? {} : { workspacePath: record.workspacePath }),
    summary: record.summary,
    content: record.text,
    tags: record.tags,
    ...(record.source === undefined ? {} : { sourceMode: record.source.sourceMode, sourceSessionId: record.source.sessionId }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastConfirmedAt: record.lastConfirmedAt,
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
    ...(record.delegation === undefined
      ? {}
      : { delegation: { depth: record.delegation.depth, ...(record.delegation.reviewed === undefined ? {} : { reviewed: record.delegation.reviewed.by }) } }),
    filePath: record.path,
  }
}

/** 内置类型有译名；自定义类型（schema 允许任意字符串）原样显示 id。 */
const KNOWN_TYPES = new Set<string>(['profile', 'preference', 'knowledge', 'project', 'reference', 'procedure', 'decision', 'commitment', 'person'])

export function typeLabel(type: string, t: Translate): string {
  return KNOWN_TYPES.has(type) ? t(`type.${type}` as LocaleKey) : type
}
