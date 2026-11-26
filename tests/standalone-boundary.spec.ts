import { describe, expect, it } from 'vitest'
import { importClosure } from './helpers/import-closure.ts'

// 独立页面（packages/webui）与无宿主装配（src/standalone）从根包源码出发，和 DSH 宿主切得开才搬得走：
// 界面闭包不碰宿主运行时，无宿主装配闭包不碰框架运行时，也不把插件入口与工具绑定层拖进来。
const PAGE_ROOTS = [
  'client/MemoryPage.tsx', 'client/ui/PanelShell.tsx', 'client/styles.ts', 'client/gateway.ts',
  'client/settings/SettingsPage.tsx',
]
const PLANE_ROOTS = [
  'src/standalone/plane.ts', 'src/standalone/host.ts', 'src/standalone/llm.ts', 'src/standalone/context.ts',
  'src/gui/commands.ts', 'src/gui/view-writer.ts', 'src/gui/checkup-suggestions.ts', 'src/gui/auto-checkup.ts',
  'src/governance/instructions.ts', 'src/type-registry.ts',
]

describe('独立页面边界', () => {
  it('记忆页界面闭包不依赖宿主运行时', () => {
    const c = importClosure(PAGE_ROOTS)
    expect([...c.externals.keys()].sort()).toEqual(['@plastic/core', 'diff', 'react', 'react-dom', 'zod'])
    expect(c.runtimeImports.filter(r => r.spec.startsWith('@deepseek-ai/'))).toEqual([])
    expect(c.files).not.toContain('client/index.tsx')
  })

  it('无宿主装配闭包不含框架运行时导入', () => {
    const c = importClosure(PLANE_ROOTS)
    expect(c.runtimeImports.filter(r => r.spec.startsWith('@deepseek-ai/'))).toEqual([])
    expect(c.files.filter(f => /src\/index\.ts$|cordis-host-session|domain-spec|-tool\.ts$/.test(f))).toEqual([])
  })
})
