/**
 * 页面侧 HTTP 网关：独立页面与 `plastic-mcp serve` 的 GUI 平面（`/api/gui/*`）之间的唯一数据通道。
 *
 * 语义与宿主网关（client/gateway.ts 的 createHostGateway）同一套，差别只在数据怎么来：
 * - 命令：`POST /api/gui/commands`，体 `{"line":"/memory …"}`，回 `{kind, text}`（text 是命令结果的 JSON 原文）；
 * - 视图：`GET /api/gui/views/<name>`，回视图文件原文（404 是「还没生成」）；
 * - 文件：`GET /api/gui/file?path=`；打开：`POST /api/gui/open`。
 *
 * 独立装配只有一个会话（standalone）、没有配置面、没有归属对照：会话恒定就绪，配置恒缺省。
 * 视图还没生成或版本不认识时自动请服务端重写一次（`refresh-views`）再读，仍不认识就停在过时，不轮询。
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { encodeMemoryCommand, VIEW_BEHIND_CODES, type DeletedView, type LibraryView } from '@plastic/core/gui/contract.ts'
import { createDeletionStore } from 'dsh-plastic-memory/client/deletions.ts'
import { toPluginConfig } from 'dsh-plastic-memory/client/settings/config.ts'
import type { ConfigForm } from 'dsh-plastic-memory/client/host.ts'
import { createHttpConfigForm } from './config-form.http.ts'
import {
  decodeExecution, parseView,
  type BorrowedSession, type CurrentWorkspace, type MemoryGateway, type ModelState, type ViewMap, type ViewName, type ViewState,
} from 'dsh-plastic-memory/client/gateway.ts'
import type { CommandExecution, RemoteResult } from 'dsh-plastic-memory/client/host.ts'

/** GUI 平面的地址前缀：与 packages/mcp/src/gui-http.ts 里的四个端点同一前缀。 */
export const GUI_API = '/api/gui'

export interface HttpGatewayOptions {
  /** 缺省用全局 fetch；测试注入假 fetch。 */
  fetch?: typeof fetch
  /** 设置表单：缺省自建一个 HTTP 的；测试注入假的（与设置视图共用同一份时从外面给）。 */
  form?: ConfigForm
}

/** 独立装配的会话 id：没有真会话，命令与视图都走这一个。 */
const SESSION_ID = 'standalone'

/** 回到前台后距上次刷新满这么多毫秒才再刷新一次（免得切来切去把服务端刷爆）。 */
const VISIBILITY_REFRESH_MS = 5000

/** 能由 refresh-views 重写的视图：四个全局视图与体检视图（会话视图、归属对照不在其中）。 */
const REGENERABLE: ReadonlySet<ViewName> = new Set(['pending', 'health', 'library', 'deleted', 'checkups'])

/** 还没读到内容时的视图状态：恒定同一个对象，订阅者不会因为它多渲染一次。 */
const LOADING: ViewState<unknown> = Object.freeze({ status: 'loading' })

/** 独立装配只有一个会话：借到的永远是它。 */
const STANDALONE_SESSION: BorrowedSession = Object.freeze({ kind: 'ready', sessionId: SESSION_ID, cwd: undefined })

/** 没有归属对照：当前工作区恒定就绪且没有项目。 */
const STANDALONE_WORKSPACE: CurrentWorkspace = Object.freeze({ status: 'ready', workspacePath: undefined })

/** 还没问到模型时的状态：恒定同一个对象。 */
const MODEL_UNKNOWN: ModelState = Object.freeze({ status: 'unknown' })

/**
 * 服务端回的命令结果 → decodeExecution 认的执行结果。
 * 正常形状是 `{kind, text}`（text 是命令结果的 JSON 原文）；也认直接回命令结果对象的样子。
 */
function toCommandResult(payload: unknown): CommandExecution['result'] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as { kind?: unknown; text?: unknown; ok?: unknown }
  if (record.kind === 'success') return typeof record.text === 'string' ? { kind: 'success', text: record.text } : { kind: 'success' }
  if (record.kind === 'error') return typeof record.text === 'string' ? { kind: 'error', text: record.text } : undefined
  if (typeof record.ok === 'boolean') return { kind: record.ok ? 'success' : 'error', text: JSON.stringify(payload) }
  return undefined
}

