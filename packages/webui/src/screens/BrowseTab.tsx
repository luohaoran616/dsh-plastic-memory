/**
 * 浏览：范围 + 关键词 → 分页列表（按全局/项目分组）。每行可以溯源、行内编辑、软删。
 * 数据全走 REST：列表是分页信封，编辑用打开时读到的 `updatedAt` 做并发标记（过期由 gateway 说成冲突）。
 */
import { useState, type ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { MemoryCard } from '../components/MemoryCard.tsx'
import { useGateway } from '../gateway.tsx'
import { useT } from '../i18n.tsx'
import { toCard, typeLabel } from '../records.ts'
import { groupRecords } from './groups.ts'
import { actionFailure, LoadError, Notice, Pager, RecordDetail, RecordEditor, ScopePicker, SearchBar, scopeParam, type NoticeTone, type ScopeSelection } from './shared.tsx'
import { useRecords } from './useRecords.ts'

const PAGE_LIMIT = 20

export function BrowseTab() {
  const gateway = useGateway()
  const t = useT()
  const [scope, setScope] = useState<ScopeSelection>({ kind: 'visible' })
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [detailOf, setDetailOf] = useState<string>()
  const [editingOf, setEditingOf] = useState<string>()
  const [confirmingOf, setConfirmingOf] = useState<string>()
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string }>()
  const list = useRecords({ scope: scopeParam(scope), q, limit: PAGE_LIMIT, offset })

  const changeScope = (next: ScopeSelection) => { setScope(next); setOffset(0) }
  const search = (next: string) => { setQ(next); setOffset(0) }

  const remove = async (id: string) => {
    setConfirmingOf(undefined)
    const result = await gateway.deleteRecord(id)
    if (!result.ok) {
      setNotice({ tone: 'error', text: actionFailure(result.error, t) })
      return
    }
    list.drop(id)
    setNotice({ tone: 'success', text: t('row.deleted', { id }) })
  }

  const bodies: ReactNode[] = []
  if (list.error !== undefined) bodies.push(<LoadError key="error" error={list.error} />)
  if (list.status === 'loading' && list.records.length === 0) bodies.push(<p key="loading" className="pm-panel-sub">{t('app.loading')}</p>)
  if (list.status !== 'loading' && list.error === undefined) {
    if (list.records.length === 0) {
      bodies.push(<EmptyState key="empty" variant={q === '' ? 'first' : 'daily'} title={q === '' ? t('list.empty') : t('list.emptySearch')} />)
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
                  <Button variant="ghost" size="sm" aria-expanded={detailOf === record.id} onClick={() => { setDetailOf(detailOf === record.id ? undefined : record.id) }}>
                    {t('row.provenance')}
                  </Button>
                  <Button variant="ghost" size="sm" aria-expanded={editingOf === record.id} onClick={() => { setEditingOf(editingOf === record.id ? undefined : record.id) }}>
                    {editingOf === record.id ? t('row.editCollapse') : t('row.edit')}
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => { setConfirmingOf(record.id) }}>{t('row.delete')}</Button>
                </div>
                {detailOf === record.id ? <RecordDetail record={record} onClose={() => { setDetailOf(undefined) }} /> : null}
                {editingOf === record.id
                  ? (
                    <RecordEditor
                      record={record}
                      onSaved={saved => {
                        list.patch(saved)
                        setEditingOf(undefined)
                        setNotice({ tone: 'success', text: t('edit.saved') })
                      }}
                      onClose={() => { setEditingOf(undefined) }}
                    />
                  )
                  : null}
                {confirmingOf === record.id
                  ? (
                    <Notice
                      tone="warn"
                      action={(
                        <>
                          <Button variant="danger" size="sm" onClick={() => { void remove(record.id) }}>{t('delete.do')}</Button>
                          <Button variant="ghost" size="sm" onClick={() => { setConfirmingOf(undefined) }}>{t('delete.cancel')}</Button>
                        </>
                      )}
                    >
                      {t('delete.confirm')}{t('delete.hint')}
                    </Notice>
                  )
                  : null}
              </article>
            ))}
          </section>,
        )
      }
    }
  }

  return (
    <section className="pm-section" aria-label={t('tab.browse')}>
      <div className="pm-toolbar">
        <ScopePicker value={scope} onChange={changeScope} />
        <SearchBar committed={q} onSearch={search} />
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
