/**
 * 独立页面的语言：缺省中文，用户选过的记在 localStorage 里（下次打开还是那个语言）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { en, zh } from 'dsh-plastic-memory/client/locales.ts'
import { LOCALE_KEY, useStandaloneTranslate } from './locale.ts'

describe('独立页面的语言', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('缺省中文', () => {
    const { result } = renderHook(() => useStandaloneTranslate())
    expect(result.current.locale).toBe('zh')
    expect(result.current.t('nav.label')).toBe(zh['nav.label'])
  })

  it('选了英文就记在 localStorage 里，翻译走英文', () => {
    const { result } = renderHook(() => useStandaloneTranslate())
    act(() => { result.current.setLocale('en') })
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en')
    expect(result.current.locale).toBe('en')
    expect(result.current.t('nav.label')).toBe(en['nav.label'])
  })

  it('上次选的英文在下次打开时还在', () => {
    localStorage.setItem(LOCALE_KEY, 'en')
    const { result } = renderHook(() => useStandaloneTranslate())
    expect(result.current.locale).toBe('en')
    expect(result.current.t('nav.label')).toBe(en['nav.label'])
  })
})
