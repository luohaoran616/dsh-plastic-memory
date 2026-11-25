/**
 * 独立页面：原版记忆页（根包 client/MemoryPage.tsx）挂在页面壳里。
 * 壳给三样东西：网关（缺省 HTTP 网关，用例注入假网关）、词典（可切中英文）、导航 store（页内切视图与范围）。
 */
import { useMemo } from 'react'
import type { MemoryGateway } from 'dsh-plastic-memory/client/gateway.ts'
import { MemoryPage } from 'dsh-plastic-memory/client/MemoryPage.tsx'
import { createNavStore } from 'dsh-plastic-memory/client/nav.ts'
import { slotCss } from 'dsh-plastic-memory/client/styles.ts'
import { PanelShell } from 'dsh-plastic-memory/client/ui/PanelShell.tsx'
import { createHttpGateway } from './gateway.http.ts'
import { useStandaloneTranslate } from './locale.ts'

/** 独立页面根组件；gateway 缺省用 createHttpGateway()，用例注入假网关。 */
export function App({ gateway }: { gateway?: MemoryGateway }): JSX.Element {
  const { t, locale, setLocale } = useStandaloneTranslate()
  const resolved = useMemo(() => gateway ?? createHttpGateway(), [gateway])
  const nav = useMemo(() => createNavStore(), [])
  return (
    <PanelShell gateway={resolved} t={t} className="pm-root--page webui-root" extraCss={slotCss('page')}>
      <header className="webui-head">
        <h1 className="webui-title">{t('nav.label')}</h1>
        <button type="button" className="webui-lang" onClick={() => { setLocale(locale === 'zh' ? 'en' : 'zh') }}>
          {t('webui.lang.switch')}
        </button>
      </header>
      <div className="webui-body">
        <MemoryPage nav={nav} />
      </div>
    </PanelShell>
  )
}