/** 页面侧 HTTP 网关：按 MemoryGateway 的形状包住 `/api/gui/*`，独立页面用它读视图、发命令、管删除状态。 */
export function createHttpGateway(options: HttpGatewayOptions = {}): MemoryGateway {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  // 设置单源：useConfig、setConfig 与设置视图（App 注入同一个 form）读改的都是它
  const configForm = options.form ?? createHttpConfigForm(options.fetch === undefined ? {} : { fetch: options.fetch })

  /** 一次请求：网络错误与 HTTP 错误都折成失败，不抛。status 为 0 表示没到服务端。 */
  async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; text: string }> {
    let response: Response
    try {
      response = await doFetch(`${GUI_API}${path}`, {
        method: init.method ?? 'GET',
        headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        cache: 'no-store',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (error) {
      return { ok: false, status: 0, text: error instanceof Error ? error.message : String(error) }
    }
    return { ok: response.ok, status: response.status, text: await response.text().catch(() => '') }
  }

  /** 跑一条 `/memory` 命令行：结果按 decodeExecution 认的形状交回去。 */
  async function runCommand(line: string): Promise<RemoteResult<CommandExecution | undefined>> {
    const response = await request('/commands', { method: 'POST', body: { line } })
    if (!response.ok) {
      const message = response.status === 0 ? `连不上记忆服务：${response.text}` : `命令请求失败（HTTP ${response.status}）`
      return { ok: false, error: { code: 'http', message } }
    }
    let payload: unknown
    try { payload = JSON.parse(response.text) } catch { return { ok: false, error: { code: 'http', message: '服务端返回的不是 JSON' } } }
    const result = toCommandResult(payload)
    if (result === undefined) return { ok: false, error: { code: 'bad-response', message: '命令结果的形状不认识' } }
    return { ok: true, value: { commandId: '', result } }
  }

  const deletions = createDeletionStore()

  // —— 视图状态 ——

  const viewStates = new Map<ViewName, ViewState<unknown>>()
  const viewListeners = new Set<() => void>()
  /** 重读触发号：命令成功（或界面落后于磁盘的失败）与视图刷新各加一次，挂在页面上的视图都重读。 */
  let trigger = 0
  const bumpTrigger = () => { trigger++; for (const fn of viewListeners) fn() }
  const getTrigger = () => trigger
  const getView = (name: ViewName): ViewState<unknown> => viewStates.get(name) ?? LOADING
  const publishView = (name: ViewName, state: ViewState<unknown>) => {
    viewStates.set(name, state)
    for (const fn of viewListeners) fn()
  }
  const subscribeViews = (fn: () => void) => { viewListeners.add(fn); return () => { viewListeners.delete(fn) } }

  /** 在途的刷新：同一时间只发一条，后来的等前一条。 */
  let refreshPromise: Promise<boolean> | undefined
  /** 本页已经成功刷新过：视图还缺或版本不认识时不再重复发（与宿主网关同一口径）。 */
  let refreshed = false
  /** 上次发刷新命令的时刻：回到前台时据此判断满没满五秒。 */
  let lastRefreshAt = 0

  /** 发一次 refresh-views：成功时重读触发号加一，挂在页面上的视图都重读。 */
  function refreshViews(): Promise<boolean> {
    if (refreshPromise !== undefined) return refreshPromise
    lastRefreshAt = Date.now()
    refreshPromise = (async () => {
      const result = decodeExecution('refresh-views', await runCommand(encodeMemoryCommand({ cmd: 'refresh-views' })))
      if (!result.ok) return false
      refreshed = true
      bumpTrigger()
      return true
    })().finally(() => { refreshPromise = undefined })
    return refreshPromise
  }

  /** 视图还没生成或版本不认识时确保服务端重写一次：在途的等它，本页刷新过的就不再发。 */
  function ensureRefreshed(): Promise<boolean> {
    if (refreshPromise !== undefined) return refreshPromise
    if (refreshed) return Promise.resolve(false)
    return refreshViews()
  }

  /** 读一个视图文件：404 是「还没生成」，别的错是读不到。 */
  async function readViewText(name: ViewName): Promise<{ status: 'ready'; text: string } | { status: 'missing' } | { status: 'error'; message: string }> {
    const response = await request(`/views/${name}`)
    if (response.status === 404) return { status: 'missing' }
    if (!response.ok) return { status: 'error', message: response.status === 0 ? `连不上记忆服务：${response.text}` : `读视图失败（HTTP ${response.status}）` }
    return { status: 'ready', text: response.text }
  }

  /**
   * 读一个视图并发布状态：还没生成或版本不认识时先请服务端重写一次再读，仍不认识就停在过时（不轮询）。
   * 重写成功时重读触发号加一，视图跟着重读；这里先不发状态，页面停在读取中而不是空白。
   */
  async function loadView(name: ViewName, at: number): Promise<void> {
    /** 触发号已经变了（期间有命令成功或视图被刷新）：这次读到的内容过期了，不发布。 */
    const publish = (state: ViewState<unknown>) => { if (at === trigger) publishView(name, state) }
    const response = await readViewText(name)
    if (response.status === 'error') { publish({ status: 'error', message: response.message }); return }
    if (response.status === 'missing') {
      if (!REGENERABLE.has(name)) { publish({ status: 'missing' }); return }
      if (!(await ensureRefreshed())) publish({ status: 'missing' })
      return
    }
    const parsed: ViewState<unknown> = parseView(name, response.text)
    if (parsed.status === 'outdated' && REGENERABLE.has(name)) {
      if (!(await ensureRefreshed())) publish({ status: 'outdated' })
      return
    }
    if (parsed.status === 'ready') {
      if (name === 'deleted') deletions.settle({ name, data: parsed.data as DeletedView })
      if (name === 'library') deletions.settle({ name, data: parsed.data as LibraryView })
    }
    publish(parsed)
  }

  /** 同一视图、同一次触发只读一次：几处同时挂着同一视图时共用结果。 */
  const loading = new Map<string, Promise<void>>()
  function loadViewOnce(name: ViewName, at: number): Promise<void> {
    const key = `${name}#${at}`
    const existing = loading.get(key)
    if (existing !== undefined) return existing
    const promise = loadView(name, at).finally(() => { loading.delete(key) })
    loading.set(key, promise)
    return promise
  }

  // —— 模型状态 ——

  const modelStates = new Map<string, ModelState>()
  const modelListeners = new Set<() => void>()
  const getModel = (sessionId: string | undefined): ModelState =>
    sessionId === undefined ? MODEL_UNKNOWN : (modelStates.get(sessionId) ?? MODEL_UNKNOWN)
  const subscribeModels = (fn: () => void) => { modelListeners.add(fn); return () => { modelListeners.delete(fn) } }

  /** 各会话的模型：第一次用到时问一次 model-info，几处同时用只发一条。 */
  function probeModel(sessionId: string): void {
    if (modelStates.has(sessionId)) return
    modelStates.set(sessionId, MODEL_UNKNOWN)
    void runCommand(encodeMemoryCommand({ cmd: 'model-info' })).then((response) => {
      const result = decodeExecution('model-info', response)
      // 别的失败（服务端出错、旧插件不认这条命令）不当成拿不到模型：真拿不到时生成会写原因
      modelStates.set(sessionId, result.ok ? { status: 'ready', model: result.model }
        : result.code === 'llm-unavailable' ? { status: 'unavailable' } : { status: 'ready', model: undefined })
      for (const fn of modelListeners) fn()
    })
  }

  /** 独立装配只有一个会话，命令发给它就行；参数留着是为了对上 MemoryGateway 的形状。 */
  const execute: MemoryGateway['execute'] = async (_sessionId, command) => {
    const result = decodeExecution(command.cmd, await runCommand(encodeMemoryCommand(command)))
    deletions.record(command, result)
    // 界面落后于磁盘的失败也算：服务端同样重写了视图，挂在页面上的视图要重读
    if (result.ok || VIEW_BEHIND_CODES.has(result.code)) bumpTrigger()
    return result
  }

  return {
    execute,

    useSession() {
      return STANDALONE_SESSION
    },

    useCurrentWorkspace() {
      return STANDALONE_WORKSPACE
    },

    useView<N extends ViewName>(session: BorrowedSession, name: N) {
      const at = useSyncExternalStore(subscribeViews, getTrigger)
      const state = useSyncExternalStore(subscribeViews, () => getView(name))
      useEffect(() => { void loadViewOnce(name, at) }, [name, at])
      return state as ViewState<ViewMap[N]>
    },

    useFreshViews(session: BorrowedSession) {
      const requested = useRef(false)
      // 页面打开时按磁盘现状重写一次视图：同一次打开只发一次
      useEffect(() => {
        if (requested.current) return
        requested.current = true
        void refreshViews()
      }, [])
      // 回到前台：距上次刷新满五秒才再刷新一次
      useEffect(() => {
        const onVisibility = () => {
          if (document.visibilityState !== 'visible') return
          if (Date.now() - lastRefreshAt < VISIBILITY_REFRESH_MS) return
          void refreshViews()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => { document.removeEventListener('visibilitychange', onVisibility) }
      }, [])
    },

    useDeletions() {
      return useSyncExternalStore(deletions.subscribe, deletions.get)
    },

    useModel(session: BorrowedSession, options) {
      const sessionId = session.kind === 'ready' ? session.sessionId : undefined
      const shouldAsk = options?.shouldAsk !== false
      const state = useSyncExternalStore(subscribeModels, () => getModel(sessionId))
      useEffect(() => { if (sessionId !== undefined && shouldAsk) probeModel(sessionId) }, [sessionId, shouldAsk])
      return state
    },

    useConfig() {
      const snapshot = useSyncExternalStore(configForm.subscribe, configForm.getSnapshot)
      return useMemo(() => snapshot.status === 'ready' ? toPluginConfig(snapshot.value) : undefined, [snapshot])
    },

    async setConfig(field, value) {
      try {
        return await configForm.set(field, value)
      } catch {
        return false
      }
    },

    async readFile(_sessionId, path) {
      const response = await request(`/file?path=${encodeURIComponent(path)}`)
      if (!response.ok) return undefined
      try {
        const payload = JSON.parse(response.text) as { text?: unknown }
        return typeof payload.text === 'string' ? payload.text : undefined
      } catch { return undefined }
    },

    async openPath(path, action) {
      const response = await request('/open', { method: 'POST', body: { path, action: action ?? 'open' } })
      if (!response.ok) return false
      try {
        const payload = JSON.parse(response.text) as { ok?: unknown }
        return payload.ok === true
      } catch { return false }
    },
  }
}
