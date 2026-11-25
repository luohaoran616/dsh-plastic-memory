/**
 * 提升审核：`GET /api/promotions` 里带 `needs-promote-review` 的记录（D3：agent 认为该进全局但无权直写）。
 * 两个动作逐条处理：approve 提升为全局、dismiss 留在本项目——两者都只清标记或搬作用域，不删记录。
 *
 * approve 撞上全局已有同 id 的副本时服务端回 `changed=false, taken=true`：那是「没处理成」而不是失败，
 * 记录原样留在项目内，界面按提示条说清楚，不套用错误样式。
 */
import { useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { MemoryCard } from '../components/MemoryCard.tsx'
import { useGateway } from '../gateway.tsx'
import { useT } from '../i18n.tsx'
import type { GatewayError, PromotionAction, RecordView } from '../gateway.impl.ts'
import { toCard, typeLabel } from '../records.ts'
import { actionFailure, LoadError, Notice, type NoticeTone } from './shared.tsx'

export function PromotionsTab() {
  const gateway = useGateway()
  const t = useT()
  const [records, setRecords] = useState<RecordView[]>()
  const [error, setError] = useState<GatewayError>()
  const [nonce, setNonce] = useState(0)
  const [acting, setActing] = useState<string>()
  const [notice, setNotice] = useState<{ tone: NoticeTone; text: string }>()

  useEffect(() => {
    let cancelled = false
    setError(undefined)
    void (async () => {
      const result = await gateway.listPromotions()
      if (cancelled) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      setRecords(result.value)
    })()
    return () => { cancelled = true }
  }, [gateway, nonce])

  const act = async (id: string, action: PromotionAction) => {
    setActing(id)
    const result = await gateway.actOnPromotion(id, action)
    setActing(undefined)
    if (!result.ok) {
      setNotice({ tone: 'error', text: actionFailure(result.error, t) })
      return
    }
    const value = result.value
    if (value.taken === true) {
      // 没处理成，但记录还在队列里：原样留着，用户可以先处理全局那条同 id 的记忆
      setNotice({ tone: 'warn', text: t('promote.taken', { reason: value.reason ?? '' }) })
      return
    }
    if (!value.changed) {
      setNotice({ tone: 'info', text: t('promote.noop', { reason: value.reason ?? '' }) })
    } else {
      setNotice({ tone: 'success', text: action === 'approve' ? t('promote.approved') : t('promote.dismissed') })
    }
    setRecords(list => list?.filter(record => record.id !== id))
  }

  return (
    <section className="pm-section" aria-label={t('tab.promotions')}>
      <p className="pm-panel-sub">{t('promote.hint')}</p>
      <div className="pm-toolbar">
        <h2 className="pm-panel-title">{t('promote.title')}</h2>
        <span className="pm-notice-spacer" />
        <Button variant="ghost" size="sm" onClick={() => { setNonce(value => value + 1) }}>{t('app.reload')}</Button>
      </div>
      {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      {error === undefined ? null : <LoadError error={error} />}
      {records === undefined
        ? (error === undefined ? <p className="pm-panel-sub">{t('app.loading')}</p> : null)
        : records.length === 0
          ? <EmptyState variant="daily" title={t('promote.empty')} />
          : records.map(record => (
            <article key={record.id} className="pm-row">
              <div className="pm-row-head">
                <div className="pm-row-body">
                  <MemoryCard
                    memory={toCard(record)}
                    now={Date.now()}
                    typeLabel={typeLabel(record.type, t)}
                    projectName={record.workspacePath}
                    collapsible
                  />
                </div>
              </div>
              <div className="pm-row-actions">
                <Button
                  variant="primary"
                  size="sm"
                  unavailable={acting === record.id ? t('promote.acting') : undefined}
                  onClick={() => { void act(record.id, 'approve') }}
                >
                  {t('promote.approve')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  unavailable={acting === record.id ? t('promote.acting') : undefined}
                  onClick={() => { void act(record.id, 'dismiss') }}
                >
                  {t('promote.dismiss')}
                </Button>
              </div>
            </article>
          ))}
    </section>
  )
}
