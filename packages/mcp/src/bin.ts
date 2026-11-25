#!/usr/bin/env node
import { access, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMemoryCore } from '@plastic/core/factory.ts'
import { createRootLock } from '@plastic/core/storage/root-lock.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import { createMemoryTools, registerMemoryTools, type MemoryTools } from './tools.ts'

/**
 * plastic-mcp 的进程入口：缺省 stdio 模式（ZCode、Antigravity 各起一个进程实例，与 DSH 插件同开一个记忆根）。
 * stdout 是 MCP 的 JSON-RPC 通道，所有日志一律走 stderr（core 的缺省 logger 是 console，会写 stdout，必须换掉）。
 * serve 子命令（HTTP + REST + 静态 WebUI）留到后续任务，这里只把子命令分派结构留出来。
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
  const tools = withTestHoldLock(createMemoryTools(core, {
    client: config.client,
    ...(config.project === undefined ? {} : { project: config.project }),
    log: stderrLog,
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
 * 测试专用钩子（concurrency.spec 的「持锁崩溃」用例）：设了 PLASTIC_MCP_TEST_HOLD_LOCK=<信号目录> 时，
 * memory_save 落盘成功后，在同一把记忆根写锁内写 `<目录>/held` 并等 `<目录>/go` 才返回。
 * 用例据此在「子进程确实握着 core 那把跨进程写锁」时 kill -9，不靠 sleep 竞态。生产不设这个变量，路径不可达。
 */
function withTestHoldLock(tools: MemoryTools, root: string): MemoryTools {
  const dir = process.env.PLASTIC_MCP_TEST_HOLD_LOCK?.trim() ?? ''
  if (dir === '') return tools
  return {
    ...tools,
    save: async (input) => {
      const result = await tools.save(input)
      const lock = createRootLock({ root, log: stderrLog })
      await lock.run(async () => {
        await writeFile(join(dir, 'held'), '')
        for (;;) {
          try {
            await access(join(dir, 'go'))
            return
          } catch {
            await delay(5)
          }
        }
      })
      return result
    },
  }
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'stdio'
  switch (command) {
    case 'stdio':
      await runStdio()
      return
    case 'serve':
      fail('serve 子命令还没实现（HTTP 模式在后续任务接入），本版本只有 stdio')
    default:
      fail(`未知子命令：${command}（可用：stdio（缺省）、serve）`)
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
