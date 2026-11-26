import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { anchorDoctorReport } from '../src/standalone/anchor-doctor.ts'
import { zcodeDbPath } from '../src/tools/anchor-zcode.ts'

// anchor-doctor 的报告：只读探针，不读内容。真实 DDL 建临时库验证结构认得；缺库/缺根/关开关各有报告形状。

const SCHEMA = fileURLToPath(new URL('./fixtures/zcode-schema.sql', import.meta.url))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pm-anchor-doctor-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function buildZcodeDb(zcodeDir: string, sessions = 2): Promise<void> {
  await mkdir(join(zcodeDir, 'db'), { recursive: true })
  const db = new DatabaseSync(zcodeDbPath(zcodeDir))
  db.exec(await readFile(SCHEMA, 'utf8'))
  for (let i = 0; i < sessions; i++) {
    db.prepare("INSERT INTO session_runtime_presence (session_id, owner_id, process_id) VALUES (?, 'main', ?)")
      .run(`sess_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 1000 + i)
  }
  db.close()
}

describe('anchorDoctorReport', () => {
  it('PLASTIC_ANCHOR=off：报告只带开关说明，两端都不探', async () => {
    const report = await anchorDoctorReport({ PLASTIC_ANCHOR: 'off' })
    expect(report.enabled).toBe(false)
    expect(report.note).toContain('已关闭')
    expect(report.zcode).toBeUndefined()
    expect(report.antigravity).toBeUndefined()
  })

  it('两端的根目录都不存在：报告各带「未启用」', async () => {
    const report = await anchorDoctorReport({
      PLASTIC_ZCODE_DIR: join(root, 'no-zcode'),
      PLASTIC_ANTIGRAVITY_DIR: join(root, 'no-ag'),
    })
    expect(report.enabled).toBe(true)
    expect(report.zcode).toMatchObject({ dbExists: false, structureOk: false, onlineSessions: 0 })
    expect(report.zcode?.error).toContain('根目录不存在')
    expect(report.antigravity).toMatchObject({ brainExists: false, transcripts: 0 })
    expect(report.antigravity?.error).toContain('brain 目录不存在')
  })

  it('ZCode 库按真实 DDL 建：结构认得、在线会话数正确、探针不留旁路文件', async () => {
    const zcodeDir = join(root, 'zcode')
    await buildZcodeDb(zcodeDir, 3)
    const report = await anchorDoctorReport({ PLASTIC_ZCODE_DIR: zcodeDir, PLASTIC_ANTIGRAVITY_DIR: join(root, 'no-ag') })
    expect(report.zcode).toMatchObject({ dbExists: true, structureOk: true, onlineSessions: 3 })
    // immutable 打开：探针后库里没有旁路文件
    expect(existsSync(`${zcodeDbPath(zcodeDir)}-wal`)).toBe(false)
    expect(existsSync(`${zcodeDbPath(zcodeDir)}-shm`)).toBe(false)
  })

  it('库结构变了（缺表）：structureOk=false 带原因', async () => {
    const zcodeDir = join(root, 'broken')
    await mkdir(join(zcodeDir, 'db'), { recursive: true })
    const db = new DatabaseSync(zcodeDbPath(zcodeDir))
    db.exec('CREATE TABLE session (id text primary key)')
    db.close()
    const report = await anchorDoctorReport({ PLASTIC_ZCODE_DIR: zcodeDir, PLASTIC_ANTIGRAVITY_DIR: join(root, 'no-ag') })
    expect(report.zcode).toMatchObject({ dbExists: true, structureOk: false, onlineSessions: 0 })
    expect(report.zcode?.error).toBeDefined()
  })

  it('Antigravity 的 brain 目录在：数转写文件，标注适配器尚未实装', async () => {
    const agDir = join(root, 'ag')
    const brain = join(agDir, 'brain')
    for (const id of ['83310ec9-ef98-4b39-ad3d-edbdd079eaec', '1a559a3d-56c5-4c82-b333-a6bba1c171b3']) {
      await mkdir(join(brain, id, '.system_generated', 'logs'), { recursive: true })
      await writeFile(join(brain, id, '.system_generated', 'logs', 'transcript.jsonl'), '{}\n')
    }
    const report = await anchorDoctorReport({ PLASTIC_ZCODE_DIR: join(root, 'no-zcode'), PLASTIC_ANTIGRAVITY_DIR: agDir })
    expect(report.antigravity).toMatchObject({ brainExists: true, transcripts: 2 })
    expect(report.antigravity?.note).toContain('尚未实装')
  })
})
