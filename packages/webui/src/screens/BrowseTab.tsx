/**
 * 浏览：范围 + 关键词 → 分页列表（按全局/项目分组）。每行可以溯源、行内编辑、软删。
 * 数据全走 REST：列表是分页信封，编辑用打开时读到的 `updatedAt` 做并发标记（过期由 gateway 说成冲突）。
 */
import { useState } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { useGateway } from '../gateway.tsx'
import { useT } from '../i18n.tsx'
import { actionFailure, Notice, Pager, RecordDetail, RecordEditor, RecordListBody, ScopePicker, SearchBar, scopeParam, type NoticeTone, type ScopeSelection } from './shared.tsx'
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

  return (
    <section className="pm-section" aria-label={t('tab.browse')}>
      <div className="pm-toolbar">
        <ScopePicker value={scope} onChange={changeScope} />
        <SearchBar committed={q} onSearch={search} />
        <Button variant="ghost" size="sm" onClick={list.reload}>{t('list.refresh')}</Button>
      </div>
      {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      <RecordListBody
        state={list}
        empty={<EmptyState variant={q === '' ? 'first' : 'daily'} title={q === '' ? t('list.empty') : t('list.emptySearch')} />}
        renderActions={record => (
          <>
            <Button variant="ghost" size="sm" aria-expanded={detailOf === record.id} onClick={() => { setDetailOf(detailOf === record.id ? undefined : record.id) }}>
              {t('row.provenance')}
            </Button>
            <Button variant="ghost" size="sm" aria-expanded={editingOf === record.id} onClick={() => { setEditingOf(editingOf === record.id ? undefined : record.id) }}>
              {editingOf === record.id ? t('row.editCollapse') : t('row.edit')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => { setConfirmingOf(record.id) }}>{t('row.delete')}</Button>
          </>
        )}
        renderExtra={record => (
          <>
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
          </>
        )}
      />
      {list.page === undefined ? null : (
        <Pager offset={list.page.offset} count={list.records.length} limit={list.page.limit} hasMore={list.page.hasMore} onOffset={setOffset} />
      )}
    </section>
  )
}
