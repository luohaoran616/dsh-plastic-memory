/**
 * 导出面快照：用 TypeScript 编译器 API 列出模块的全部导出名（值 + 类型），给 `@plastic/core`
 * 搬家前后「导出面逐名一致」留证据，也是 tests/core-surface.spec.ts 的守卫数据源。
 *
 * 为什么走编译器 API 而不是运行时 import 一个模块数键：守卫要连 type-only 导出（接口、类型别名）
 * 一起守，那些名字运行时看不见；还要能在包还不存在时把「包缺失」与「导出面变了」分开报出来。
 * checker.getExportsOfModule 会把 `export *` 与 `export type { … }` 一并展开——同一声明经多条路
 * 再导出不会误判成冲突；真正同名不同源时 `export *` 会静默丢掉该名，守卫以「并集少名」的形式暴露。
 *
 * 用法：
 *   node scripts/export-surface.ts                                    # 重算快照（现在 core 在 packages/core/src）
 *   node scripts/export-surface.ts --source-root src --out /tmp/x.json # 换源目录与输出文件
 * tests/fixtures/core-surface.snapshot.json 是搬家前对 src/ 跑 `--source-root src` 得到的基线，别拿新结果覆盖它。
 */
import ts from 'typescript'
import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))

/**
 * 搬进 `@plastic/core` 的模块，路径相对包内 `src`（搬家前就是仓库 `src/` 下的相对路径）。
 * 包根桶文件 `src/index.ts` 不在此列：它按并集新写，由守卫测试单独核对。
 */
export const CORE_MODULES = [
  'store.ts',
  'record-schema.ts', 'record-freshness.ts', 'validity.ts', 'text.ts', 'errors.ts',
  'kv-table.ts', 'root-lock.ts', 'types.ts', 'scope.ts', 'index-line.ts',
  'contract-codes.ts', 'edits.ts', 'retention.ts', 'secrets.ts',
  'storage/agents-md.ts', 'storage/exclusive-link.ts', 'storage/file-table.ts', 'storage/frontmatter.ts',
  'storage/legacy-kv-import.ts', 'storage/parse-cache.ts', 'storage/paths.ts', 'storage/root-lock.ts',
  'storage/schema.ts', 'storage/sidecar.ts', 'storage/state-files.ts', 'storage/table.ts',
  'search/coverage.ts', 'search/jieba-segmenter.ts', 'search/ranking.ts', 'search/tokenizer.ts', 'search/window.ts',
  'gui/contract.ts',
] as const

/** 快照形状：逐模块导出名（键与搬家前 `src/` 下的相对路径一致）与它们的并集（包根桶文件应有的导出名）。 */
export interface SurfaceSnapshot {
  modules: Record<string, string[]>
  union: string[]
}

/** 读 tsconfig 的编译选项；读不出来时直接抛，别让守卫在错误的选项下算出一个「看起来对」的导出面。 */
function compilerOptions(configPath: string): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(`导出面快照：读不了 ${configPath}\n${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
    },
  })
  if (parsed === undefined) throw new Error(`导出面快照：读不了 ${configPath}`)
  return parsed.options
}

/** 逐模块算出导出名（已排序）。一次建一个 program，避免每个模块各扫一遍依赖。 */
export function exportNames(files: readonly string[], configPath: string): Map<string, string[]> {
  const missing = files.filter(file => !existsSync(file))
  if (missing.length > 0) throw new Error(`导出面快照：找不到模块文件\n${missing.join('\n')}`)
  const program = ts.createProgram(files, compilerOptions(configPath))
  const checker = program.getTypeChecker()
  const surfaces = new Map<string, string[]>()
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (source === undefined) throw new Error(`导出面快照：编译器没载入 ${file}`)
    const moduleSymbol = checker.getSymbolAtLocation(source)
    if (moduleSymbol === undefined) throw new Error(`导出面快照：${file} 不是模块，没有导出符号表`)
    surfaces.set(file, checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()).sort())
  }
  return surfaces
}

/** 按根 tsconfig 的模块解析规则把包名解析到入口文件（`@plastic/core` → `packages/core/src/index.ts`）。 */
export function resolveEntry(spec: string, containingFile: string, configPath: string): string {
  const resolved = ts.resolveModuleName(spec, containingFile, compilerOptions(configPath), ts.sys).resolvedModule
  if (resolved === undefined) throw new Error(`导出面快照：从 ${containingFile} 出发解析不到 ${spec}（按 ${configPath} 的模块解析规则）`)
  return resolved.resolvedFileName
}

/** 对 `sourceRoot` 下的整套模块生成快照。 */
export function surfaceSnapshot(modules: readonly string[], sourceRoot: string, configPath: string): SurfaceSnapshot {
  const surfaces = exportNames(modules.map(module => join(sourceRoot, module)), configPath)
  const snapshot: SurfaceSnapshot = { modules: {}, union: [] }
  for (const [file, names] of surfaces) snapshot.modules[relative(sourceRoot, file).split(sep).join('/')] = names
  snapshot.union = [...new Set([...surfaces.values()].flat())].sort()
  return snapshot
}

/** 相对仓库根的路径按 REPO 解析，绝对路径原样用（CLI 传 /tmp/xxx.json 也照做）。 */
function repoPath(path: string): string {
  return isAbsolute(path) ? path : join(REPO, path)
}

function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'source-root': { type: 'string', default: 'packages/core/src' },
      out: { type: 'string', default: 'tests/fixtures/core-surface.snapshot.json' },
      tsconfig: { type: 'string', default: 'tsconfig.json' },
    },
  })
  const out = repoPath(values.out)
  const snapshot = surfaceSnapshot(CORE_MODULES, repoPath(values['source-root']), repoPath(values.tsconfig))
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`导出面快照：${CORE_MODULES.length} 个模块，并集 ${snapshot.union.length} 个导出名 → ${values.out}`)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
