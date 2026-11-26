import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleGuiRequest, type GuiPlanePort, type GuiSnapshotResult, type SettingsMutateResult, type SettingsPathOp, type SettingsSnapshot } from './gui-http.ts'

/**
 * GUI 接口的实证（D4、D6）：起真 node:http 服务、发真 fetch 请求，平面用假实现记录调用。
 * 重点覆盖两道写保护——带外 Origin 与 text/plain 的简单请求都不能穿过，读体上限、六个端点，
 * 以及设置（读回快照、提交映射 200/400/409）与快照（项目 400）的映射。
 */

/** 假平面：每个动作只记调用与返回，HTTP 层的用例不碰真存储。 */
function createFakePlane() {
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
    readSettings: vi.fn(async (): Promise<SettingsSnapshot> => (
      { status: 'ready', revision: 3, value: { template: 'coding' }, writable: true }
    )),
    mutateSettings: vi.fn(async (
      _ops: readonly SettingsPathOp[],
      _expectedRevision?: number,
    ): Promise<SettingsMutateResult> => (
      { ok: true, value: { template: 'office' }, revision: 4 }
    )),
    snapshot: vi.fn(async (_project?: string): Promise<GuiSnapshotResult> => (
      { status: 'ready', text: '# 长期记忆', usedTokens: 12, injectedCount: 2 }
    )),
    dispose: vi.fn(async (): Promise<void> => {}),
  } satisfies GuiPlanePort
}

interface Harness {
  /** 服务自己的来源，同时作为 allowedOrigin 传给 handleGuiRequest。 */
  url: string
  allowedOrigin: string
  server: Server
  close(): Promise<void>
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {})
})

async function startGui(plane: GuiPlanePort): Promise<Harness> {
  let allowedOrigin = ''
  const server = createServer((req, res) => {
    void handleGuiRequest(plane, req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), allowedOrigin)
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('内部错误')
        }
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  allowedOrigin = `http://127.0.0.1:${port}`
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    })
  }
  cleanups.push(close)
  return { url: allowedOrigin, allowedOrigin, server, close }
}

interface Sent {
  status: number
  text: string
  headers: Headers
}

async function send(gui: Harness, path: string, init?: RequestInit): Promise<Sent> {
  const response = await fetch(new URL(path, gui.url), init)
  return { status: response.status, text: await response.text(), headers: response.headers }
}

