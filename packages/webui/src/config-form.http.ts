/**
 * 走 HTTP 的 ConfigForm：ui-settings ConfigForm 接口的最小实现，数据源是 `/api/gui/settings`。
 * 读：GET，ready 与 unavailable 都回 200、按 body.status 分支，请求失败也按 unavailable（页面显示不可用）。
 * 写：POST `{ops, expectedRevision}`；200 接受，400/409 被拒——两种都先重读最新值再回 false（与宿主「拒绝时已重读」的契约一致），
 * 传输失败原样抛（ConfigForm 契约：reject 表示传输失败）。
 * 回到前台重读一次：MCP、DSH 插件改了设置，切回页面就能看到。
 */
import type { ConfigForm, ConfigFormSnapshot, ConfigPathOp } from 'dsh-plastic-memory/client/host.ts'

export interface HttpConfigFormOptions {
  /** 缺省用全局 fetch；测试注入假 fetch。 */
  fetch?: typeof fetch
}

const LOADING: ConfigFormSnapshot = { status: 'loading', value: undefined, revision: undefined, writable: false }

export function createHttpConfigForm(options: HttpConfigFormOptions = {}): ConfigForm {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  let snapshot: ConfigFormSnapshot = LOADING
  const listeners = new Set<() => void>()
  const publish = (next: ConfigFormSnapshot) => {
    snapshot = next
    for (const fn of listeners) fn()
  }

  /** GET 一次并发布。非 200、响应不认识、网络失败都按 unavailable（不去覆盖一个读不出的状态）。 */
  async function read(): Promise<void> {
    let body: unknown
    try {
      const response = await doFetch('/api/gui/settings', { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) {
        publish({ status: 'unavailable', value: undefined, revision: undefined, writable: false })
        return
      }
      body = await response.json()
    } catch {
      publish({ status: 'unavailable', value: undefined, revision: undefined, writable: false })
      return
    }
    if (typeof body !== 'object' || body === null) {
      publish({ status: 'unavailable', value: undefined, revision: undefined, writable: false })
      return
    }
    const record = body as Record<string, unknown>
    if (record.status === 'ready') {
      publish({ status: 'ready', value: record.value, revision: typeof record.revision === 'number' ? record.revision : undefined, writable: record.writable === true })
      return
    }
    publish({ status: 'unavailable', value: undefined, revision: undefined, writable: false })
  }

  /** 回到前台重读：标签页切回来时发布一次最新值。 */
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void read()
    })
  }

  void read()

  /** POST 一批操作；接受与否都重读：宿主契约是「拒绝时宿主已重读最新值」，接受时新值也顺带进来。传输失败原样抛。 */
  async function mutate(ops: readonly ConfigPathOp[], expectedRevision?: number): Promise<boolean> {
    const response = await doFetch('/api/gui/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
    })
    await read()
    return response.ok
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async set(field, value) {
      // 点路径按 ui-settings 的 field 写法（点分段）拆开
      return mutate([{ op: 'set', path: field.split('.'), value }])
    },
    mutate,
  }
}
