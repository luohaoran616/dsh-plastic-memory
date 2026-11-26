import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { memoryRecordSchema } from '@plastic/core/record-schema.ts'
import type { RootLock } from '@plastic/core/root-lock.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import type { GuiPlanePort } from './gui-http.ts'
import {
  DEFAULT_PORT, DEFAULT_WEBUI_DIR, LOOPBACK_HOST, parseGuiEnv, parseServeArgs, startMemoryServer, type MemoryHttpServer,
} from './serve.ts'
import { createMemoryTools } from './tools.ts'
import { baseEnv, callJson } from './spec-helpers.ts'

/**
 * serve 模式的两处接线：`parseGuiEnv` 把 PLASTIC_* 环境变量收窄成项目与模型线路（D7、D8），
 * 服务用例证明 gui 平面接进 `/api/gui`、静态托管照常、关闭时平面被释放。
 *
 * 旧的 REST 管理面（记录读写）已删：这里覆盖的只剩 HTTP 模式本身——路由、鉴权、静态托管与 MCP 端点。
 */

const silentLog: MemoryLogger = { info() {}, warn() {}, error() {} }

/** 上下文平面（根包编译产物）：serve 用例的 /mcp 工具建在它上面。 */
type ContextPlaneModule = typeof import('dsh-plastic-memory/lib/standalone/context.js')
type ContextPlane = import('dsh-plastic-memory/lib/standalone/context.js').ContextPlane

async function startContext(root: string, client: string, lock?: RootLock): Promise<ContextPlane> {
  const { createContextPlane } = await import('dsh-plastic-memory/lib/standalone/context.js') as ContextPlaneModule
  return createContextPlane({
    memoryRoot: root, client, log: silentLog,
    ...(lock === undefined ? {} : { lock }),
  })
}

/** bin 的路径：serve 子命令的进程级用例用它起真子进程。 */
const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 完整的一组模型线路变量：本机代理的地址与便宜模型（spec D7 的缺省值）。 */
const FULL_ENV = {
  PLASTIC_PROJECT: '/projects/demo',
  PLASTIC_LLM_BASE_URL: 'http://127.0.0.1:3091/api/anthropic',
  PLASTIC_LLM_MODEL: 'GLM-5.3-Flash',
  PLASTIC_LLM_API_KEY: 'sk-test',
  PLASTIC_LLM_MAX_TOKENS: '2048',
}

function createFakePlane(): GuiPlanePort {
  return {
    memoryRoot: '/memories',
    run: vi.fn(async (_rawInput: string): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }> => (
      { kind: 'success', text: '完成' }
    )),
    readView: vi.fn(async (_name: string): Promise<{ status: 'ready'; text: string } | { status: 'missing' }> => (
      { status: 'missing' }
    )),
    readFile: vi.fn(async (_path: string): Promise<string | undefined> => undefined),
    openPath: vi.fn(async (_path: string, _action: 'open' | 'reveal'): Promise<boolean> => true),
    readSettings: vi.fn(async () => ({ status: 'ready', revision: 0, value: {}, writable: true }) as const),
    mutateSettings: vi.fn(async () => ({ ok: true, value: {}, revision: 1 }) as const),
    snapshot: vi.fn(async () => ({ status: 'ready', text: '', usedTokens: 0, injectedCount: 0 }) as const),
    dispose: vi.fn(async (): Promise<void> => {}),
  }
}

