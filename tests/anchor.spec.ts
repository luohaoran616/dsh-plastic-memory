import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANCHOR_TEXT_CAP, ANCHOR_WINDOW_CAP, createAnchorLocator, isAntigravitySessionId, isZcodeSessionId,
  schemeOf, type AnchorAdapter, type SourceAnchor,
} from '../src/tools/anchor.ts'
import { TEXT_CAP, WINDOW_CAP } from '../src/tools/source.ts'

// 锚的公共层：scheme 编解码、id 形状校验、上限与 DSH 对齐、定位调度（时间盒、补试、探针失败只警告一次）。

describe('scheme 编解码', () => {
  it('四种 scheme 按前缀区分', () => {
    expect(schemeOf('sess_4a7ad63d-eff4-44f6-8875-d0641cf03f49')).toBe('dsh')
    expect(schemeOf('zcode:sess_4a7ad63d-eff4-44f6-8875-d0641cf03f49')).toBe('zcode')
    expect(schemeOf('antigravity:83310ec9-ef98-4b39-ad3d-edbdd079eaec')).toBe('antigravity')
    expect(schemeOf('mcp:zcode')).toBe('mcp')
    expect(schemeOf('')).toBe('dsh')
  })
})

describe('会话 id 形状校验', () => {
  it('ZCode：sess_/session_ + uuid；不合形状的不认', () => {
    expect(isZcodeSessionId('sess_3f115293-19bf-4d15-95a1-95fb92087a2d')).toBe(true)
    expect(isZcodeSessionId('session_3f115293-19bf-4d15-95a1-95fb92087a2d')).toBe(true)
    expect(isZcodeSessionId('sess_3f115293')).toBe(false)
    expect(isZcodeSessionId('sess_3f115293-19bf-4d15-95a1-95fb92087g2d')).toBe(false) // 非 hex
    expect(isZcodeSessionId('sess_')).toBe(false)
    expect(isZcodeSessionId('../../etc/passwd')).toBe(false)
    expect(isZcodeSessionId('')).toBe(false)
  })
  it('Antigravity：裸 uuid；带前缀或短一截的不认', () => {
    expect(isAntigravitySessionId('83310ec9-ef98-4b39-ad3d-edbdd079eaec')).toBe(true)
    expect(isAntigravitySessionId('zcode:83310ec9-ef98-4b39-ad3d-edbdd079eaec')).toBe(false)
    expect(isAntigravitySessionId('83310ec9')).toBe(false)
    expect(isAntigravitySessionId('')).toBe(false)
  })
})

describe('上限与 DSH 的 source 对齐', () => {
  it('锚开窗/截断与 source.ts 同值', () => {
    expect(ANCHOR_WINDOW_CAP).toBe(WINDOW_CAP)
    expect(ANCHOR_TEXT_CAP).toBe(TEXT_CAP)
  })
})

/** 调度用假适配器：按第 n 次调用决定回锚还是 undefined，或直接抛错。 */
function fakeAdapter(scheme: 'zcode' | 'antigravity', run: (call: number) => Promise<SourceAnchor | undefined>): AnchorAdapter & { calls: number } {
  const adapter = {
    scheme,
    calls: 0,
    locateCall: () => {
      adapter.calls++
      return run(adapter.calls)
    },
    readWindow: () => Promise.reject(new Error('本用例不读窗')),
  }
  return adapter
}

const anchorAt = (call: number): SourceAnchor => ({ sessionId: `zcode:sess_00000000-0000-4000-8000-00000000000${call}`, eventRange: [0, call] })

describe('定位调度', () => {
  it('enabled: false 不碰适配器', async () => {
    const adapter = fakeAdapter('zcode', () => Promise.resolve(anchorAt(1)))
    const locator = createAnchorLocator({ enabled: false, adapters: [adapter] })
    expect(await locator.locate({ title: 't', text: 'x' })).toBeUndefined()
    expect(adapter.calls).toBe(0)
  })
  it('没有适配器（目录都不存在）直接回 undefined', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'pm-anchor-')), 'not-there')
    const locator = createAnchorLocator({ zcodeDir: missing, retryDelaysMs: [1, 1] })
    expect(locator.adapters).toHaveLength(0)
    expect(await locator.locate({ title: 't', text: 'x' })).toBeUndefined()
    await rm(missing, { recursive: true, force: true })
  })
  it('首次没找到按 delays 补试，补到即出锚', async () => {
    const adapter = fakeAdapter('zcode', call => Promise.resolve(call >= 3 ? anchorAt(call) : undefined))
    const lines: string[] = []
    const locator = createAnchorLocator({ adapters: [adapter], retryDelaysMs: [5, 5], log: l => lines.push(l) })
    const anchor = await locator.locate({ title: 't', text: 'x' })
    expect(adapter.calls).toBe(3)
    expect(anchor?.eventRange).toEqual([0, 3])
    expect(lines.filter(l => l.startsWith('锚定 '))).toHaveLength(1)
  })
  it('时间盒到点就收：不再发起补试', async () => {
    const adapter = fakeAdapter('zcode', () => Promise.resolve(undefined))
    const locator = createAnchorLocator({ adapters: [adapter], retryDelaysMs: [80], timeBudgetMs: 20 })
    expect(await locator.locate({ title: 't', text: 'x' })).toBeUndefined()
    expect(adapter.calls).toBe(1)
  })
  it('探针失败每个适配器只警告一次，最终记「未定位」', async () => {
    const adapter = fakeAdapter('zcode', () => Promise.reject(new Error('库结构认不得')))
    const lines: string[] = []
    const locator = createAnchorLocator({ adapters: [adapter], retryDelaysMs: [5, 5], log: l => lines.push(l) })
    await expect(locator.locate({ title: 't', text: 'x' })).resolves.toBeUndefined()
    expect(adapter.calls).toBe(3)
    expect(lines.filter(l => l.includes('只警告一次'))).toHaveLength(1)
    expect(lines.at(-1)).toContain('未定位')
    expect(lines.at(-1)).toContain('库结构认不得')
  })
  it('全部没找到（不是失败）也记一行「未定位」', async () => {
    const adapter = fakeAdapter('zcode', () => Promise.resolve(undefined))
    const lines: string[] = []
    const locator = createAnchorLocator({ adapters: [adapter], retryDelaysMs: [5, 5], log: l => lines.push(l) })
    await expect(locator.locate({ title: 't', text: 'x' })).resolves.toBeUndefined()
    expect(lines.at(-1)).toContain('未定位')
    expect(lines.at(-1)).toContain('参数全等')
  })
  it('reader 按 scheme 取适配器；dsh/mcp 没有适配器', () => {
    const zcode = fakeAdapter('zcode', () => Promise.resolve(undefined))
    const antigravity = fakeAdapter('antigravity', () => Promise.resolve(undefined))
    const locator = createAnchorLocator({ adapters: [zcode, antigravity] })
    expect(locator.reader('zcode')).toBe(zcode)
    expect(locator.reader('antigravity')).toBe(antigravity)
    expect(locator.reader('dsh')).toBeUndefined()
    expect(locator.reader('mcp')).toBeUndefined()
  })
})
