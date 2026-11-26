/**
 * 来源锚的客户端侧（设计说明 2026-11-26-source-anchor §A1/§A2/§A3）：
 * scheme 编解码、会话 id 形状校验、公共上限与定位调度。
 * 定位 = 拿 memory_save 收到的入参去各客户端自己的会话存储里找「刚刚发出这一次调用」的记录，
 * 机械地精确对上，不猜；对不上（返回 undefined）就不锚，写入照旧落 mcp:<client>。
 */
import { existsSync } from 'node:fs'
import { createZcodeAnchorAdapter } from './anchor-zcode.ts'

/** 与 source.ts 的 WINDOW_CAP 同值（tests/anchor.spec.ts 守相等）：锚开窗与 DSH 回查同一暴露面。 */
export const ANCHOR_WINDOW_CAP = 24
/** 与 source.ts 的 TEXT_CAP 同值：每行可读文本的截断长度。 */
export const ANCHOR_TEXT_CAP = 400

export type AnchorScheme = 'dsh' | 'zcode' | 'antigravity' | 'mcp'

/** 锚的 scheme 前缀：无前缀 = DSH 原生会话；`mcp:` = 独立端写入时没定位到（通道标识，现状）。 */
export function schemeOf(sessionId: string): AnchorScheme {
  if (sessionId.startsWith('zcode:')) return 'zcode'
  if (sessionId.startsWith('antigravity:')) return 'antigravity'
  if (sessionId.startsWith('mcp:')) return 'mcp'
  return 'dsh'
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ZCODE_ID = new RegExp(`^(?:sess|session)_${UUID}$`)
const ANTIGRAVITY_ID = new RegExp(`^${UUID}$`)

/** ZCode 会话 id：`sess_<uuid>`（2026-11-26 实测 259 个会话全为此形；旧版 `session_` 一并认）。 */
export function isZcodeSessionId(id: string): boolean {
  return ZCODE_ID.test(id)
}

/** Antigravity 会话 id：裸 uuid（brain/<uuid>/ 目录名）。 */
export function isAntigravitySessionId(id: string): boolean {
  return ANTIGRAVITY_ID.test(id)
}

/** 锚：sessionId 带客户端前缀，eventRange 是该端自己的序号（[当轮起点, 保存时刻]）。 */
export interface SourceAnchor {
  sessionId: string
  eventRange: [number, number]
}

/** 开窗读出的一行可读证据：与 DSH 的 `- [seq] role: text` 渲染一一对应。 */
export interface AnchorEvent {
  seq: number
  role: string
  text: string
}

export interface AnchorWindow {
  events: AnchorEvent[]
  /** 窗口内没有可读文本的结构事件数（reasoning、步进标记等），与 DSH 的 skipped 同义。 */
  skipped: number
  range: [number, number]
}

/** 每个客户端一个：定位（写入侧用）与开窗读（回查侧用）放在同一个只读适配器里。 */
export interface AnchorAdapter {
  readonly scheme: 'zcode' | 'antigravity'
  /** 找「刚刚发出这次调用」的会话；找不到回 undefined，读不了（库缺、结构变了）抛错，由调度器按探针失败降级。 */
  locateCall(args: { title: string, text: string }, now: number): Promise<SourceAnchor | undefined>
  /** 按锚开窗；语义与 DSH 的 sourceWindow 对齐（起点前多读 2，封顶 ANCHOR_WINDOW_CAP 行）。 */
  readWindow(anchor: SourceAnchor, window?: number): Promise<AnchorWindow>
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface AnchorLocatorOptions {
  /** false = 整个定位关掉（PLASTIC_ANCHOR=off），写入维持现状 */
  enabled?: boolean
  /** ZCode 客户端根目录（缺省 ~/.zcode/cli）；目录不存在则不启用该适配器（零 I/O） */
  zcodeDir?: string
  /** Antigravity 客户端根目录（缺省 ~/.gemini/antigravity）；适配器在 Task 2 登记后启用 */
  antigravityDir?: string
  /** 直接注入适配器（测试与 anchor-doctor 用）；给了就不再按目录自建 */
  adapters?: readonly AnchorAdapter[]
  /** 首次没找到后的补试间隔（防转写还没刷盘） */
  retryDelaysMs?: readonly number[]
  /** 定位总时长的时间盒 */
  timeBudgetMs?: number
  log?: (line: string) => void
}

export interface AnchorLocator {
  readonly adapters: readonly AnchorAdapter[]
  locate(args: { title: string, text: string }): Promise<SourceAnchor | undefined>
  /** 回查侧按 scheme 取适配器；没登记的 scheme（dsh、mcp）回 undefined。 */
  reader(scheme: AnchorScheme): AnchorAdapter | undefined
}

const stderrLine = (line: string): void => { process.stderr.write(`${line}\n`) }

export function createAnchorLocator(options: AnchorLocatorOptions = {}): AnchorLocator {
  const enabled = options.enabled ?? true
  const log = options.log ?? stderrLine
  const delays = options.retryDelaysMs ?? [100, 250]
  const budget = options.timeBudgetMs ?? 500
  const adapters = options.adapters ?? buildAdapters(options)
  const warned = new Set<string>()
  return {
    adapters,
    // 时间盒与补试（spec §A2）：总计至多 budget，首次没找到时在 delays 各补一次；任何一步出错都算没找到。
    async locate(args) {
      if (!enabled || adapters.length === 0) return undefined
      const deadline = Date.now() + budget
      const failures = new Map<string, string>()
      for (let attempt = 0; ; attempt++) {
        for (const adapter of adapters) {
          try {
            const anchor = await adapter.locateCall(args, Date.now())
            if (anchor !== undefined) {
              log(`锚定 ${anchor.sessionId} [${anchor.eventRange[0]}, ${anchor.eventRange[1]}]`)
              return anchor
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            failures.set(adapter.scheme, `${adapter.scheme}: ${message}`)
            // 探针失败（库不在、表结构变了）每个进程每适配器只警告一次，后续按普通「没找到」处理
            if (!warned.has(adapter.scheme)) {
              warned.add(adapter.scheme)
              log(`锚定探针失败（${adapter.scheme}，本进程只警告一次）：${message}`)
            }
          }
        }
        const wait = delays[attempt]
        if (wait === undefined || Date.now() + wait >= deadline) break
        await sleep(wait)
        if (Date.now() >= deadline) break
      }
      log(`未定位：${failures.size > 0 ? [...failures.values()].join('；') : '近十分钟的会话里没有参数全等的 memory_save 调用'}`)
      return undefined
    },
    reader(scheme) {
      return adapters.find(a => a.scheme === scheme)
    },
  }
}

/** 按目录自建适配器；根目录不存在的不启用（零 I/O）。 */
function buildAdapters(options: AnchorLocatorOptions): AnchorAdapter[] {
  const adapters: AnchorAdapter[] = []
  if (options.zcodeDir !== undefined && existsSync(options.zcodeDir)) {
    adapters.push(createZcodeAnchorAdapter({ zcodeDir: options.zcodeDir }))
  }
  return adapters
}