function postJson(gui: Harness, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Sent> {
  return send(gui, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** 错误体统一是 `{ error: { code, message } }`；断言只取稳定码，文案不进用例。 */
function errorCode(text: string): string {
  const body = JSON.parse(text) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

describe('GUI 的 HTTP 接口（D4、D6）', () => {
  it('命令行交给平面并原样回结果', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const sent = await postJson(gui, '/api/gui/commands', { line: '/memory info' })

    expect(sent.status).toBe(200)
    expect(JSON.parse(sent.text)).toEqual({ kind: 'success', text: '完成' })
    expect(plane.run).toHaveBeenCalledTimes(1)
    expect(plane.run).toHaveBeenCalledWith('/memory info')
  })

  it('命令行不合规回 400，平面不被调用', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const badLine = await postJson(gui, '/api/gui/commands', { line: 'info' })
    expect(badLine.status).toBe(400)
    expect(errorCode(badLine.text)).toBe('gui/bad-line')

    const notObject = await send(gui, '/api/gui/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]',
    })
    expect(notObject.status).toBe(400)
    expect(errorCode(notObject.text)).toBe('gui/bad-request')
    expect(plane.run).not.toHaveBeenCalled()
  })

  it('写接口拒绝非 JSON 与外来源', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const writes = [
      { path: '/api/gui/commands', body: { line: '/memory info' } },
      { path: '/api/gui/open', body: { path: '/memories/a.md', action: 'open' } },
    ]
    for (const write of writes) {
      // 跨站网页发不出带 JSON content-type 的简单请求（会先被 CORS 预检拦下），text/plain 这条必须服务端拒
      const wrongType = await send(gui, write.path, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(write.body),
      })
      expect(wrongType.status).toBe(415)
      expect(errorCode(wrongType.text)).toBe('gui/content-type')

      const foreignOrigin = await postJson(gui, write.path, write.body, { origin: 'https://evil.example' })
      expect(foreignOrigin.status).toBe(403)
      expect(errorCode(foreignOrigin.text)).toBe('gui/bad-origin')

      // 服务自己的来源放行：浏览器里同源页面的请求带的就是它
      const ownOrigin = await postJson(gui, write.path, write.body, { origin: gui.allowedOrigin })
      expect(ownOrigin.status).toBe(200)
    }
    expect(plane.run).toHaveBeenCalledTimes(1)
    expect(plane.openPath).toHaveBeenCalledTimes(1)
  })

  it('同端口的 localhost 是绑定地址的别名：同端口放行，别端口照拒', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)
    const port = new URL(gui.allowedOrigin).port

    // 用户用 http://localhost:<port> 打开本服务的页面时，浏览器给写请求带的就是这个来源
    const alias = await postJson(gui, '/api/gui/commands', { line: '/memory info' }, { origin: `http://localhost:${port}` })
    expect(alias.status).toBe(200)
    expect(JSON.parse(alias.text)).toEqual({ kind: 'success', text: '完成' })

    // 别名只认端口一致：别的端口是别的服务，照拒
    const otherPort = await postJson(gui, '/api/gui/commands', { line: '/memory info' }, { origin: `http://localhost:${Number(port) + 1}` })
    expect(otherPort.status).toBe(403)
    expect(errorCode(otherPort.text)).toBe('gui/bad-origin')
    expect(plane.run).toHaveBeenCalledTimes(1)
  })

  it('跨站写请求被拒：外来源加简单 content-type，沙箱页的 null 来源也不放行', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    // 别的网页用 fetch(no-cors) 或表单发来的请求就是这样：外来源 + 简单 content-type，两道门槛任一都够拒
    const simple = await send(gui, '/api/gui/commands', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.example' },
      body: JSON.stringify({ line: '/memory info' }),
    })
    expect([403, 415]).toContain(simple.status)
    expect(errorCode(simple.text)).not.toBe('')

    // 沙箱 iframe 与 file:// 页面的来源是 null：不是服务自己的来源，同样拒
    const nullOrigin = await postJson(gui, '/api/gui/commands', { line: '/memory info' }, { origin: 'null' })
    expect(nullOrigin.status).toBe(403)
    expect(errorCode(nullOrigin.text)).toBe('gui/bad-origin')
    expect(plane.run).not.toHaveBeenCalled()
  })

  it('请求体超限回 413，命令行超 64 KiB 也回 413', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const oversized = await send(gui, '/api/gui/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(256 * 1024 + 1),
    })
    expect(oversized.status).toBe(413)
    expect(errorCode(oversized.text)).toBe('gui/too-large')

    // 体没过读体上限，但这一行超过命令行自己的 64 KiB 上限
    const longLine = await postJson(gui, '/api/gui/commands', { line: `/memory info ${'x'.repeat(64 * 1024)}` })
    expect(longLine.status).toBe(413)
    expect(errorCode(longLine.text)).toBe('gui/too-large')
    expect(plane.run).not.toHaveBeenCalled()
  })

  it('视图按名字读：ready 回原文，missing 与未知名字回 404', async () => {
    const plane = createFakePlane()
    plane.readView.mockImplementation(async (name: string) => (
      name === 'pending'
        ? { status: 'ready' as const, text: '{"version":16}' }
        : { status: 'missing' as const }
    ))
    const gui = await startGui(plane)

    const ready = await send(gui, '/api/gui/views/pending')
    expect(ready.status).toBe(200)
    expect(ready.text).toBe('{"version":16}')
    expect(ready.headers.get('content-type')).toContain('application/json')

    const missing = await send(gui, '/api/gui/views/health')
    expect(missing.status).toBe(404)
    expect(errorCode(missing.text)).toBe('gui/view-missing')

    // 名字不认识时在读视图之前就回 404：平面只收到上面两次合法调用
    const unknown = await send(gui, '/api/gui/views/nope')
    expect(unknown.status).toBe(404)
    expect(errorCode(unknown.text)).toBe('gui/unknown-view')
    expect(plane.readView).toHaveBeenCalledTimes(2)
  })

  it('文件接口：读到回 200 {"text"}，读不到回 404', async () => {
    const plane = createFakePlane()
    plane.readFile.mockResolvedValueOnce('正文').mockResolvedValueOnce(undefined)
    const gui = await startGui(plane)

    const found = await send(gui, `/api/gui/file?path=${encodeURIComponent('/memories/a.md')}`)
    expect(found.status).toBe(200)
    expect(JSON.parse(found.text)).toEqual({ text: '正文' })
    expect(plane.readFile).toHaveBeenCalledWith('/memories/a.md')

    // 根外与读不到在平面里是同一个结果，HTTP 不区分
    const unavailable = await send(gui, `/api/gui/file?path=${encodeURIComponent('/etc/passwd')}`)
    expect(unavailable.status).toBe(404)
    expect(errorCode(unavailable.text)).toBe('gui/file-unavailable')
  })

  it('打开接口只认 open 与 reveal', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const badAction = await postJson(gui, '/api/gui/open', { path: '/memories/a.md', action: 'delete' })
    expect(badAction.status).toBe(400)
    expect(plane.openPath).not.toHaveBeenCalled()

    const revealed = await postJson(gui, '/api/gui/open', { path: '/memories/a.md', action: 'reveal' })
    expect(revealed.status).toBe(200)
    expect(JSON.parse(revealed.text)).toEqual({ ok: true })
    expect(plane.openPath).toHaveBeenCalledWith('/memories/a.md', 'reveal')
  })

  it('设置：GET 读回快照原样；POST 提交成功映射 200 ready', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const got = await send(gui, '/api/gui/settings')
    expect(got.status).toBe(200)
    expect(JSON.parse(got.text)).toEqual({ status: 'ready', revision: 3, value: { template: 'coding' }, writable: true })

    const done = await postJson(gui, '/api/gui/settings', { ops: [{ op: 'set', path: ['template'], value: 'office' }], expectedRevision: 3 })
    expect(done.status).toBe(200)
    expect(JSON.parse(done.text)).toEqual({ status: 'ready', revision: 4, value: { template: 'office' }, writable: true })
    expect(plane.mutateSettings).toHaveBeenCalledWith([{ op: 'set', path: ['template'], value: 'office' }], 3)

    // 不带 expectedRevision 也行
    await postJson(gui, '/api/gui/settings', { ops: [] })
    expect(plane.mutateSettings).toHaveBeenLastCalledWith([], undefined)
  })

  it('设置：提交的 400/409/415/403 各有对应码，unavailable 也是 409', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    // 请求体形状不对：平面不被调用
    const badOps = await postJson(gui, '/api/gui/settings', { ops: 'template' })
    expect(badOps.status).toBe(400)
    expect(errorCode(badOps.text)).toBe('settings/bad-request')
    const badPath = await postJson(gui, '/api/gui/settings', { ops: [{ op: 'set', path: [], value: 1 }] })
    expect(badPath.status).toBe(400)
    expect(errorCode(badPath.text)).toBe('settings/bad-request')
    const badRevision = await postJson(gui, '/api/gui/settings', { ops: [], expectedRevision: -1 })
    expect(badRevision.status).toBe(400)
    const wrongType = await send(gui, '/api/gui/settings', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })
    expect(wrongType.status).toBe(415)
    const foreign = await postJson(gui, '/api/gui/settings', { ops: [] }, { origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
    expect(plane.mutateSettings).not.toHaveBeenCalled()

    // 内容不合法 → 400 settings/invalid；版本冲突 → 409 settings/conflict；坏文件 → 409 settings/unavailable
    plane.mutateSettings.mockResolvedValueOnce({ ok: false, reason: 'invalid', issues: ['snapshotTokenBudget: 必须是正整数'] })
    const invalid = await postJson(gui, '/api/gui/settings', { ops: [] })
    expect(invalid.status).toBe(400)
    expect(errorCode(invalid.text)).toBe('settings/invalid')

    plane.mutateSettings.mockResolvedValueOnce({ ok: false, reason: 'conflict', current: { revision: 7, value: {} } })
    const conflict = await postJson(gui, '/api/gui/settings', { ops: [] })
    expect(conflict.status).toBe(409)
    expect(errorCode(conflict.text)).toBe('settings/conflict')
    expect(conflict.headers.get('x-plastic-settings-revision')).toBe('7')

    plane.mutateSettings.mockResolvedValueOnce({ ok: false, reason: 'unavailable', detail: '设置文件读不出来' })
    const unavailable = await postJson(gui, '/api/gui/settings', { ops: [] })
    expect(unavailable.status).toBe(409)
    expect(errorCode(unavailable.text)).toBe('settings/unavailable')
  })

  it('快照：ready 回 text 与用量；不存在的项目路径回 400', async () => {
    const plane = createFakePlane()
    const gui = await startGui(plane)

    const ok = await send(gui, '/api/gui/snapshot')
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.text)).toEqual({ text: '# 长期记忆', usedTokens: 12, injectedCount: 2 })
    expect(plane.snapshot).toHaveBeenLastCalledWith(undefined)

    await send(gui, `/api/gui/snapshot?project=${encodeURIComponent('/tmp/proj')}`)
    expect(plane.snapshot).toHaveBeenLastCalledWith('/tmp/proj')

    plane.snapshot.mockResolvedValueOnce({ status: 'bad-project', project: '/no/such' })
    const bad = await send(gui, `/api/gui/snapshot?project=${encodeURIComponent('/no/such')}`)
    expect(bad.status).toBe(400)
    expect(errorCode(bad.text)).toBe('snapshot/bad-project')
  })

  it('不归它管的路径返回 false，响应没被写', async () => {
    const plane = createFakePlane()
    let written = false
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead: () => { written = true; return res },
      end: () => { written = true; return res },
    } as unknown as ServerResponse

    const claimed = await handleGuiRequest(
      plane,
      { method: 'GET', url: '/api/records' } as IncomingMessage,
      res,
      new URL('http://127.0.0.1/api/records'),
      'http://127.0.0.1:7788',
    )

    expect(claimed).toBe(false)
    expect(written).toBe(false)
  })
})
