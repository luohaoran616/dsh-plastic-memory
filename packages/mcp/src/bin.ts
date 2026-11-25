#!/usr/bin/env node
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMemoryCore } from '@plastic/core/factory.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { createMemoryTools, registerMemoryTools, type MemoryTools } from './tools.ts'

/**
 * plastic-mcp 的进程入口：缺省 stdio 模式（ZCode、Antigravity 各起一个进程实例，与 DSH 插件同开一个记忆根）。
 * stdout 是 MCP 的 JSON-RPC 通道，所有日志一律走 stderr（core 的缺省 logger 是 console，会写 stdout，必须换掉）。
 * `serve` 子命令起 HTTP 模式（/mcp + /api + 静态 WebUI），入口在 serve.ts。
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

async function runStdio(): Promise<void> {
  const config = resolveConfig()
  const core = await createMemoryCore({ root: config.root, client: config.client, log: stderrLog })
  const tools = await withTestHoldLockIfRequested(createMemoryTools(core, {
    client: config.client,
    ...(config.project === undefined ? {} : { project: config.project }),
  }), config.root)

  const server = new McpServer({ name: 'plastic-memory', version: pkg.version })
  registerMemoryTools(server, tools)

  let closing = false
  const shutdown = (code: number): void => {
    if (closing) return
    closing = true
    void server.close()
      .catch(() => {})
      .finally(() => core.close().catch(() => {}))
      .finally(() => process.exit(code))
  }
  process.once('SIGINT', () => shutdown(0))
  process.once('SIGTERM', () => shutdown(0))
  // 客户端关掉 stdin（或 stdio 客户端 close）：协议通道结束，进程跟着退，不留后台句柄
  process.stdin.once('end', () => shutdown(0))

  await server.connect(new StdioServerTransport())
}

/**
 * 测试专用钩子的接线（concurrency.spec 的「持锁崩溃」用例）：只在 PLASTIC_MCP_TEST_HOLD_LOCK 存在时才动态加载
 * ./test-hold-lock.ts。正常启动路径不为这个测试装置背 fs/timers/root-lock 的 import。
 */
async function withTestHoldLockIfRequested(tools: MemoryTools, root: string): Promise<MemoryTools> {
  const dir = process.env.PLASTIC_MCP_TEST_HOLD_LOCK?.trim() ?? ''
  if (dir === '') return tools
  const { withTestHoldLock } = await import('./test-hold-lock.ts')
  return withTestHoldLock(tools, { root, dir, log: stderrLog })
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'stdio'
  switch (command) {
    case 'stdio':
      await runStdio()
      return
    case 'import-zcode': {
      // 动态加载：stdio 模式不为导入器背 fs 与读映射文件的依赖，两条路径互不影响
      const { runImportZcodeCli } = await import('./import-zcode.ts')
      await runImportZcodeCli(argv.slice(1), stderrLog)
      return
    }
    case 'serve': {
      const config = resolveConfig()
      // 动态加载：stdio 模式不为 HTTP / 静态托管背 node:fs 与 HTTP 路由的依赖
      const { runServeCli } = await import('./serve.ts')
      await runServeCli(argv.slice(1), config, stderrLog)
      return
    }
    default:
      fail(`未知子命令：${command}（可用：stdio（缺省）、serve、import-zcode）`)
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
