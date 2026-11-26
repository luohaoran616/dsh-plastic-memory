import { mkdir, readFile, stat } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname } from 'node:path'
import type { ZodType } from 'zod'
import type { MemoryLogger } from './table.ts'
import { atomicWrite, describeError, errnoCode } from './state-files.ts'

import { z } from 'zod'

/**
 * 设置文档（fork 增量，自包含）：记忆库的显式改动，叠在各端自己的出厂值上。
 * set 是显式写下的值（嵌套对象，按键合并），unset 是从出厂值里删掉的路径；revision 每次写入加一。
 */
export const settingsDocSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  set: z.record(z.string(), z.unknown()),
  unset: z.array(z.array(z.string())),
})
export type SettingsDoc = z.infer<typeof settingsDocSchema>

/** 设置文档的文件名（在 `<memoryRoot>/.state/` 下）。 */
export const SETTINGS_FILE = 'settings.json'

/** 带版本号的文档：设置文档的最小形状，版本号用来防写入冲突。 */
export interface VersionedDoc {
  revision: number
}

/**
 * 读出来的现状。corrupt：文件在，但读不出或不合形。调用方当没有它来运行，但别去覆盖它
 * （`mutate` 遇到 corrupt 一律回绝）。
 */
export type DocRead<T> =
  | { status: 'missing' }
  | { status: 'ready'; doc: T }
  | { status: 'corrupt'; detail: string }

export type DocMutateResult<T> =
  | { ok: true; doc: T | undefined }
  | { ok: false; reason: 'conflict' | 'corrupt'; current?: T }

export interface DocFileEnv {
  /** 进程内串行、轮到了再拿记忆根写锁（侧表的同款入口，见 sidecar.ts）。 */
  locked: <R>(fn: () => Promise<R>) => Promise<R>
  log: MemoryLogger
}

/** 文件签名：inode、mtime、size。rename 换文件必换 inode，别的进程写入后签名必变。读不到（不存在）为 undefined。 */
async function signatureOf(path: string): Promise<string | undefined> {
  try {
    const s = await stat(path)
    return `${s.ino}:${s.mtimeMs}:${s.size}`
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined
    throw err
  }
}

/**
 * 一个 JSON 文件一份的文档表（设置文档用）：读不加锁、按文件签名缓存解析结果；
 * 写在锁内读改写（读的是此刻的文件，不是缓存），tmp + rename 原子写。
 * 与 MapFileTable 的分工：那边是一张表一个文件（多条记录），这边整份文件就是一份文档。
 */
export class DocFileTable<T extends VersionedDoc> {
  private readonly path: string
  private readonly schema: ZodType<T>
  private readonly env: DocFileEnv
  private cache: { sig: string; raw: DocRead<T> } | undefined
  /** 报过「文件坏了」的签名：同一个坏文件只报一次。 */
  private warnedSig: string | undefined

  constructor(path: string, schema: ZodType<T>, env: DocFileEnv) {
    this.path = path
    this.schema = schema
    this.env = env
  }

  /** 此刻的文件（不读缓存）。stat 之后文件被换掉或删掉：按读不到的内容处理，交由下一次读重新判。 */
  private async load(): Promise<DocRead<T>> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return { status: 'missing' }
      return { status: 'corrupt', detail: describeError(err) }
    }
    try {
      return { status: 'ready', doc: this.schema.parse(JSON.parse(text)) }
    } catch (err) {
      return { status: 'corrupt', detail: describeError(err) }
    }
  }

  /** 读文档。文件签名没变就用上次读到的；坏文件报一次警后照常回 corrupt。 */
  async read(): Promise<DocRead<T>> {
    let sig: string | undefined
    try {
      sig = await signatureOf(this.path)
    } catch (err) {
      this.env.log.warn(`[plastic-memory] 设置文件不可读，按没有读：${this.path}（${describeError(err)}）`)
      return { status: 'missing' }
    }
    if (sig === undefined) {
      this.cache = undefined
      return { status: 'missing' }
    }
    if (this.cache?.sig === sig) return this.cache.raw
    const raw = await this.load()
    this.cache = { sig, raw }
    if (raw.status === 'corrupt' && this.warnedSig !== sig) {
      this.warnedSig = sig
      this.env.log.warn(`[plastic-memory] 设置文件读不出来，按出厂值运行、不覆盖它：${this.path}（${raw.detail}）`)
    }
    return raw
  }

  /**
   * 锁内读改写。版本号对不上（expectedRevision 给了，且不等于此刻文件的版本号；文件不存在按 0）回 conflict，
   * 文件读不出来回 corrupt，两种都不调 fn、不写。fn 返回 undefined 或与当前逐字相同：不写，回当前文档。
   * fn 抛错：原样抛出，什么都不写。
   */
  async mutate(
    fn: (current: T | undefined) => T | undefined,
    expectedRevision?: number,
  ): Promise<DocMutateResult<T>> {
    return this.env.locked(async () => {
      const raw = await this.load()
      if (raw.status === 'corrupt') return { ok: false, reason: 'corrupt' }
      const current = raw.status === 'ready' ? raw.doc : undefined
      if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
        return { ok: false, reason: 'conflict', ...(current === undefined ? {} : { current }) }
      }
      const next = fn(current)
      if (next === undefined || (current !== undefined && isDeepStrictEqual(current, next))) return { ok: true, doc: current }
      await mkdir(dirname(this.path), { recursive: true })
      await atomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`)
      this.cache = undefined
      return { ok: true, doc: next }
    })
  }
}
