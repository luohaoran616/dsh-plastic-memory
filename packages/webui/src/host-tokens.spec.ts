/**
 * 宿主令牌：原版记忆页的样式只认 `--pm-*`，那些令牌指向宿主的 `--dsw-*`。
 * 独立页面没有宿主，缺一个 `--dsw-*` 就掉一块色，所以逐个核对：页面用到的每个都在 `host-tokens.css` 里有定义。
 */
import { describe, expect, it } from 'vitest'
import { PM_CSS } from 'dsh-plastic-memory/client/ui/PanelShell.tsx'
import { slotCss } from 'dsh-plastic-memory/client/styles.ts'
import hostTokens from './host-tokens.css?raw'

/** 令牌名：至少一个字母数字开头，避免匹配到注释里的 `--dsw-*` 通配写法。 */
const TOKEN = /--dsw-[a-zA-Z0-9][a-zA-Z0-9-]*/g

/** 页面用到的令牌名（去重）。 */
function referenced(): string[] {
  return [...new Set([...(PM_CSS + slotCss('page')).matchAll(TOKEN)].map(match => match[0]))]
}

/** host-tokens.css 里定义过的令牌名（亮色与暗色两块取并集）。 */
function defined(): string[] {
  return [...new Set([...hostTokens.matchAll(/(--dsw-[a-zA-Z0-9][a-zA-Z0-9-]*)\s*:/g)].map(match => match[1]))]
}

describe('宿主令牌', () => {
  it('页面用到的每个 --dsw-* 都有定义', () => {
    const missing = referenced().filter(name => !defined().includes(name))
    expect(missing).toEqual([])
  })

  it('亮色与暗色两块都在（暗色挂在 body[data-ds-dark-theme] 上）', () => {
    expect(hostTokens).toContain('body[data-ds-dark-theme]')
    expect(hostTokens).toContain('--dsw-alias-bg-base')
  })
})
