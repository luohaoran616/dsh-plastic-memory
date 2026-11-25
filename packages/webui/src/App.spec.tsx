/**
 * 独立页面：原版记忆页挂在页面壳里（网关、词典、导航 store 都由页面给），页眉带一个中英文切换。
 * 用例注入内存假网关（根包 `client/gateway.fake.ts`），不碰网络。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { createFakeGateway } from 'dsh-plastic-memory/client/gateway.fake.ts'
import { en, zh } from 'dsh-plastic-memory/client/locales.ts'
import { App } from './App.tsx'

/** 记忆页的三个视图页签，文案走词典。 */
function tabLabels(): string[] {
  return screen.getAllByRole('tab').map(tab => tab.textContent ?? '')
}

describe('独立页面', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('渲染出原版记忆页的三个视图页签', () => {
    render(<App gateway={createFakeGateway()} />)
    expect(tabLabels()).toEqual([zh['tab.todo'], zh['tab.library'], zh['tab.deleted']])
  })

  it('页眉只放语言切换，不重复记忆页自己的标题', () => {
    render(<App gateway={createFakeGateway()} />)
    const head = document.querySelector('.webui-head')
    expect(head).not.toBeNull()
    expect(within(head as HTMLElement).queryAllByRole('heading')).toHaveLength(0)
    expect(within(head as HTMLElement).getAllByRole('button')).toHaveLength(1)
    expect(screen.getAllByRole('heading', { name: zh['nav.label'] })).toHaveLength(1)
  })

  it('切到英文后页签换成英文', () => {
    render(<App gateway={createFakeGateway()} />)
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    expect(tabLabels()).toEqual([en['tab.todo'], en['tab.library'], en['tab.deleted']])
  })
})
