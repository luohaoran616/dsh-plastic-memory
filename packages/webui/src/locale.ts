/**
 * 独立页面的语言：缺省中文，用户选过的记在 localStorage 里（下次打开还是那个语言）。
 * 词典用原版记忆页那份（根包 client/locales.ts），另加一条本页面自己的文案（语言切换按钮）。
 */
import { useCallback, useMemo, useState } from 'react'
import { createTranslator } from 'dsh-plastic-memory/client/i18n.tsx'
import { en, zh, type LocaleKey } from 'dsh-plastic-memory/client/locales.ts'

/** 页面支持的语言。 */
export type StandaloneLocale = 'zh' | 'en'

/** 语言选择的存放处（localStorage 的键）。 */
export const LOCALE_KEY = 'plastic-memory.webui.locale'

/** 本页面自己的文案键（上游词典里没有的）。 */
export type StandaloneKey = 'webui.lang.switch'

/** 翻译函数：上游的键，加上本页面自己的键。 */
export type Translate = (key: LocaleKey | StandaloneKey, params?: Record<string, string | number>) => string

/** 两份词典：上游那份加上本页面自己的一条。切换按钮写的是要切过去的那个语言。 */
const DICTIONARIES: Record<StandaloneLocale, Record<LocaleKey, string> & Record<StandaloneKey, string>> = {
  zh: { ...zh, 'webui.lang.switch': 'English' },
  en: { ...en, 'webui.lang.switch': '中文' },
}

/** 读出上次选的语言；没有或认不出就是中文。存储不可用时也是中文。 */
function readStoredLocale(): StandaloneLocale {
  try {
    return localStorage.getItem(LOCALE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/** 独立页面的语言：缺省中文，选择记在 localStorage 的 plastic-memory.webui.locale。 */
export function useStandaloneTranslate(): { t: Translate; locale: StandaloneLocale; setLocale(locale: StandaloneLocale): void } {
  const [locale, setLocaleState] = useState<StandaloneLocale>(readStoredLocale)
  const setLocale = useCallback((next: StandaloneLocale): void => {
    setLocaleState(next)
    try {
      localStorage.setItem(LOCALE_KEY, next)
    } catch {
      /* 存储不可用：只在这次打开里生效 */
    }
  }, [])
  const t = useMemo<Translate>(() => {
    const dict = DICTIONARIES[locale]
    const base = createTranslator(dict)
    return (key, params) => (key === 'webui.lang.switch' ? dict[key] : base(key, params))
  }, [locale])
  return { t, locale, setLocale }
}
