/**
 * SPA 外壳：一个 REST gateway、一份文案、一份样式表，四个视图（浏览 / 归档 / 体检 / 提升审核）按 tab 切换。
 * 与 DSH 插件 GUI 的分工（D5）：这里只做治理（浏览、搜索、溯源、编辑、软删恢复、体检分、提升审核），
 * 会话内注入面板与对话卡片留在插件里，不在这里重做。
 */
import { useMemo, useState } from 'react'
import { APP_CSS } from './styles.ts'
import { createRestGateway } from './gateway.impl.ts'
import { GatewayProvider } from './gateway.tsx'
import { createTranslator, TranslateProvider, useT } from './i18n.tsx'
import { zh } from './locales.ts'
import { ArchiveTab } from './screens/ArchiveTab.tsx'
import { BrowseTab } from './screens/BrowseTab.tsx'
import { HealthTab } from './screens/HealthTab.tsx'
import { PromotionsTab } from './screens/PromotionsTab.tsx'

const TABS = ['browse', 'archive', 'health', 'promotions'] as const
type Tab = (typeof TABS)[number]

const translator = createTranslator(zh)

function Tabs({ active, onChange }: { active: Tab; onChange: (next: Tab) => void }) {
  const t = useT()
  return (
    <nav className="pm-tabs" aria-label={t('tab.label')}>
      {TABS.map(tab => (
        <button
          key={tab}
          type="button"
          aria-current={active === tab ? 'page' : undefined}
          className={active === tab ? 'pm-tab pm-tab--on' : 'pm-tab'}
          onClick={() => { onChange(tab) }}
        >
          {t(`tab.${tab}`)}
        </button>
      ))}
    </nav>
  )
}

function AppBody() {
  const t = useT()
  const [tab, setTab] = useState<Tab>('browse')
  return (
    <div className="pm-root pm-app">
      <style data-plastic-memory="">{APP_CSS}</style>
      <header className="pm-app-head">
        <h1 className="pm-app-title">{t('app.title')}</h1>
        <p className="pm-app-sub">{t('app.subtitle')}</p>
      </header>
      <Tabs active={tab} onChange={setTab} />
      {tab === 'browse' ? <BrowseTab /> : null}
      {tab === 'archive' ? <ArchiveTab /> : null}
      {tab === 'health' ? <HealthTab /> : null}
      {tab === 'promotions' ? <PromotionsTab /> : null}
    </div>
  )
}

export function App() {
  const gateway = useMemo(() => createRestGateway(), [])
  return (
    <GatewayProvider value={gateway}>
      <TranslateProvider value={translator}>
        <AppBody />
      </TranslateProvider>
    </GatewayProvider>
  )
}