describe('parseGuiEnv（D7、D8）', () => {
  it('PLASTIC_PROJECT 必填且必须是绝对路径', () => {
    expect(() => parseGuiEnv({})).toThrow(/PLASTIC_PROJECT/)
    expect(() => parseGuiEnv({ PLASTIC_PROJECT: 'relative/project' })).toThrow(/PLASTIC_PROJECT/)
    expect(() => parseGuiEnv({ PLASTIC_PROJECT: '   ' })).toThrow(/PLASTIC_PROJECT/)
  })

  it('模型变量必须成对，MAX_TOKENS 必须是正整数', () => {
    // 只给地址或只给模型都拼不出线路：serve 模式启动即报错，不留半套配置
    expect(() => parseGuiEnv({ PLASTIC_PROJECT: '/p', PLASTIC_LLM_BASE_URL: 'http://127.0.0.1:3091' })).toThrow(/PLASTIC_LLM_BASE_URL/)
    expect(() => parseGuiEnv({ PLASTIC_PROJECT: '/p', PLASTIC_LLM_MODEL: 'GLM-5.3-Flash' })).toThrow(/PLASTIC_LLM_MODEL/)
    for (const value of ['0', '-1', '2.5', 'abc']) {
      expect(() => parseGuiEnv({
        PLASTIC_PROJECT: '/p', PLASTIC_LLM_BASE_URL: 'http://127.0.0.1:3091', PLASTIC_LLM_MODEL: 'm', PLASTIC_LLM_MAX_TOKENS: value,
      })).toThrow(/PLASTIC_LLM_MAX_TOKENS/)
    }
  })

  it('完整配置拼出项目与模型线路，apiKey 与 maxTokens 可选', () => {
    expect(parseGuiEnv(FULL_ENV)).toEqual({
      project: '/projects/demo',
      llm: { baseUrl: 'http://127.0.0.1:3091/api/anthropic', model: 'GLM-5.3-Flash', apiKey: 'sk-test', maxTokens: 2048 },
      autoCheckup: false,
    })
    // 两个模型变量都不给 = 没有模型；model-info 会回 llm-unavailable，不在这里报错
    expect(parseGuiEnv({ PLASTIC_PROJECT: '/projects/demo' })).toEqual({
      project: '/projects/demo', llm: undefined, autoCheckup: false,
    })
  })

  it('PLASTIC_AUTO_CHECKUP 只有等于 1 才是开', () => {
    expect(parseGuiEnv({ PLASTIC_PROJECT: '/projects/demo', PLASTIC_AUTO_CHECKUP: '1' }).autoCheckup).toBe(true)
    expect(parseGuiEnv({ PLASTIC_PROJECT: '/projects/demo', PLASTIC_AUTO_CHECKUP: '0' }).autoCheckup).toBe(false)
    expect(parseGuiEnv({ PLASTIC_PROJECT: '/projects/demo', PLASTIC_AUTO_CHECKUP: 'true' }).autoCheckup).toBe(false)
  })
})

describe('serve 接线（D4）', () => {
  it('带 gui 起服务：静态首页可读、命令接口通、关闭时释放平面', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-serve-'))
    const webuiDir = await mkdtemp(join(tmpdir(), 'pm-mcp-webui-'))
    const context = await startContext(root, 'serve-spec')
    const toolset = createMemoryTools(context)
    const plane = createFakePlane()
    let server: MemoryHttpServer | undefined
    try {
      await writeFile(join(webuiDir, 'index.html'), '<!doctype html><html><body>记忆页</body></html>')
      server = await startMemoryServer({ toolset, port: 0, webuiDir, gui: plane, log: silentLog })

      const index = await fetch(`${server.url}/`)
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('记忆页')

      const command = await fetch(`${server.url}/api/gui/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line: '/memory info' }),
      })
      expect(command.status).toBe(200)
      expect(await command.json()).toEqual({ kind: 'success', text: '完成' })

      await server.close()
      server = undefined
      expect(plane.dispose).toHaveBeenCalledTimes(1)
    } finally {
      if (server !== undefined) await server.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
      await rm(webuiDir, { recursive: true, force: true })
    }
  })

  it('旧的 REST 管理面已删：/api 下只剩界面接口，其余路径 404', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-serve-404-'))
    const context = await startContext(root, 'serve-spec')
    const toolset = createMemoryTools(context)
    const plane = createFakePlane()
    let server: MemoryHttpServer | undefined
    try {
      server = await startMemoryServer({ toolset, port: 0, gui: plane, log: silentLog })
      for (const path of ['/api/records', '/api/health', '/api/promotions']) {
        const response = await fetch(new URL(path, server.url))
        expect(response.status).toBe(404)
      }
      // 界面接口仍在
      const command = await fetch(`${server.url}/api/gui/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ line: '/memory info' }),
      })
      expect(command.status).toBe(200)
    } finally {
      if (server !== undefined) await server.close().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
})

