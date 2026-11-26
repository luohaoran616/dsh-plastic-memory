#!/usr/bin/env node
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { createMemoryTools, type MemoryToolset, type MemoryTools } from './tools.ts'
import type { GuiPlanePort } from './gui-http.ts'

/**
 * plastic-mcp 的进程入口：缺省 stdio 模式（ZCode、Antigravity 各起一个进程实例，与 DSH 插件同开一个记忆根）。
 * stdout 是 MCP 的 JSON-RPC 通道，所有日志一律走 stderr（core 的缺省 logger 是 console，会写 stdout，必须换掉）。
 * `serve` 子命令起 HTTP 模式（/mcp + /api + 静态 WebUI），入口在 serve.ts。
 * 两种模式都建在上下文平面上（根包的无宿主装配）：一张文件表、一份设置、一把锁；该平面在根包的编译产物里，
 * 没有产物时给出「先在仓库根目录跑 pnpm build」的提示。
 */

const pkg = createRequire(import.meta.url)('../package.json') as { version: string }

/** 客户端标识缺省值（D6）：PLASTIC_CLIENT 没配时也要有明确的值，不空着。 */
const DEFAULT_CLIENT = 'unknown'

const stderrLog: MemoryLogger = {
  info: message => writeStderr(message),
  warn: message => writeStderr(message),
  error: (message, detail) => writeStderr(detail === undefined ? message : `${message} ${describe(detail)}`),
}

function writeStderr(message: string): void {
  process.stderr.write(`[plastic-mcp] ${message}\n`)
}

function describe(detail: unknown): string {
  return detail instanceof Error ? detail.message : String(detail)
}

function fail(message: string): never {
  process.stderr.write(`plastic-mcp: ${message}\n`)
  process.exit(1)
}

interface EnvConfig {
  /** PLASTIC_MEMORY_ROOT：记忆根绝对路径（必填，不猜缺省值）。 */
  root: string
  /** PLASTIC_CLIENT：客户端标识，缺省 unknown；写进 source.sessionId = `mcp:<client>`。 */
  client: string
  /** PLASTIC_PROJECT：各端配置里写死的项目映射，project 入参缺省时用。 */
  project?: string
}

function resolveConfig(): EnvConfig {
  const root = process.env.PLASTIC_MEMORY_ROOT?.trim() ?? ''
  if (root === '') fail('缺少环境变量 PLASTIC_MEMORY_ROOT（记忆根绝对路径）')
  if (!isAbsolute(root)) fail(`PLASTIC_MEMORY_ROOT 必须是绝对路径：${root}`)
  const project = process.env.PLASTIC_PROJECT?.trim() ?? ''
  const client = process.env.PLASTIC_CLIENT?.trim() ?? ''
  return {
    root,
    client: client === '' ? DEFAULT_CLIENT : client,
    ...(project === '' ? {} : { project }),
  }
}

/** 根包编译产物里的上下文平面入口：两种模式都要它（存储 + 设置 + 类型表 + 快照 + 管线 + 检索）。 */
const CONTEXT_PLANE_MODULE = 'dsh-plastic-memory/lib/standalone/context.js'
type ContextPlaneModule = typeof import('dsh-plastic-memory/lib/standalone/context.js')
type ContextPlane = import('dsh-plastic-memory/lib/standalone/context.js').ContextPlane

/** 根包编译产物里的两个无宿主入口：serve 分支才动态加载，stdio 模式不为独立页面背依赖。 */
const GUI_PLANE_MODULE = 'dsh-plastic-memory/lib/standalone/plane.js'
const GUI_LLM_MODULE = 'dsh-plastic-memory/lib/standalone/llm.js'
type GuiPlaneModule = typeof import('dsh-plastic-memory/lib/standalone/plane.js')
type GuiLlmModule = typeof import('dsh-plastic-memory/lib/standalone/llm.js')

/** 根包没构建或不在此工作区时入口解析不到：提示先构建，而不是抛裸的模块错误。 */
const BUILD_HINT = '需要根包的构建产物（上下文平面）：先在仓库根目录跑 pnpm build'

async function loadContextPlane(config: EnvConfig): Promise<ContextPlane> {
  const { createContextPlane } = await import(CONTEXT_PLANE_MODULE).catch(() => fail(BUILD_HINT)) as ContextPlaneModule
  return createContextPlane({
    memoryRoot: config.root,
    client: config.client,
    log: stderrLog,
    ...(config.project === undefined ? {} : { project: config.project }),
  })
}

