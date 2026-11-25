/**
 * 文案与格式化：派生自 `client/i18n.tsx`（仓库根下同一路径），2026-11-25。
 * 差异：去掉 `useHostTranslate`（它绑宿主 locale 服务，独立 WebUI 没有宿主）；翻译器、`{name}` 占位替换、
 * 日期格式与上游一致。字典见 `locales.ts`（上游字典的节选 + 本 SPA 自己的键）。
 */
import { createContext, useContext } from 'react'
import { zh, type LocaleKey } from './locales.ts'

export type Translate = (key: LocaleKey, params?: Record<string, string | number>) => string

/** 按一份字典翻译，`{name}` 占位替换。 */
export function createTranslator(dict: Record<LocaleKey, string>): Translate {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}

const TranslateContext = createContext<Translate>(createTranslator(zh))

export const TranslateProvider = TranslateContext.Provider

export function useT(): Translate {
  return useContext(TranslateContext)
}

const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'short' })

/** 「刚刚」「10 月 17 日」，跨年带年份。按本机时区。 */
export function formatDay(ms: number, now: number, t: Translate): string {
  if (Math.abs(now - ms) < 60_000) return t('time.justNow')
  const d = new Date(ms)
  const params = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), monthName: MONTH_NAME.format(d) }
  return d.getFullYear() === new Date(now).getFullYear() ? t('time.monthDay', params) : t('time.yearMonthDay', params)
}

/** 日期加 24 小时制的时刻：「10 月 28 日 14:00」，跨年带年份。按本机时区。 */
export function formatDayTime(ms: number, now: number, t: Translate): string {
  const d = new Date(ms)
  const params = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), monthName: MONTH_NAME.format(d) }
  const date = d.getFullYear() === new Date(now).getFullYear() ? t('time.monthDay', params) : t('time.yearMonthDay', params)
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return t('time.dayTime', { date, time })
}

/** 路径最后一段（项目名）。 */
export { baseName } from './path.ts'
