import { describe, expect, it } from 'vitest'
import { markerOf } from './HealthTab.tsx'

/** 档位是产品口径（`src/governance/scoring.ts`），不是这一屏自己拍的：50–59 分必须与插件侧同为 amber。 */
describe('体检分档', () => {
  it('>= 80 绿、>= 50 黄、其余红', () => {
    expect(markerOf(100)).toBe('ok')
    expect(markerOf(80)).toBe('ok')
    expect(markerOf(79)).toBe('pending')
    expect(markerOf(50)).toBe('pending')
    expect(markerOf(49)).toBe('error')
    expect(markerOf(0)).toBe('error')
  })
})
