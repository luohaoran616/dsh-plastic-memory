/**
 * 转发覆盖守卫：fork 层（packages/mcp、packages/webui、独立装配、锚适配器）以 `@plastic/core/<路径>` 引用的
 * 每一个核心模块，都必须解析到上游布局 src/ 下的真实文件——转发包只是名字，不是第二份源码。
 * 清单不手维护：直接从源码里现数（grep），新增或删掉 import 时这里自动跟着变。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { resolveEntry } from '../scripts/export-surface.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const TSCONFIG = join(REPO, 'tsconfig.json')

function grepImports(): string[] {
  const out = execFileSync('grep', [
    '-rhoE', String.raw`@plastic/core/[A-Za-z0-9_./-]+`,
    'packages/mcp/src', 'packages/webui/src', 'src/standalone',
    'src/tools/anchor.ts', 'src/tools/anchor-zcode.ts', 'src/tools/anchor-antigravity.ts',
  ], { cwd: REPO, encoding: 'utf8' })
  return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))].sort()
}

describe('@plastic/core 转发覆盖（对齐后守卫）', () => {
  it('grep 能在 fork 层找到 @plastic/core 的引用（守卫自身健全）', () => {
    expect(grepImports().length).toBeGreaterThan(0)
  })

  it('每个被引用的子路径都解析到 src/ 下的真实文件', () => {
    for (const spec of grepImports()) {
      const entry = resolveEntry(spec, fileURLToPath(import.meta.url), TSCONFIG)
      expect(entry.startsWith(join(REPO, 'src')), `${entry} 应在 src/ 下`).toBe(true)
      expect(existsSync(entry), `${entry} 应存在`).toBe(true)
    }
  })
})
