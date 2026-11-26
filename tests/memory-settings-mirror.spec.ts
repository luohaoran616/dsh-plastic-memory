// 独立端设置的出厂值与词表是 DSH Config 的镜像：加了字段或改了默认值，两边都要显式动（与 config.spec.ts 的锁定互为对照）。
import { describe, expect, it } from 'vitest'

import { Config } from '../src/index.ts'
import { ACCENTS } from '../src/gui/contract.ts'
import { OVERFLOW_MODES } from '@plastic/core/contract-codes.ts'
import { PRESET_SCENES } from '../src/type-registry.ts'
import {
  DEFAULT_MEMORY_SETTINGS, EVIDENCE_LEVELS, PROMOTE_TARGETS, SENSITIVITIES,
} from '../src/governance/memory-settings.ts'

const plain = (v: unknown): unknown => {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(plain)
  if (typeof (v as { get?: unknown }).get === 'function') return plain((v as { get(): unknown }).get())
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, plain(x)]))
}

const union = (schema: unknown): string[] => {
  const list = (schema as { list?: Array<{ value?: unknown }> }).list ?? []
  return list.map(s => String(s.value))
}

describe('独立端设置镜像 DSH Config', () => {
  const config = plain(new Config({} as never)) as Record<string, unknown>

  it('出厂值逐字段与 Config 默认值一致', () => {
    expect(DEFAULT_MEMORY_SETTINGS).toEqual({
      template: config.template,
      customTypes: config.customTypes,
      scenes: config.scenes,
      removedPresetTypes: config.removedPresetTypes,
      snapshotTokenBudget: config.snapshotTokenBudget,
      snapshotOverflow: config.snapshotOverflow,
      evidenceLookup: config.evidenceLookup,
      governance: config.governance,
      accent: config.accent,
      memoryRoot: config.memoryRoot,
    })
  })

  it('出厂场景就是 PRESET_SCENES', () => {
    expect(DEFAULT_MEMORY_SETTINGS.scenes).toEqual(structuredClone(PRESET_SCENES))
  })

  it('词表与 Config 里的可选值一致（overflow、evidence、灵敏度、提升去处、主题色）', () => {
    const dict = (Config as unknown as { dict: Record<string, { dict?: Record<string, unknown>; list?: Array<{ value?: unknown }> }> }).dict
    expect([...OVERFLOW_MODES]).toEqual(union(dict.snapshotOverflow))
    expect([...EVIDENCE_LEVELS]).toEqual(union(dict.evidenceLookup))
    const governance = dict.governance as { dict: Record<string, unknown> }
    expect([...SENSITIVITIES]).toEqual(union((governance.dict.health as { dict: Record<string, unknown> }).dict.sensitivity))
    expect([...PROMOTE_TARGETS]).toEqual(union(governance.dict.globalPromoteTarget))
    expect([...ACCENTS]).toEqual(union(dict.accent))
  })
})