async function runStdio(): Promise<void> {
  const config = resolveConfig()
  const context = await loadContextPlane(config)
  const toolset = createMemoryTools(context)
  // 测试钩子整体替换 tools 的函数；处理器按属性现取，包装后的 save 照常生效
  toolset.tools = await withTestHoldLockIfRequested(toolset.tools, config.root)

  const server = new McpServer({ name: 'plastic-memory', version: pkg.version })
  await toolset.register(server)

  let closing = false
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    void server.close()
      .catch(() => {})
      .finally(() => process.exit(code))
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  // 客户端关掉 stdin（或 stdio 客户端 close）：协议通道结束，进程跟着退，不留后台句柄
  process.stdin.once('end', () => shutdown(0))

  await server.connect(new StdioServerTransport())
}

/** test-hold-lock.ts 的形状。不能写成 `typeof import('./test-hold-lock.ts')`：类型引用同样会把该文件拉进编译。 */
interface TestHoldLockModule {
  withTestHoldLock: (tools: MemoryTools, options: { root: string; dir: string; log: MemoryLogger }) => MemoryTools
}

/** 测试钩子模块的说明符。不写字面量：字面量动态 import 会让 tsc 把 test-hold-lock.ts 重新拉进编译，
 *  tsconfig.build.json 的 exclude 就失效了（发布的 lib/ 不该带这个「设了变量就永远持锁」的模块）。 */
const TEST_HOLD_LOCK_MODULE = './test-hold-lock.ts'

/**
 * 测试专用钩子的接线（concurrency.spec 的「持锁崩溃」用例）：只在 PLASTIC_MCP_TEST_HOLD_LOCK 存在时才动态加载
 * ./test-hold-lock.ts。正常启动路径不为这个测试装置背 fs/timers/root-lock 的 import。
 */
async function withTestHoldLockIfRequested(tools: MemoryTools, root: string): Promise<MemoryTools> {
  const dir = process.env.PLASTIC_MCP_TEST_HOLD_LOCK?.trim() ?? ''
  if (dir === '') return tools
  const { withTestHoldLock } = await import(TEST_HOLD_LOCK_MODULE) as TestHoldLockModule
  return withTestHoldLock(tools, { root, dir, log: stderrLog })
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'stdio'
  switch (command) {
    case 'stdio':
      await runStdio()
      return
    case 'hook-snapshot': {
      // SessionStart 的快照 hook（D5）：只走 HTTP，不建上下文平面；任何失败静默退出 0
      const { hookOptionsFromEnv, runHookCli } = await import('./hook-snapshot.ts')
      await runHookCli(hookOptionsFromEnv(process.env))
      return
    }
    case 'import-zcode': {
      // 动态加载：stdio 模式不为导入器背 fs 与读映射文件的依赖，两条路径互不影响
      const { runImportZcodeCli } = await import('./import-zcode.ts')
      await runImportZcodeCli(argv.slice(1), stderrLog)
      return
    }
    case 'serve': {
      const config = resolveConfig()
      // 动态加载：stdio 模式不为 HTTP / 静态托管背 node:fs 与 HTTP 路由的依赖
      const { parseGuiEnv, runServeCli } = await import('./serve.ts')
      // 先读环境变量：项目与模型线路配错就在开门之前退出，不留下半启动的服务
      const guiEnv = parseGuiEnv(process.env)
      const { createGuiPlane } = await import(GUI_PLANE_MODULE).catch(() => fail(BUILD_HINT)) as GuiPlaneModule
      const { createAnthropicLlm } = await import(GUI_LLM_MODULE).catch(() => fail(BUILD_HINT)) as GuiLlmModule
      // 模型线路（D7）：两个变量都不给时没有模型，命令里的模型动作按既有路径回 llm-unavailable
      const llm = guiEnv.llm === undefined ? null : createAnthropicLlm(guiEnv.llm)
      // GUI 平面自带上下文平面（写锁在里面建）：/mcp 的工具与 /api/gui 的界面共用同一张文件表与同一份设置
      const gui = await createGuiPlane({
        memoryRoot: config.root, project: guiEnv.project, llm,
        autoCheckup: guiEnv.autoCheckup, log: stderrLog,
      })
      // D8：自动体检要在后台花模型额度，是开是关必须留在启动日志里
      stderrLog.info(`自动体检调度器${guiEnv.autoCheckup ? '已开启（PLASTIC_AUTO_CHECKUP=1）' : '未开启（设 PLASTIC_AUTO_CHECKUP=1 才跑）'}`)
      await runServeCli(argv.slice(1), { gui, context: gui.context }, stderrLog)
      return
    }
    default:
      fail(`未知子命令：${command}（可用：stdio（缺省）、serve、hook-snapshot、import-zcode）`)
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
