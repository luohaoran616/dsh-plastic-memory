/**
 * 独立页面：记忆页与设置页两个视图，hash 路由（`#/settings`）。
 * 壳给四样东西：网关（缺省 HTTP 网关，用例注入假网关）、设置表单（缺省 HTTP 的，用例注入假的——与网关共用同一份时从外面一起给）、
 * 词典（可切中英文）、导航 store（记忆页的「设置」入口写 hash）。
 * 设置视图里原版设置页一行不改地挂着；「怎么管」两项按独立端的消费情况置灰并写明原因（inert）。
 */
import { useEffect, useMemo, useState } from 'react'
import './shell.css'
import type { ConfigForm } from 'dsh-plastic-memory/client/host.ts'
import type { MemoryGateway } from 'dsh-plastic-memory/client/gateway.ts'
import { MemoryPage } from 'dsh-plastic-memory/client/MemoryPage.tsx'
import { createNavStore, type NavTarget } from 'dsh-plastic-memory/client/nav.ts'
import { slotCss } from 'dsh-plastic-memory/client/styles.ts'
import { SettingsPage } from 'dsh-plastic-memory/client/settings/SettingsPage.tsx'
import { PanelShell } from 'dsh-plastic-memory/client/ui/PanelShell.tsx'
import { createHttpConfigForm } from './config-form.http.ts'
import { createHttpGateway } from './gateway.http.ts'
import { useStandaloneTranslate } from './locale.ts'

/** 设置视图的 hash。 */
const SETTINGS_HASH = '#/settings'

/** 独立页面根组件；gateway、form 缺省各用 HTTP 的那份，用例注入假的。 */
export function App({ gateway, form }: { gateway?: MemoryGateway; form?: ConfigForm }): JSX.Element {
  const { t, locale, setLocale } = useStandaloneTranslate()
  const [view, setView] = useState<'memory' | 'settings'>(window.location.hash === SETTINGS_HASH ? 'settings' : 'memory')
  // hash 被别处改了（前进后退、手改地址）也跟着切视图；openSettings/back 自己 setView，不依赖 hashchange 事件时机
  useEffect(() => {
    const onHash = (): void => { setView(window.location.hash === SETTINGS_HASH ? 'settings' : 'memory') }
    window.addEventListener('hashchange', onHash)
    return () => { window.removeEventListener('hashchange', onHash) }
  }, [])
  const configForm = useMemo(() => form ?? createHttpConfigForm(), [form])
  const resolved = useMemo(() => gateway ?? createHttpGateway({ form: configForm }), [gateway, configForm])
  const nav = useMemo(() => createNavStore(undefined, {
    // 记忆页的「设置」入口：写 hash（hashchange 兜底），同时直接切视图
    openSettings: () => { setView('settings'); window.location.hash = SETTINGS_HASH },
  }), [])
  /** 设置页里的记忆页入口（状态卡、最近删除）：切回记忆视图并落到目标。 */
  const openMemory = (target: NavTarget): void => {
    nav.enter(target)
    setView('memory')
    window.location.hash = '#/'
  }

  const langButton = (
    <button type="button" className="webui-lang" onClick={() => { setLocale(locale === 'zh' ? 'en' : 'zh') }}>
      {t('webui.lang.switch')}
    </button>
  )

  if (view === 'settings') {
    return (
      <PanelShell gateway={resolved} t={t} className="webui-root pm-root--settings" extraCss={slotCss('settings')}>
        <header className="webui-head">
          <button type="button" className="webui-back" onClick={() => { setView('memory'); window.location.hash = '#/' }}>
            {t('webui.back.memory')}
          </button>
          {langButton}
        </header>
        <div className="webui-body">
          <SettingsPage form={configForm} onOpenMemoryPage={openMemory} inert={t('webui.inert.manage')} />
        </div>
      </PanelShell>
    )
  }

  return (
    <PanelShell gateway={resolved} t={t} className="pm-root--page webui-root" extraCss={slotCss('page')}>
      <header className="webui-head">
        {langButton}
      </header>
      <div className="webui-body">
        <MemoryPage nav={nav} />
      </div>
    </PanelShell>
  )
}
