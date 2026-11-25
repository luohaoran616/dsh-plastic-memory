/**
 * 体检：`GET /api/health` 的只读简版（score / issueCount / topIssues）。
 * 逐条 accept/dismiss 需要 DSH 插件的 `/memory` 命令通道（裁决要写快照与账本），Task 5 的 REST 面没有这个端点，
 * 所以这里只显示分数与待办清单，页面里也把这一点写明。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../components/Button.tsx'
import { HealthBanner } from '../components/HealthBanner.tsx'
import { useGateway } from '../gateway.tsx'
import { useT } from '../i18n.tsx'
import type { GatewayError, HealthSummary } from '../gateway.impl.ts'
import { LoadError, Notice } from './shared.tsx'

/**
 * 分数分档只决定标记颜色；分数本身由服务端的扣分表算，这里不重算。
 * 档位与插件侧的产品口径一致（`src/governance/scoring.ts`：`>= 80` green、`>= 50` amber、其余 red），别单独调阈值。
 */
export function markerOf(score: number): 'ok' | 'pending' | 'error' {
  if (score >= 80) return 'ok'
  if (score >= 50) return 'pending'
  return 'error'
}

export function HealthTab() {
  const gateway = useGateway()
  const t = useT()
  const [health, setHealth] = useState<HealthSummary>()
  const [error, setError] = useState<GatewayError>()
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => { setNonce(value => value + 1) }, [])

  useEffect(() => {
    let cancelled = false
    setError(undefined)
    void (async () => {
      const result = await gateway.health()
      if (cancelled) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      setHealth(result.value)
    })()
    return () => { cancelled = true }
  }, [gateway, nonce])

  return (
    <section className="pm-section" aria-label={t('tab.health')}>
      <div className="pm-toolbar">
        <h2 className="pm-panel-title">{t('health.title')}</h2>
        <span className="pm-notice-spacer" />
        <Button variant="ghost" size="sm" onClick={reload}>{t('app.reload')}</Button>
      </div>
      {error === undefined ? null : <LoadError error={error} />}
      {health === undefined
        ? (error === undefined ? <p className="pm-panel-sub">{t('app.loading')}</p> : null)
        : (
          <>
            <HealthBanner
              marker={markerOf(health.score)}
              conclusion={`${t('health.score', { score: health.score })} · ${t('health.issueCount', { n: health.issueCount })}`}
              detail={t('health.readonly')}
            />
            {health.topIssues.length === 0
              ? <Notice tone="success">{t('health.clean')}</Notice>
              : (
                <section className="pm-panel">
                  <h3 className="pm-panel-title">{t('health.topIssues')}</h3>
                  <dl className="pm-grid">
                    {health.topIssues.map((issue, index) => (
                      <div key={index} style={{ display: 'contents' }}>
                        <dt className="pm-grid-term">{index + 1}</dt>
                        <dd className="pm-grid-desc">{issue}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
          </>
        )}
    </section>
  )
}
