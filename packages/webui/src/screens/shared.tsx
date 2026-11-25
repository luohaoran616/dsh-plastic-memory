/** 各个记忆视图共用的界面件：范围选择、搜索框、提示条、翻页、分组列表体、溯源面板、行内编辑器。 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Button } from '../components/Button.tsx'
import { MemoryCard } from '../components/MemoryCard.tsx'
import { formatDayTime, useT, type Translate } from '../i18n.tsx'
import { useGateway } from '../gateway.tsx'
import type { GatewayError, RecordView } from '../gateway.impl.ts'
import type { LocaleKey } from '../locales.ts'
import { toCard, typeLabel } from '../records.ts'
import { groupRecords } from './groups.ts'
import type { RecordsState } from './useRecords.ts'

/** 范围选择：可见集合（全局 + 当前项目）、只看全局、指定项目目录——与 REST 的 `scope` 参数同一套语义。 */
export type ScopeSelection = { kind: 'visible' } | { kind: 'global' } | { kind: 'project'; path: string }

/** 界面上的范围 → 请求参数：可见集合与空路径都不传，交给服务端的缺省口径。 */
export function scopeParam(scope: ScopeSelection): string | undefined {
  if (scope.kind === 'global') return 'global'
  if (scope.kind === 'project') return scope.path.trim() === '' ? undefined : scope.path.trim()
  return undefined
}

export function ScopePicker({ value, onChange }: { value: ScopeSelection; onChange: (next: ScopeSelection) => void }) {
  const t = useT()
  const [draftPath, setDraftPath] = useState(value.kind === 'project' ? value.path : '')
  const commit = (next: ScopeSelection) => {
    if (next.kind === 'project') setDraftPath(next.path)
    onChange(next)
  }
  const commitPath = () => {
    const path = draftPath.trim()
    if (path === '') return
    commit({ kind: 'project', path })
  }
  return (
    <>
      <label className="pm-field">
        <span className="pm-field-label">{t('scope.label')}</span>
        <select
          className="pm-select"
          value={value.kind}
          onChange={event => {
            const kind = event.target.value as ScopeSelection['kind']
            if (kind === 'project') commit({ kind: 'project', path: draftPath.trim() })
            else commit(kind === 'global' ? { kind: 'global' } : { kind: 'visible' })
          }}
        >
          <option value="visible">{t('scope.visible')}</option>
          <option value="global">{t('scope.globalOnly')}</option>
          <option value="project">{t('scope.project')}</option>
        </select>
      </label>
      {value.kind === 'project'
        ? (
          <label className="pm-field">
            <span className="pm-field-label">{t('scope.project')}</span>
            <span className="pm-editor-actions">
              <input
                className="pm-input"
                value={draftPath}
                placeholder={t('scope.projectPlaceholder')}
                onChange={event => { setDraftPath(event.target.value) }}
                onKeyDown={event => { if (event.key === 'Enter') commitPath() }}
              />
              <Button variant="secondary" size="sm" onClick={commitPath}>{t('scope.apply')}</Button>
            </span>
          </label>
        )
        : null}
    </>
  )
}

export function SearchBar({ committed, onSearch }: { committed: string; onSearch: (q: string) => void }) {
  const t = useT()
  const [draft, setDraft] = useState(committed)
  useEffect(() => { setDraft(committed) }, [committed])
  return (
    <form
      className="pm-toolbar-search"
      onSubmit={event => { event.preventDefault(); onSearch(draft.trim()) }}
    >
      <label className="pm-field" style={{ flex: 1 }}>
        <span className="pm-field-label">{t('search.label')}</span>
        <input
          className="pm-input"
          value={draft}
          placeholder={t('search.placeholder')}
          onChange={event => { setDraft(event.target.value) }}
        />
      </label>
      <Button type="submit" variant="secondary">{t('search.submit')}</Button>
      {committed === '' ? null : <Button variant="ghost" size="sm" onClick={() => { setDraft(''); onSearch('') }}>{t('search.clear')}</Button>}
    </form>
  )
}

export type NoticeTone = 'info' | 'warn' | 'error' | 'success'

export function Notice({ tone = 'info', children, action }: { tone?: NoticeTone; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={tone === 'info' ? 'pm-notice' : `pm-notice pm-notice--${tone}`} role="status">
      <span>{children}</span>
      {action === undefined ? null : <><span className="pm-notice-spacer" />{action}</>}
    </div>
  )
}

/** 动作失败的提示：服务端给了原文就显示原文（「记录已删除，不能处理提升候选」比通用说法有用），否则用通用说法。 */
export function actionFailure(error: GatewayError, t: Translate): string {
  return t('error.action', { message: error.detail ?? error.message })
}

/** 读取失败的统一说法：冲突另有自己的提示（见编辑器），这里只兜其余错误。 */
export function LoadError({ error }: { error: GatewayError }) {
  const t = useT()
  return <Notice tone="error">{t('error.load', { message: error.message })}</Notice>
}

