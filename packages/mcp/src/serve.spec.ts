import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryCore } from '@plastic/core/factory.ts'
import type { MemoryLogger } from '@plastic/core/storage/table.ts'
import type { GuiPlanePort } from './gui-http.ts'
import { parseGuiEnv, startMemoryServer, type MemoryHttpServer } from './serve.ts'
import { createMemoryTools } from './tools.ts'

/**
 * serve 模式的两处接线：`parseGuiEnv` 把 PLASTIC_* 环境变量收窄成项目与模型线路（D7、D8），
 * 服务用例证明 gui 平面接进 `/api/gui`、静态托管照常、关闭时平面被释放。
 */

const silentLog: MemoryLogger = { info() {}, warn() {}, error() {} }

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
    const core = await createMemoryCore({ root, client: 'serve-spec', log: silentLog })
    const tools = createMemoryTools(core, { client: 'serve-spec', project: process.cwd() })
    const plane = createFakePlane()
    let server: MemoryHttpServer | undefined
    try {
      await writeFile(join(webuiDir, 'index.html'), '<!doctype html><html><body>记忆页</body></html>')
      server = await startMemoryServer({ core, tools, port: 0, webuiDir, gui: plane, log: silentLog })

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
      await core.close()
      await rm(root, { recursive: true, force: true })
      await rm(webuiDir, { recursive: true, force: true })
    }
  })
})
