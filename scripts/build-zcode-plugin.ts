/**
 * ZCode 插件打包（spec D7）：把「MCP 服务 + SessionStart 快照 hook」装成一个本地插件目录，
 * 装一次两样都有。产物指向仓库里已构建好的 `packages/mcp/lib/bin.js`（插件本体不背 node_modules，
 * 先在仓库根目录跑过 `pnpm build && pnpm --filter @plastic/mcp build` 再打包）。
 *
 * 用法：
 *   node scripts/build-zcode-plugin.ts                          # 产出到 integrations/zcode/dist/plastic-memory/
 *   node scripts/build-zcode-plugin.ts --out /tmp/plugin --root /home/me/.dsh/memories --repo /path/to/repo
 *
 * `PLASTIC_PROJECT` 用 `${CLAUDE_PROJECT_DIR}` 模板：插件提供的 MCP 服务会展开它（按工作区解析项目）。
 * `env` 的值是否展开没有实证——实测不成立时按 integrations/zcode/README.md 的回退办法手改客户端配置。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)

/** 插件目录里指向仓库产物的路径，全部转成绝对路径的 POSIX 写法。 */
function main(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', default: 'integrations/zcode/dist/plastic-memory' },
      root: { type: 'string', default: '' },
      repo: { type: 'string', default: REPO },
    },
  })
  const repo = resolve(values.repo!)
  const bin = join(repo, 'packages', 'mcp', 'lib', 'bin.js')
  const memoryRoot = values.root !== '' ? resolve(values.root) : join(homedir(), '.dsh', 'memories')
  const version = (require(join(repo, 'packages/mcp/package.json')) as { version: string }).version

  const plugin = {
    name: 'plastic-memory',
    version,
    description: 'plastic-memory 长期记忆：六个 memory_* 工具（走与 DSH 插件同一条写入管线）+ 会话启动注入记忆快照。',
    mcpServers: {
      'plastic-memory': {
        command: 'node',
        args: [bin, 'stdio'],
        env: {
          PLASTIC_MEMORY_ROOT: memoryRoot,
          // 模板变量由客户端按工作区展开（实测见 README 的回退办法；不成立时 project 维持写死）
          PLASTIC_PROJECT: '${CLAUDE_PROJECT_DIR}',
          PLASTIC_CLIENT: 'zcode',
        },
      },
    },
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: `node ${bin} hook-snapshot` },
          ],
        },
      ],
    },
  }

  const out = resolve(isAbsolute(values.out!) ? values.out! : join(repo, values.out!))
  // 产物目录每次重建（打包是幂等的生成动作，不是增量更新）：仓库根不在重建之列
  if (out === repo) {
    throw new Error(`输出目录不能是仓库根：${out}`)
  }
  void (async (): Promise<void> => {
    await rm(out, { recursive: true, force: true })
    await mkdir(join(out, '.zcode-plugin'), { recursive: true })
    await writeFile(join(out, '.zcode-plugin', 'plugin.json'), `${JSON.stringify(plugin, null, 2)}\n`)
    await writeFile(join(out, 'README.md'), `# plastic-memory（ZCode 插件）\n\n由 \`node scripts/build-zcode-plugin.ts\` 生成于 ${new Date().toISOString()}。\n安装、回退与实测说明见仓库 README 的「跨端接入」章与 integrations/zcode/README.md。\n`)
    process.stdout.write(`ZCode 插件已生成：${out}\n  MCP: node ${bin} stdio\n  hook: node ${bin} hook-snapshot\n  记忆根: ${memoryRoot}\n`)
  })().catch((error: unknown) => {
    process.stderr.write(`打包失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