export function Pager({ offset, count, limit, hasMore, onOffset }: {
  offset: number
  count: number
  limit: number
  hasMore: boolean
  onOffset: (offset: number) => void
}) {
  const t = useT()
  if (count === 0) return null
  return (
    <div className="pm-footer">
      <span>{t('list.count', { from: offset + 1, to: offset + count })}</span>
      {hasMore ? <span>{t('list.more')}</span> : null}
      <span className="pm-footer-spacer" />
      <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => { onOffset(Math.max(0, offset - limit)) }}>
        {t('list.prev')}
      </Button>
      <Button variant="ghost" size="sm" disabled={!hasMore} onClick={() => { onOffset(offset + limit) }}>
        {t('list.next')}
      </Button>
    </div>
  )
}

/**
 * 分组列表的共用主体：错误/加载/空态判定与「分组标题 + 记忆卡行」只在这里维护，
 * 各屏只给空态变体、行动作与（浏览页才有的）行尾展开块——免得一屏改了加载口径，另一屏静默漂移。
 */
export function RecordListBody({ state, empty, renderActions, renderExtra }: {
  state: Pick<RecordsState, 'status' | 'records' | 'error'>
  /** 空列表时显示什么（浏览页按是否在搜索换插图，归档页固定一种）。 */
  empty: ReactNode
  /** 行右侧的动作按钮。 */
  renderActions: (record: RecordView) => ReactNode
  /** 行尾的展开块（浏览页的溯源面板、编辑器、删除确认）。 */
  renderExtra?: (record: RecordView) => ReactNode
}) {
  const t = useT()
  const bodies: ReactNode[] = []
  if (state.error !== undefined) bodies.push(<LoadError key="error" error={state.error} />)
  if (state.status === 'loading' && state.records.length === 0) bodies.push(<p key="loading" className="pm-panel-sub">{t('app.loading')}</p>)
  if (state.status !== 'loading' && state.error === undefined) {
    if (state.records.length === 0) {
      bodies.push(<Fragment key="empty">{empty}</Fragment>)
    } else {
      for (const group of groupRecords(state.records, t)) {
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
                <div className="pm-row-actions">{renderActions(record)}</div>
                {renderExtra === undefined ? null : renderExtra(record)}
              </article>
            ))}
          </section>,
        )
      }
    }
  }
  return <>{bodies}</>
}

