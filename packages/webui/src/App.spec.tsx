/**
 * 独立页面：记忆页与设置页两个视图（hash 路由）。用例注入内存假网关与假设置表单，不碰网络。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { createFakeGateway } from 'dsh-plastic-memory/client/gateway.fake.ts'
import type { ConfigForm, ConfigFormSnapshot } from 'dsh-plastic-memory/client/host.ts'
import { en, zh } from 'dsh-plastic-memory/client/locales.ts'
import { App } from './App.tsx'

/** 记忆页的三个视图页签，文案走词典。 */
function tabLabels(): string[] {
  return screen.getAllByRole('tab').map(tab => tab.textContent ?? '')
}

/** 假设置表单：恒 ready，set/mutate 就地应用并发布。 */
function createFakeForm(): ConfigForm {
  let snapshot: ConfigFormSnapshot = { status: 'ready', value: {}, revision: 1, writable: true }
  const listeners = new Set<() => void>()
  const publish = (): void => { for (const fn of listeners) fn() }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async set(field, value) {
      snapshot = { status: 'ready', value: { ...(snapshot.value as Record<string, unknown>), [field]: value }, revision: snapshot.revision! + 1, writable: true }
      publish()
      return true
    },
    async mutate(ops) {
      const value = { ...(snapshot.value as Record<string, unknown>) }
      for (const op of ops) {
        if (op.op !== 'set' || op.path.length !== 1) continue
        value[op.path[0]!] = op.value
      }
      snapshot = { status: 'ready', value, revision: snapshot.revision! + 1, writable: true }
      publish()
      return true
    },
  }
}

describe('独立页面', () => {
  beforeEach(() => {
    localStorage.clear()
    window.location.hash = ''
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

  it('「设置」入口进设置视图，hash 同步；「记忆页」返回', () => {
    render(<App gateway={createFakeGateway()} form={createFakeForm()} />)
    fireEvent.click(screen.getByRole('button', { name: zh['rail.settings'] }))
    expect(window.location.hash).toBe('#/settings')
    expect(screen.getByText(zh['settings.group.what'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '记忆页' }))
    expect(window.location.hash).toBe('#/')
    expect(tabLabels()).toEqual([zh['tab.todo'], zh['tab.library'], zh['tab.deleted']])
  })

  it('设置视图的「怎么管」两项置灰并写明原因（独立端没有消费者）', () => {
    render(<App gateway={createFakeGateway()} form={createFakeForm()} />)
    fireEvent.click(screen.getByRole('button', { name: zh['rail.settings'] }))
    // 原因说明出现（灵敏度与提升去处两处）
    expect(screen.getAllByText('独立端没有这些功能的消费者：值会保存，提醒灵敏度与提升去处只在 DSH 宿主里生效')).toHaveLength(2)
    // 置灰的分段控件确实不可点：设置区里存在 disabled 的按钮
    const disabled = (screen.getAllByRole('button') as HTMLButtonElement[]).filter(button => button.disabled)
    expect(disabled.length).toBeGreaterThan(0)
  })

  it('直接带着 #/settings 打开时落在设置视图', () => {
    window.location.hash = '#/settings'
    render(<App gateway={createFakeGateway()} form={createFakeForm()} />)
    expect(screen.getByText(zh['settings.group.what'])).toBeTruthy()
    // 记忆页的页签不在（设置页自己的分段控件也用 tab 角色，按名字区分）
    expect(screen.queryByRole('tab', { name: zh['tab.todo'] })).toBeNull()
  })
})