interface HttpFixture {
  root: string
  server: MemoryHttpServer
  plane: GuiPlanePort
}

/** 起一个带假平面与真上下文平面的 HTTP 服务；用例自己关。 */
async function startHttp(options: { token?: string; webuiDir?: string } = {}): Promise<HttpFixture> {
  const root = await mkdtemp(join(tmpdir(), 'pm-mcp-http-'))
  const context = await startContext(root, 'http-spec')
  const toolset = createMemoryTools(context)
  const plane = createFakePlane()
  const server = await startMemoryServer({
    toolset, port: 0, gui: plane, log: silentLog,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.webuiDir === undefined ? {} : { webuiDir: options.webuiDir }),
  })
  return { root, server, plane }
}

/** 往界面接口发一条命令：假平面回 `{ kind: 'success', text: '完成' }`。 */
async function postCommand(server: MemoryHttpServer, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${server.url}/api/gui/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ line: '/memory info' }),
  })
}

describe('HTTP 模式（serve）', () => {
  it('只绑 127.0.0.1：监听地址不是 0.0.0.0 或通配地址', async () => {
    const http = await startHttp()
    try {
      const address = http.server.server.address()
      expect(address).not.toBeNull()
      expect(typeof address === 'string' ? address : address!.address).toBe('127.0.0.1')
      expect(address).not.toMatchObject({ address: '0.0.0.0' })
    } finally {
      await http.server.close()
      await rm(http.root, { recursive: true, force: true })
    }
  })

  it('token 启用后 /api 与 /mcp 要求 Authorization: Bearer；缺省关闭鉴权', async () => {
    const http = await startHttp({ token: 's3cret' })
    try {
      expect((await postCommand(http.server)).status).toBe(401)
      expect((await postCommand(http.server, { authorization: 'Bearer wrong' })).status).toBe(401)
      expect((await postCommand(http.server, { authorization: 'Basic s3cret' })).status).toBe(401)
      const ok = await postCommand(http.server, { authorization: 'Bearer s3cret' })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ kind: 'success', text: '完成' })

      // MCP 端点同一套鉴权
      expect((await fetch(`${http.server.url}/mcp`, { method: 'POST' })).status).toBe(401)
      expect((await fetch(`${http.server.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer s3cret' } })).status).not.toBe(401)
    } finally {
      await http.server.close()
      await rm(http.root, { recursive: true, force: true })
    }

    // 缺省没有 token：不带头也能访问
    const open = await startHttp()
    try {
      expect((await postCommand(open.server)).status).toBe(200)
    } finally {
      await open.server.close()
      await rm(open.root, { recursive: true, force: true })
    }
  })

  it('token 启用时静态产物放行、数据面仍 401（浏览器导航带不了 Authorization 头）', async () => {
    const webuiDir = await mkdtemp(join(tmpdir(), 'pm-mcp-webui-token-'))
    await mkdir(join(webuiDir, 'assets'), { recursive: true })
    await writeFile(join(webuiDir, 'index.html'), '<!doctype html><title>plastic-token</title>', 'utf8')
    await writeFile(join(webuiDir, 'assets', 'app.js'), 'console.log("token")', 'utf8')
    const http = await startHttp({ webuiDir, token: 's3cret' })
    try {
      // 静态文件不带 token 也放行：浏览器导航和 <script> 加不了请求头
      const index = await fetch(new URL('/', http.server.url))
      expect(index.status).toBe(200)
      expect(await index.text()).toContain('plastic-token')
      const asset = await fetch(new URL('/assets/app.js', http.server.url))
      expect(asset.status).toBe(200)
      expect(await asset.text()).toContain('console.log')

      // 同一个实例的数据面照旧校验：无 token 401，带对 token 200
      expect((await postCommand(http.server)).status).toBe(401)
      expect((await postCommand(http.server, { authorization: 'Bearer s3cret' })).status).toBe(200)
    } finally {
      await http.server.close()
      await rm(http.root, { recursive: true, force: true })
      await rm(webuiDir, { recursive: true, force: true })
    }
  })

  it('/mcp 用 Streamable HTTP 暴露同一组六工具，写入与界面共用同一个上下文平面', async () => {
    const http = await startHttp()
    const client = new Client({ name: 'http-spec', version: '0.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', http.server.url))
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map(tool => tool.name).sort()).toEqual([
        'memory_forget', 'memory_health', 'memory_read', 'memory_recall', 'memory_save', 'memory_search',
      ])
      const saved = await callJson<{ id: string }>(client, 'memory_save', {
        title: '经 HTTP MCP 保存', text: 'http-mcp-marker 正文', origin: 'user-stated', type: 'knowledge',
      })
      // 回读同一条：写入经的就是 serve 进程里那个上下文平面
      const read = await callJson<{ id: string; title: string; source: { sessionId: string } }>(client, 'memory_read', { id: saved.id })
      expect(read).toMatchObject({ id: saved.id, title: '经 HTTP MCP 保存', source: { sessionId: 'mcp:http-spec' } })
    } finally {
      await client.close()
      await http.server.close()
      await rm(http.root, { recursive: true, force: true })
    }
  })

  it('静态托管指向 packages/webui/dist：有产物时挂载并回 SPA 入口，目录不存在时其余端点照常', async () => {
    const base = await mkdtemp(join(tmpdir(), 'pm-mcp-webui-'))
    const webuiDir = join(base, 'dist')
    await mkdir(join(webuiDir, 'assets'), { recursive: true })
    await writeFile(join(webuiDir, 'index.html'), '<!doctype html><title>plastic</title>', 'utf8')
    await writeFile(join(webuiDir, 'assets', 'app.js'), 'console.log("plastic")', 'utf8')
    // 穿越目标必须是产物目录之外真实存在的文件：守卫失效时会读到它，这条用例才有区分力
    const sentinel = 'pm-mcp-traversal-sentinel-4a1c'
    await writeFile(join(base, 'secret.txt'), sentinel, 'utf8')
    const http = await startHttp({ webuiDir })
    try {
      const index = await fetch(new URL('/', http.server.url))
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      expect(await index.text()).toContain('plastic')

      const asset = await fetch(new URL('/assets/app.js', http.server.url))
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toContain('javascript')
      expect(await asset.text()).toContain('console.log')

      // 无扩展名的前端路由回 index.html；带扩展名的缺失文件是真 404
      const spa = await fetch(new URL('/memory/123', http.server.url))
      expect(await spa.text()).toContain('<!doctype html>')
      expect((await fetch(new URL('/missing.js', http.server.url))).status).toBe(404)
      // 编码过的 ../ 穿越：解码后落到产物目录之外的 secret.txt（存在且内容可辨认），
      // 守卫一删就会把哨兵内容吐出来——不是靠「目标本来就不存在」蒙过去的 404
      const escaped = await fetch(new URL('/%2e%2e%2fsecret.txt', http.server.url))
      expect(escaped.status).toBe(404)
      expect(await escaped.text()).not.toContain(sentinel)
    } finally {
      await http.server.close()
      await rm(http.root, { recursive: true, force: true })
      await rm(base, { recursive: true, force: true })
    }

    // 目录不存在时启动不报错、不挂静态，其余端点照常
    const missingDir = join(tmpdir(), `pm-mcp-no-webui-${Date.now()}`)
    const plain = await startHttp({ webuiDir: missingDir })
    try {
      expect((await fetch(new URL('/', plain.server.url))).status).toBe(404)
      expect((await postCommand(plain.server)).status).toBe(200)
    } finally {
      await plain.server.close()
      await rm(plain.root, { recursive: true, force: true })
    }
  })

  it('serve 的核心用注入的锁：与 GUI 平面共用同一把，同进程不抢锁', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-lock-'))
    const calls: number[] = []
    const stub: RootLock = { run: async <T>(fn: () => Promise<T>): Promise<T> => { calls.push(1); return fn() } }
    const context = await startContext(root, 'http-spec', stub)
    try {
      const stamp = Date.now()
      await context.store.create(memoryRecordSchema.parse({
        id: 'mem_lock_injected', name: '注入锁的条目', type: 'knowledge', scope: 'global', tags: [],
        content: '正文', summary: '正文',
        source: { sessionId: 'http-spec', eventRange: [0, 0], sourceMode: 'user-explicit' },
        createdAt: stamp, updatedAt: stamp, lastConfirmedAt: stamp, lastRecalledAt: null,
        recallCount: 0, status: 'active', confidence: 0.9,
      }))
      // 写走的是注入的锁：自建的锁库没有出现
      expect(calls.length).toBeGreaterThan(0)
      await expect(stat(join(root, '.state', 'lock', 'write-lock.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serve 参数解析：缺省 7788、可换端口与 token，非法值直接报错', () => {
    expect(parseServeArgs([])).toEqual({ port: DEFAULT_PORT })
    expect(DEFAULT_PORT).toBe(7788)
    expect(parseServeArgs(['--port', '0', '--token', 't'])).toEqual({ port: 0, token: 't' })
    expect(parseServeArgs(['--port', '9001'])).toEqual({ port: 9001 })
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow()
    expect(() => parseServeArgs(['--port', '70000'])).toThrow()
    expect(() => parseServeArgs(['--token'])).toThrow()
    expect(() => parseServeArgs(['--bogus'])).toThrow()
    expect(DEFAULT_WEBUI_DIR.endsWith(join('packages', 'webui', 'dist'))).toBe(true)
  })

  it('bin 的 serve 子命令按 PLASTIC_* 起 HTTP 模式，日志只走 stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pm-mcp-serve-bin-'))
    const child = spawn(process.execPath, [BIN, 'serve', '--port', '0', '--token', 'cli-secret'], {
      cwd: PACKAGE_ROOT,
      // serve 模式现在还必须给 PLASTIC_PROJECT（D7：独立页面的固定项目），项目目录不必存在
      env: { ...baseEnv, PLASTIC_MEMORY_ROOT: root, PLASTIC_CLIENT: 'zcode', PLASTIC_PROJECT: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    const exit = new Promise<number | null>(resolvePromise => child.once('exit', code => resolvePromise(code)))
    try {
      const port = await new Promise<number>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`serve 启动超时：${stderr}`)), 10_000)
        child.stderr!.setEncoding('utf8')
        child.stderr!.on('data', (chunk: string) => {
          stderr += chunk
          const matched = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)
          if (matched !== null) {
            clearTimeout(timer)
            resolvePromise(Number(matched[1]))
          }
        })
        child.once('exit', code => {
          clearTimeout(timer)
          reject(new Error(`serve 提前退出（code=${String(code)}）：${stderr}`))
        })
      })
      // 界面接口要鉴权：缺头 401，带对 token 才通
      const url = `http://127.0.0.1:${port}/api/gui/commands`
      const body = JSON.stringify({ line: '/memory info' })
      const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(unauthorized.status).toBe(401)
      const authorized = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer cli-secret' },
        body,
      })
      expect(authorized.status).toBe(200)
      expect(['success', 'error']).toContain((await authorized.json() as { kind: string }).kind)
      child.kill('SIGTERM')
      expect(await exit).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toContain('127.0.0.1')
      // D8：自动体检调度器是开是关必须留在启动日志里
      expect(stderr).toMatch(/自动体检调度器(已开启|未开启)/)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