/** 溯源：REST 单条视图里的完整 frontmatter 与文件路径，编辑前核对版本也看它。 */
export function RecordDetail({ record, onClose }: { record: RecordView; onClose: () => void }) {
  const t = useT()
  const now = Date.now()
  const rows: Array<[string, ReactNode]> = [
    [t('detail.id'), <span className="pm-kbd">{record.id}</span>],
    [t('detail.type'), `${typeLabel(record.type, t)}（${record.type}）`],
    [t('detail.scope'), record.scope === 'global' ? t('scope.global') : t('scope.workspace')],
    [t('detail.workspace'), record.workspacePath ?? t('detail.none')],
    [t('detail.path'), <span className="pm-kbd">{record.path}</span>],
    [t('detail.tags'), record.tags.length === 0 ? t('detail.none') : record.tags.join('、')],
    [t('detail.summary'), record.summary],
    [t('detail.source'), record.source?.sessionId ?? t('detail.none')],
    [t('detail.sourceMode'), record.source === undefined ? t('detail.none') : t(`source.${record.source.sourceMode}`)],
    [t('detail.confidence'), String(record.confidence)],
    [t('detail.created'), formatDayTime(record.createdAt, now, t)],
    [t('detail.updated'), formatDayTime(record.updatedAt, now, t)],
    [t('detail.confirmed'), formatDayTime(record.lastConfirmedAt, now, t)],
    [t('detail.status'), t(`status.${record.status}` as LocaleKey)],
    [t('detail.validTo'), record.validTo === undefined ? t('detail.none') : formatDayTime(record.validTo, now, t)],
    [t('detail.importedFrom'), record['imported-from'] ?? t('detail.none')],
    [t('detail.promoteReview'), record['needs-promote-review'] === true ? t('detail.yes') : t('detail.none')],
    ...(record.deletedAt === undefined ? [] : [[t('detail.deletedAt'), formatDayTime(record.deletedAt, now, t)]] as Array<[string, ReactNode]>),
  ]
  return (
    <section className="pm-panel">
      <header className="pm-editor-actions">
        <h3 className="pm-panel-title">{t('detail.title')}</h3>
        <span className="pm-notice-spacer" />
        <Button variant="ghost" size="sm" onClick={onClose}>{t('detail.close')}</Button>
      </header>
      <dl className="pm-grid">
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt className="pm-grid-term">{label}</dt>
            <dd className="pm-grid-desc">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function splitTags(raw: string): string[] {
  return raw.split(/[,，]/).map(tag => tag.trim()).filter(tag => tag !== '')
}

/**
 * 行内编辑：整条替换（标题、类型、标签、正文），并发标记取打开时读到的那一份 `updatedAt`。
 * 服务端在锁内按它判过期，过期回 409——这里把 409 说成「没保存、别人先改过」，并把最新内容（标题、标签、正文）摊开给用户看，
 * 不静默失败、也不覆盖。用户可以选择用最新内容重开，或带着自己的改动按最新版本再提交一次。
 */
export function RecordEditor({ record, onSaved, onClose }: {
  record: RecordView
  onSaved: (record: RecordView) => void
  onClose: () => void
}) {
  const gateway = useGateway()
  const t = useT()
  const [baseline, setBaseline] = useState(record)
  const [title, setTitle] = useState(record.title)
  const [type, setType] = useState(record.type)
  const [tags, setTags] = useState(record.tags.join(', '))
  const [text, setText] = useState(record.text)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [conflict, setConflict] = useState<RecordView | undefined>()
  const [conflictMissing, setConflictMissing] = useState(false)

  const submit = async () => {
    if (title.trim() === '' || text.trim() === '') {
      setFailure(t('edit.required'))
      return
    }
    setFailure(undefined)
    setSaving(true)
    const result = await gateway.updateRecord(record.id, {
      updatedAt: baseline.updatedAt, title: title.trim(), text, type: type.trim(), tags: splitTags(tags),
    })
    setSaving(false)
    if (result.ok) {
      setConflict(undefined)
      onSaved(result.value)
      return
    }
    if (result.error.kind !== 'conflict') {
      setFailure(result.error.message)
      return
    }
    // 409：把服务端此刻的版本读回来摊给用户看；读不到（已被删）就只说冲突
    const latest = await gateway.getRecord(record.id)
    setConflict(latest.ok ? latest.value : undefined)
    setConflictMissing(!latest.ok)
  }

  /** 用服务端最新版本重开编辑（丢草稿）。 */
  const reloadLatest = () => {
    if (conflict === undefined) return
    setBaseline(conflict)
    setTitle(conflict.title)
    setType(conflict.type)
    setTags(conflict.tags.join(', '))
    setText(conflict.text)
    setConflict(undefined)
    setConflictMissing(false)
  }

  /** 保留草稿，只把并发标记换成最新版本——相当于「重新读取后再提交」。保存时标题、标签、正文都按草稿提交，所以最新版本面板要先把这些字段摊开。 */
  const rebase = () => {
    if (conflict === undefined) return
    setBaseline(conflict)
    setConflict(undefined)
    setConflictMissing(false)
  }

  return (
    <section className="pm-panel">
      <h3 className="pm-panel-title">{record.title}</h3>
      <div className="pm-editor">
        {failure === undefined ? null : <Notice tone="error">{failure}</Notice>}
        {conflict === undefined && !conflictMissing ? null : (
          <Notice
            tone="warn"
            action={conflict === undefined
              ? undefined
              : (
                <>
                  <Button variant="secondary" size="sm" onClick={reloadLatest}>{t('edit.reload')}</Button>
                  <Button variant="ghost" size="sm" onClick={rebase}>{t('edit.rebase')}</Button>
                </>
              )}
          >
            {t('edit.conflict')}
          </Notice>
        )}
        {conflict === undefined ? null : (
          <>
            <p className="pm-panel-sub">{t('edit.latest')}：{formatDayTime(conflict.updatedAt, Date.now(), t)}</p>
            {/* 正文之外也摊开标题与标签：点「保留我的修改」保存时，这两项会覆盖掉对方改的内容，用户得先看见。 */}
            <dl className="pm-grid">
              <div style={{ display: 'contents' }}>
                <dt className="pm-grid-term">{t('edit.latestTitle')}</dt>
                <dd className="pm-grid-desc">{conflict.title}</dd>
              </div>
              <div style={{ display: 'contents' }}>
                <dt className="pm-grid-term">{t('edit.latestTags')}</dt>
                <dd className="pm-grid-desc">{conflict.tags.length === 0 ? t('detail.none') : conflict.tags.join('、')}</dd>
              </div>
            </dl>
            <pre className="pm-prose">{conflict.text}</pre>
          </>
        )}
        <div className="pm-editor-row">
          <label className="pm-field" style={{ flex: 2, minWidth: 240 }}>
            <span className="pm-field-label">{t('edit.title')}</span>
            <input className="pm-input" value={title} onChange={event => { setTitle(event.target.value) }} />
          </label>
          <label className="pm-field" style={{ flex: 1, minWidth: 140 }}>
            <span className="pm-field-label">{t('edit.type')}</span>
            <input className="pm-input" value={type} onChange={event => { setType(event.target.value) }} />
          </label>
          <label className="pm-field" style={{ flex: 1, minWidth: 180 }}>
            <span className="pm-field-label">{t('edit.tags')}</span>
            <input className="pm-input" value={tags} onChange={event => { setTags(event.target.value) }} />
          </label>
        </div>
        <label className="pm-field">
          <span className="pm-field-label">{t('edit.text')}</span>
          <textarea className="pm-textarea" value={text} onChange={event => { setText(event.target.value) }} />
        </label>
        <div className="pm-editor-actions">
          <Button variant="primary" unavailable={saving ? t('edit.saving') : undefined} onClick={() => { void submit() }}>
            {saving ? t('edit.saving') : t('edit.save')}
          </Button>
          <Button variant="ghost" onClick={onClose}>{t('edit.cancel')}</Button>
        </div>
      </div>
    </section>
  )
}
