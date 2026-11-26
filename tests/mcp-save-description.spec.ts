import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore } from '@plastic/core/storage/sidecar.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import { MemorySettings, createSettingsRegistry } from '../src/governance/memory-settings.ts'
import { buildTypeRegistry, CONTENT_WRITING_GUIDE } from '../src/type-registry.ts'
import { MCP_TEXT_GUIDE } from '../packages/mcp/src/tools.ts'

// MCP 工具面的写侧说明与 DSH 源头的关系。两处都要守：
// text 参数说明是 DSH content 说明的同一段正文写法；通用层规则按面取（SAVE_GUIDE_MCP），经设置驱动的转发对象
// 送到工具上时 surface 不能丢——丢了 MCP 面就会渲染出 DSH 的参数名（action/edits/content/scope），
// 模型在 schema 里找不到这些参数，会以为更新不可用（2026-11-26 Antigravity 实测踩到）。

/** 只在 DSH 工具面成立的措辞：MCP 面一个都不该出现。 */
const DSH_ONLY = [
  'action=update', '传 edits', '传 content', 'scope 默认填 workspace', 'sourceMode 填 agent-inferred',
  '界面会把这轮写入的记忆展示给用户',
]
/** MCP 面才有的措辞。 */
const MCP_ONLY = ['更新已有记忆传 id 和 text', 'origin 填 agent-inferred']

const absentEverywhere = (text: string, marks: readonly string[]): string[] => marks.filter(m => text.includes(m))
const presentEverywhere = (text: string, marks: readonly string[]): string[] => marks.filter(m => !text.includes(m))

describe('memory_save 的 text 参数说明', () => {
  it('MCP 面与 DSH 的 content 说明是同一段正文写法，只把开头那句 DSH 专属的换成「记忆正文。」', () => {
    const dshHead = '整条正文，会替换原来的全部正文；只改其中几处用 edits。'
    expect(CONTENT_WRITING_GUIDE.startsWith(dshHead)).toBe(true)
    expect(MCP_TEXT_GUIDE).toBe(`记忆正文。${CONTENT_WRITING_GUIDE.slice(dshHead.length)}`)
  })
})

describe('写侧通用层规则按工具面渲染', () => {
  const config = { template: 'custom', customTypes: {}, scenes: {}, removedPresetTypes: [] } as const

  it('mcp 面：没有 DSH 的参数名，有 MCP 的写法；dsh 面（缺省）逐字保持', () => {
    const mcp = buildTypeRegistry(config).renderSaveDescription('mcp')
    expect(absentEverywhere(mcp, DSH_ONLY)).toEqual([])
    expect(presentEverywhere(mcp, MCP_ONLY)).toEqual([])
    const dsh = buildTypeRegistry(config).renderSaveDescription()
    expect(absentEverywhere(dsh, MCP_ONLY)).toEqual([])
    expect(dsh).toContain('更新已有记忆传 action=update 和目标 id')
  })

  describe('经设置驱动的转发对象（独立端的上下文平面用的就是它）', () => {
    let root: string
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-save-description-')) })
    afterEach(async () => { await rm(root, { recursive: true, force: true }) })

    async function backed() {
      const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }
      const log = { info() {}, warn() {}, error() {} }
      const { registry } = await createSettingsRegistry(new MemorySettings(new SidecarStore({ root, schemas }).settings, log), log)
      return registry
    }

    it('surface 原样转给背后的表：mcp 面不带 DSH 的参数名', async () => {
      const registry = await backed()
      const mcp = registry.renderSaveDescription('mcp')
      expect(absentEverywhere(mcp, DSH_ONLY)).toEqual([])
      expect(presentEverywhere(mcp, MCP_ONLY)).toEqual([])
      // 缺省面不受影响
      expect(registry.renderSaveDescription()).toContain('更新已有记忆传 action=update 和目标 id')
    })
  })
})
