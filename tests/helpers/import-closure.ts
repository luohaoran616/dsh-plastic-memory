import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

// 独立页面的边界门禁靠这里算导入闭包：从一个起点出发，顺着相对 import 把会一起编译/打进的源码收齐，
// 同时记下两样东西——闭包对外部包（含 @deepseek-ai/* 与 node 内置模块）的依赖，以及会在运行时执行的导入
// （`import type`、全 `type` 具名子句与 `export type … from` 都不会进运行时导入）。
// 静态读文件 + 正则扫描，不执行源码；测试文件（`*.spec.*`）不算进闭包。

const ROOT_DIR = fileURLToPath(new URL('../..', import.meta.url))

interface ImportEdge { spec: string; isTypeOnly: boolean }

export interface ImportClosure {
  /** 闭包内的源码文件（相对仓库根，含起点本身），按路径排序。 */
  files: string[]
  /** 闭包依赖的仓库外代码：包名 → 引用它的闭包文件。深路径按包名归并（`@scope/pkg/sub.ts` → `@scope/pkg`）。 */
  externals: Map<string, Set<string>>
  /** 会被执行到的导入（不含类型导入），按扫描顺序。 */
  runtimeImports: Array<{ file: string; spec: string }>
}

// import/import type/export ... from '…'、副作用 import '…'（可跨行）；动态 import('…') 单独扫。
const STATIC_RE = /^\s*(import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/gm
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** `{ type A, type B }` 这种每个具名项都带 type 的子句也是类型导入；副作用 import（无子句）算运行时。 */
function isTypeOnlyClause(clause: string | undefined): boolean {
  const named = clause?.trim().match(/^\{([\s\S]*)\}$/)
  if (!named) return false
  const items = named[1]!.split(',').map(s => s.trim()).filter(s => s !== '')
  return items.length > 0 && items.every(s => s.startsWith('type '))
}

function scanImports(file: string): ImportEdge[] {
  const source = readFileSync(join(ROOT_DIR, file), 'utf8')
  const edges: ImportEdge[] = []
  for (const m of source.matchAll(STATIC_RE)) {
    edges.push({ spec: m[4]!, isTypeOnly: m[2] !== undefined || isTypeOnlyClause(m[3]) })
  }
  for (const m of source.matchAll(DYNAMIC_RE)) edges.push({ spec: m[1]!, isTypeOnly: false })
  return edges
}

/** 相对导入补全成仓库内文件：先按原样（带扩展名），再试 `.ts`、`.tsx` 与目录的 `index.ts`。 */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), spec))
  if (base.startsWith('..')) return undefined
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(c => existsSync(join(ROOT_DIR, c)))
}

function isSpecFile(file: string): boolean {
  return /(?:^|\/)[^/]+\.spec\./.test(file)
}

/** 裸模块名归并到包名：作用域包取两段，其余取第一段；`node:fs/promises` 归到 `node:fs`。 */
function packageName(spec: string): string {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** 算一组起点（相对仓库根）的导入闭包；起点不存在时抛错，避免拼错路径把门禁悄悄放空。 */
export function importClosure(roots: readonly string[]): ImportClosure {
  const files: string[] = []
  const externals = new Map<string, Set<string>>()
  const runtimeImports: Array<{ file: string; spec: string }> = []
  const seen = new Set<string>()
  const queue: string[] = []

  for (const root of roots) {
    const file = posix.normalize(root)
    if (!existsSync(join(ROOT_DIR, file))) throw new Error(`导入闭包的起点不存在：${file}`)
    if (!seen.has(file)) {
      seen.add(file)
      queue.push(file)
    }
  }

  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]!
    files.push(file)
    for (const edge of scanImports(file)) {
      if (!edge.isTypeOnly) runtimeImports.push({ file, spec: edge.spec })
      if (edge.spec.startsWith('.')) {
        const target = resolveRelative(file, edge.spec)
        if (target === undefined || isSpecFile(target) || seen.has(target)) continue
        seen.add(target)
        queue.push(target)
      } else {
        const name = packageName(edge.spec)
        const byFile = externals.get(name) ?? new Set<string>()
        byFile.add(file)
        externals.set(name, byFile)
      }
    }
  }

  return { files: files.sort(), externals, runtimeImports }
}
