/**
 * 搬家守卫：`@plastic/core` 的导出面必须与搬家前 `src/` 的逐名快照一致。
 * 快照由 scripts/export-surface.ts 在搬家前对 src/ 生成（tests/fixtures/core-surface.snapshot.json）；
 * 这里对包内新位置与包根桶文件各算一遍——少名、多名、把导出丢在错误的模块里，都会红。
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CORE_MODULES, exportNames, resolveEntry, type SurfaceSnapshot } from '../scripts/export-surface.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const CORE_SRC = join(REPO, 'packages/core/src')
const TSCONFIG = join(REPO, 'tsconfig.json')
const SNAPSHOT = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/core-surface.snapshot.json'), 'utf8')) as SurfaceSnapshot

/** 快照的键是包内相对 `src` 的 posix 路径，与实际文件路径的比对统一到同一种写法。 */
function packPath(file: string): string {
  return relative(CORE_SRC, file).split(sep).join('/')
}

describe('@plastic/core 导出面（搬家守卫）', () => {
  it('逐模块导出名与搬家前快照一致', () => {
    const files = CORE_MODULES.map(module => join(CORE_SRC, module))
    const actual = Object.fromEntries([...exportNames(files, TSCONFIG)].map(([file, names]) => [packPath(file), names]))
    expect(actual).toEqual(SNAPSHOT.modules)
  })

  it('包根桶文件的导出名等于搬家前各模块的并集', () => {
    const entry = resolveEntry('@plastic/core', fileURLToPath(import.meta.url), TSCONFIG)
    expect(exportNames([entry], TSCONFIG).get(entry)).toEqual(SNAPSHOT.union)
  })

  it('快照自洽：并集就是逐模块导出名的去重并集', () => {
    expect([...new Set(Object.values(SNAPSHOT.modules).flat())].sort()).toEqual(SNAPSHOT.union)
  })
})
