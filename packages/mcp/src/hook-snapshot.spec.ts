import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { hookSnapshot, parseHookInput, HOOK_EVENT_NAME } from './hook-snapshot.ts'

// SessionStart 快照 hook（D5）：起真 http 服务断言输出形状；不通、超时、空文本都静默；
// stdin 的 cwd 缺失时回退 PLASTIC_PROJECT；CLI 子进程手喂样例输入，退出码恒 0。

const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const children: Array<{ child: ReturnType<typeof spawn>; done: Promise<{ code: number | null; stdout: string; stderr: string }> }> = []

/** 起一个会话目录。 */
const makeProject = async (): Promise<string> => mkdtemp(join(tmpdir(), 'pm-hook-proj-'))

afterEach(async () => {
  for (const { child, done } of children.splice(0)) {
    child.kill('SIGTERM')
    await done.catch(() => {})
  }
  vi.restoreAllMocks()
})

/** 起一个应答固定体的 http 服务。 */
async function startSnapServer(respond: () => { status: number; body: unknown } | 'hang'): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chosen = respond()
    if (chosen === 'hang') return // 不应答：客户端只能超时
    res.writeHead(chosen.status, { 'content-type': 'application/json' })
    res.end(chosen.body === undefined ? '' : JSON.stringify(chosen.body))
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolvePromise() })
  })
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () => new Promise<void>((resolvePromise, reject) => { server.close(error => (error === undefined ? resolvePromise() : reject(error))) }),
  }
}

describe('hookSnapshot', () => {
  it('服务有快照：输出 { hookEventName, additionalContext }，项目取 cwd', async () => {
    const project = await makeProject()
    const snap = await startSnapServer(() => ({ status: 200, body: { text: '# 长期记忆\n- …', usedTokens: 12, injectedCount: 2 } }))
    try {
      const fetchMock = vi.fn(globalThis.fetch)
      const output = await hookSnapshot({ cwd: project }, { port: snap.port, fetchImpl: fetchMock as typeof fetch })
      expect(output).toEqual({ hookEventName: HOOK_EVENT_NAME, additionalContext: '# 长期记忆\n- …' })
      expect(fetchMock.mock.calls[0]![0]).toBe(`http://127.0.0.1:${snap.port}/api/gui/snapshot?project=${encodeURIComponent(project)}`)
    } finally {
      await snap.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('cwd 缺失回退 PLASTIC_PROJECT；两者都不是绝对路径就不发请求', async () => {
    const project = await makeProject()
    const snap = await startSnapServer(() => ({ status: 200, body: { text: '快照', usedTokens: 1, injectedCount: 0 } }))
    try {
      const fetchMock = vi.fn(globalThis.fetch)
      expect(await hookSnapshot({}, { port: snap.port, project, fetchImpl: fetchMock as typeof fetch })).not.toBeUndefined()
      expect(fetchMock.mock.calls[0]![0]).toContain(encodeURIComponent(project))
      // cwd 给了优先用 cwd
      await hookSnapshot({ cwd: project }, { port: snap.port, project: '/other', fetchImpl: fetchMock as typeof fetch })
      expect(fetchMock.mock.calls[1]![0]).toContain(encodeURIComponent(project))

      const noFetch = vi.fn(globalThis.fetch)
      expect(await hookSnapshot({}, { port: snap.port, fetchImpl: noFetch as typeof fetch })).toBeUndefined()
      expect(await hookSnapshot({ cwd: 'relative/path' }, { port: snap.port, fetchImpl: noFetch as typeof fetch })).toBeUndefined()
      expect(noFetch).not.toHaveBeenCalled()
    } finally {
      await snap.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('服务不通、超时、非 200、空文本：都静默（undefined）', async () => {
    // 连不上的端口：占用后立刻关掉
    const dead = await startSnapServer(() => ({ status: 200, body: { text: 'x' } }))
    const deadPort = dead.port
    await dead.close()
    const project = await makeProject()
    const hanging = await startSnapServer(() => 'hang')
    const empty = await startSnapServer(() => ({ status: 200, body: { text: '', usedTokens: 0, injectedCount: 0 } }))
    const bad = await startSnapServer(() => ({ status: 400, body: { error: { code: 'snapshot/bad-project' } } }))
    try {
      expect(await hookSnapshot({ cwd: project }, { port: deadPort, timeoutMs: 200 })).toBeUndefined()
      expect(await hookSnapshot({ cwd: project }, { port: hanging.port, timeoutMs: 200 })).toBeUndefined()
      expect(await hookSnapshot({ cwd: project }, { port: empty.port, timeoutMs: 1000 })).toBeUndefined()
      expect(await hookSnapshot({ cwd: project }, { port: bad.port, timeoutMs: 1000 })).toBeUndefined()
    } finally {
      await hanging.close()
      await empty.close()
      await bad.close()
      await rm(project, { recursive: true, force: true })
    }
  })
})

describe('parseHookInput', () => {
  it('收 cwd/session_id/hook_event_name；坏输入按空', () => {
    expect(parseHookInput('{"cwd":"/p","session_id":"s","hook_event_name":"SessionStart"}')).toEqual({ cwd: '/p', session_id: 's', hook_event_name: 'SessionStart' })
    expect(parseHookInput('{}')).toEqual({})
    expect(parseHookInput('not json')).toEqual({})
    expect(parseHookInput('[]')).toEqual({})
    expect(parseHookInput('{"cwd":42}')).toEqual({})
  })
})

describe('bin 的 hook-snapshot 子命令（进程级）', () => {
  const run = (input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BIN, 'hook-snapshot'], { cwd: PACKAGE_ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
      child.stdin.end(input)
      child.on('error', reject)
      const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveClose => {
        child.on('close', code => resolveClose({ code, stdout, stderr }))
      })
      children.push({ child, done })
      void done.then(resolvePromise)
    })

  it('有服务：stdout 输出一段合法 JSON（additionalContext 是快照原文）；退出码 0', async () => {
    const project = await makeProject()
    const snap = await startSnapServer(() => ({ status: 200, body: { text: '# 长期记忆（hook 样例）', usedTokens: 5, injectedCount: 1 } }))
    try {
      const result = await run(JSON.stringify({ cwd: project }), { PLASTIC_WEB_PORT: String(snap.port) })
      expect(result.code).toBe(0)
      const output = JSON.parse(result.stdout) as { hookEventName: string; additionalContext: string }
      expect(output).toEqual({ hookEventName: 'SessionStart', additionalContext: '# 长期记忆（hook 样例）' })
    } finally {
      await snap.close()
      await rm(project, { recursive: true, force: true })
    }
  })

  it('服务不通：无输出、退出码 0；输入是坏 JSON 也一样', async () => {
    const dead = await startSnapServer(() => ({ status: 200, body: { text: 'x' } }))
    const deadPort = dead.port
    await dead.close()
    const project = await makeProject()
    try {
      const down = await run(JSON.stringify({ cwd: project }), { PLASTIC_WEB_PORT: String(deadPort) })
      expect(down).toMatchObject({ code: 0, stdout: '' })
      const garbage = await run('not json', { PLASTIC_WEB_PORT: String(deadPort) })
      expect(garbage).toMatchObject({ code: 0, stdout: '' })
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })
})
