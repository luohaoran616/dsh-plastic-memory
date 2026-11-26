/**
 * anchor-doctor（设计说明 2026-11-26-source-anchor §A6）：对本机两个客户端的会话存储各跑一遍只读探针，
 * JSON 报告打到 stdout——根目录在不在、适配器启用与否、库结构认不认得、ZCode 在线的会话数、
 * Antigravity 近期的转写数。不读任何对话内容。私有格式，客户端升级后先跑它：
 * 探针红 = 该端这一版锚不上（写入退回 mcp:<client>、回查回 unavailable），其余功能不受影响。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createZcodeAnchorAdapter, zcodeDbPath } from '../tools/anchor-zcode.ts'
import { anchorOptionsFromEnv } from './anchor-env.ts'

export interface AnchorDoctorReport {
  enabled: boolean
  note?: string
  zcode?: {
    root: string
    dbPath: string
    dbExists: boolean
    structureOk: boolean
    onlineSessions: number
    error?: string
  }
  antigravity?: {
    root: string
    brainPath: string
    brainExists: boolean
    transcripts: number
    note?: string
    error?: string
  }
}

/** 跑一遍两端探针。env 可注入（CLI 缺省 process.env）；任何一步失败都进报告的 error，不抛。 */
export async function anchorDoctorReport(env: NodeJS.ProcessEnv = process.env): Promise<AnchorDoctorReport> {
  const options = anchorOptionsFromEnv(env)
  if (options.enabled === false) {
    return { enabled: false, note: 'PLASTIC_ANCHOR=off：来源锚定位已关闭，写入维持 mcp:<client>；回查不受影响' }
  }
  const report: AnchorDoctorReport = { enabled: true }

  const zcodeDir = options.zcodeDir
  if (zcodeDir === undefined || !existsSync(zcodeDir)) {
    report.zcode = { root: zcodeDir ?? '', dbPath: '', dbExists: false, structureOk: false, onlineSessions: 0, error: '根目录不存在，适配器未启用' }
  } else {
    const probe = await createZcodeAnchorAdapter({ zcodeDir }).probe()
    report.zcode = { root: zcodeDir, dbPath: zcodeDbPath(zcodeDir), ...probe }
  }

  const antigravityDir = options.antigravityDir
  const brainPath = antigravityDir === undefined ? '' : join(antigravityDir, 'brain')
  if (antigravityDir === undefined || !existsSync(brainPath)) {
    report.antigravity = { root: antigravityDir ?? '', brainPath, brainExists: false, transcripts: 0, error: 'brain 目录不存在，适配器未启用' }
  } else {
    try {
      const transcripts = readdirSync(brainPath)
        .filter(entry => existsSync(join(brainPath, entry, '.system_generated', 'logs', 'transcript.jsonl')))
        .length
      report.antigravity = {
        root: antigravityDir, brainPath, brainExists: true, transcripts,
        note: '该端的适配器尚未实装（等 MCP 调用形状实测后登记）；目前只探测目录与转写存在性',
      }
    } catch (e) {
      report.antigravity = {
        root: antigravityDir, brainPath, brainExists: true, transcripts: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }
  return report
}

/** CLI 入口：报告打到 stdout，退出码恒 0（探针红是数据不是故障，交给调用方判断）。 */
export async function runAnchorDoctorCli(): Promise<void> {
  const report = await anchorDoctorReport(process.env)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
