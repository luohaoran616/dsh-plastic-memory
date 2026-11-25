/** 总字典：上游 `client/locales.ts` 的节选（base.ts）+ 本 SPA 自己的文案（webui.ts）。 */
import { baseZh } from './locales/base.ts'
import { webuiZh } from './locales/webui.ts'

export const zh = { ...baseZh, ...webuiZh }

export type LocaleKey = keyof typeof zh
