/**
 * 归档：`.archive/` 里的软删记录（`status=deleted`），逐条恢复。
 * 恢复走 `POST /api/records/:id/restore`：文件回到原作用域目录，id 与正文不变（服务端保证，这里只显示结果）。
 */
import { useState, type ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { MemoryCard } from '../components/MemoryCard.tsx'
import { useGateway } from '../gateway.tsx'
import { useT } from '../i18n.tsx'
import { toCard, typeLabel } from '../records.ts'
import { groupRecords } from './groups.ts'
import { actionFailure, LoadError, Notice, Pager, ScopePicker, SearchBar, scopeParam, type NoticeTone, type ScopeSelection } from './shared.tsx'
import { useRecords } from './useRecords.ts'

const PAGE_LIMIT = 20

export function ArchiveTab() {
  const gateway = useGateway()
  const t = useT()
  const [scope, setScope] = useState<ScopeSelection>({ kind: 'visible' })
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string }>()
  const list = useRecords({ scope: scopeParam(scope), q, status: 'deleted', limit: PAGE_LIMIT, offset })

  const restore = async (id: string) => {
    const result = await gateway.restoreRecord(id)
    if (!result.ok) {
      setNotice({ tone: 'error', text: actionFailure(result.error, t) })
      return
    }
    list.drop(id)
    setNotice({ tone: 'success', text: t('row.restored', { id }) })
  }

  const bodies: ReactNode[] = []
  if (list.error !== undefined) bodies.push(<LoadError key="error" error={list.error} />)
  if (list.status === 'loading' && list.records.length === 0) bodies.push(<p key="loading" className="pm-panel-sub">{t('app.loading')}</p>)
  if (list.status !== 'loading' && list.error === undefined) {
    if (list.records.length === 0) {
      bodies.push(<EmptyState key="empty" variant="daily" title={q === '' ? t('list.empty') : t('list.emptySearch')} />)
    } else {
      for (const group of groupRecords(list.records, t)) {
        bodies.push(
          <section key={group.key} className="pm-section">
            <p className="pm-panel-sub">{group.path === undefined ? group.label : `${group.label} · ${group.path}`}</p>
            {group.records.map(record => (
              <article key={record.id} className="pm-row">
                <div className="pm-row-head">
                  <div className="pm-row-body">
                    <MemoryCard memory={toCard(record)} now={Date.now()} typeLabel={typeLabel(record.type, t)} collapsible />
                  </div>
                </div>
                <div className="pm-row-actions">
                  <Button variant="secondary" size="sm" onClick={() => { void restore(record.id) }}>{t('row.restore')}</Button>
                </div>
              </article>
            ))}
          </section>,
        )
      }
    }
  }

  return (
    <section className="pm-section" aria-label={t('tab.archive')}>
      <p className="pm-panel-sub">{t('archive.hint')}</p>
      <div className="pm-toolbar">
        <ScopePicker value={scope} onChange={next => { setScope(next); setOffset(0) }} />
        <SearchBar committed={q} onSearch={next => { setQ(next); setOffset(0) }} />
        <Button variant="ghost" size="sm" onClick={list.reload}>{t('list.refresh')}</Button>
      </div>
      {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      {bodies}
      {list.page === undefined ? null : (
        <Pager offset={list.page.offset} count={list.records.length} limit={list.page.limit} hasMore={list.page.hasMore} onOffset={setOffset} />
      )}
    </section>
  )
}
