/**
 * 归档：`.archive/` 里的软删记录（`status=deleted`），逐条恢复。
 * 恢复走 `POST /api/records/:id/restore`：文件回到原作用域目录，id 与正文不变（服务端保证，这里只显示结果）。
 */
import { useState } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { useGateway } from '../gateway.tsx'
import { useT } from '../i18n.tsx'
import { actionFailure, Notice, Pager, RecordListBody, ScopePicker, SearchBar, scopeParam, type NoticeTone, type ScopeSelection } from './shared.tsx'
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

  return (
    <section className="pm-section" aria-label={t('tab.archive')}>
      <p className="pm-panel-sub">{t('archive.hint')}</p>
      <div className="pm-toolbar">
        <ScopePicker value={scope} onChange={next => { setScope(next); setOffset(0) }} />
        <SearchBar committed={q} onSearch={next => { setQ(next); setOffset(0) }} />
        <Button variant="ghost" size="sm" onClick={list.reload}>{t('list.refresh')}</Button>
      </div>
      {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      <RecordListBody
        state={list}
        empty={<EmptyState variant="daily" title={q === '' ? t('list.empty') : t('list.emptySearch')} />}
        renderActions={record => (
          <Button variant="secondary" size="sm" onClick={() => { void restore(record.id) }}>{t('row.restore')}</Button>
        )}
      />
      {list.page === undefined ? null : (
        <Pager offset={list.page.offset} count={list.records.length} limit={list.page.limit} hasMore={list.page.hasMore} onOffset={setOffset} />
      )}
    </section>
  )
}
