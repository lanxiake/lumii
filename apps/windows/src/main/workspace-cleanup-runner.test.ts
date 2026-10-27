// @vitest-environment node
/**
 * 自动清理编排：开关 / 空闲门闩 / TTL 两档 / 配额最老优先 / 回收站到期。
 * 用真文件系统（临时目录）验证实际删了什么，不 mock cleanup 内部。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import {
  DEFAULT_STORAGE_CLEANUP_PREFS,
  hasRunCleanupToday,
  normalizeStorageCleanupPrefs,
  runScheduledCleanup,
} from './workspace-cleanup-runner'

let base = ''
let root = ''
let logDir = ''

async function writeAt(rel: string, ageDays: number, content = 'x'.repeat(1000)): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  await utimes(abs, t, t)
  return abs
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(path.join(root, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-runner-'))
  root = path.join(base, 'ws')
  logDir = path.join(base, 'logs')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('normalizeStorageCleanupPrefs', () => {
  it('缺省走默认（开启、7 天 / 24h / 10GB→80% / 回收站 7 天）', () => {
    expect(normalizeStorageCleanupPrefs(undefined)).toEqual(DEFAULT_STORAGE_CLEANUP_PREFS)
    expect(DEFAULT_STORAGE_CLEANUP_PREFS).toMatchObject({
      enabled: true,
      intermediateDays: 7,
      ephemeralHours: 24,
      quotaGb: 10,
      targetPercent: 80,
      trashDays: 7,
    })
  })

  it('目标比例被夹在 50–95；非法数值回默认', () => {
    expect(normalizeStorageCleanupPrefs({ targetPercent: 99 }).targetPercent).toBe(95)
    expect(normalizeStorageCleanupPrefs({ targetPercent: 10 }).targetPercent).toBe(50)
    expect(normalizeStorageCleanupPrefs({ intermediateDays: -1 }).intermediateDays).toBe(7)
  })
})

describe('runScheduledCleanup', () => {
  it('关闭时完全不跑（连扫描都不做）', async () => {
    await writeAt('outputs/x/cut-1.png', 30)
    const result = await runScheduledCleanup({
      dir: root,
      prefs: { ...DEFAULT_STORAGE_CLEANUP_PREFS, enabled: false },
      idleSeconds: 9999,
      logDir,
    })
    expect(result).toMatchObject({ ran: false, reason: 'disabled' })
    expect(await exists('outputs/x/cut-1.png')).toBe(true)
  })

  it('系统不空闲时跳过', async () => {
    await writeAt('outputs/x/cut-1.png', 30)
    const result = await runScheduledCleanup({
      dir: root,
      prefs: DEFAULT_STORAGE_CLEANUP_PREFS,
      idleSeconds: 10,
      logDir,
    })
    expect(result).toMatchObject({ ran: false, reason: 'not-idle' })
    expect(await exists('outputs/x/cut-1.png')).toBe(true)
  })

  it('TTL：超过 7 天的中间产物被清，新文件保留；临时文件按 24h 清', async () => {
    await writeAt('outputs/x/cut-old.png', 8)
    await writeAt('outputs/x/cut-new.png', 1)
    await writeAt('temp/tmp-old.txt', 2)
    await writeAt('temp/tmp-new.txt', 0.1)
    await writeAt('outputs/x/final.png', 30)

    const result = await runScheduledCleanup({
      dir: root,
      prefs: DEFAULT_STORAGE_CLEANUP_PREFS,
      idleSeconds: 9999,
      logDir,
    })
    expect(result.ran).toBe(true)
    expect(await exists('outputs/x/cut-old.png')).toBe(false)
    expect(await exists('outputs/x/cut-new.png')).toBe(true)
    expect(await exists('temp/tmp-old.txt')).toBe(false)
    expect(await exists('temp/tmp-new.txt')).toBe(true)
    // 成品永不自动删除
    expect(await exists('outputs/x/final.png')).toBe(true)

    // 审计按本地日期落盘，且带 trigger=ttl
    const day = new Date()
    const name = `cleanup-${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}.jsonl`
    const audit = await readFile(path.join(logDir, name), 'utf8')
    expect(audit).toContain('"trigger":"ttl"')
  })

  it('配额：超过阈值时按最老优先清到目标预算', async () => {
    // 三个同尺寸文件；预算只够删最老的一个
    await writeAt('outputs/x/cut-a.png', 20, 'a'.repeat(4000))
    await writeAt('outputs/x/cut-b.png', 10, 'b'.repeat(4000))
    await writeAt('outputs/x/cut-c.png', 5, 'c'.repeat(4000))

    const result = await runScheduledCleanup({
      dir: root,
      prefs: { ...DEFAULT_STORAGE_CLEANUP_PREFS, intermediateDays: 999, quotaGb: 0.000001 },
      idleSeconds: 9999,
      logDir,
      budgetBytesForTest: 1,
    })
    expect(result.ran).toBe(true)
    expect(result.quotaRemoved).toBe(1)
    expect(await exists('outputs/x/cut-a.png')).toBe(false)
    expect(await exists('outputs/x/cut-b.png')).toBe(true)
    expect(await exists('outputs/x/cut-c.png')).toBe(true)
  })

  it('回收站到期：只删超过 trashDays 的批次', async () => {
    const trashRoot = path.join(root, '.lumii', 'trash')
    const oldBatch = path.join(trashRoot, `${Date.now() - 10 * 24 * 60 * 60 * 1000}-aaa`)
    const freshBatch = path.join(trashRoot, `${Date.now() - 1 * 24 * 60 * 60 * 1000}-bbb`)
    await mkdir(oldBatch, { recursive: true })
    await mkdir(freshBatch, { recursive: true })
    await writeFile(path.join(oldBatch, 'a.png'), 'x')
    await writeFile(path.join(freshBatch, 'b.png'), 'y')

    const result = await runScheduledCleanup({
      dir: root,
      prefs: DEFAULT_STORAGE_CLEANUP_PREFS,
      idleSeconds: 9999,
      logDir,
    })
    expect(result.trashRemoved).toBe(1)
    expect(await exists('.lumii/trash/' + path.basename(oldBatch))).toBe(false)
    expect(await exists('.lumii/trash/' + path.basename(freshBatch))).toBe(true)
  })

  it('编辑候选与临时导出：旧的未应用提案和过期 tmp 目录在每日清理里清掉', async () => {
    const editDir = path.join(root, '.lumii', 'edits', 'edit-old')
    await mkdir(editDir, { recursive: true })
    await writeFile(
      path.join(editDir, 'meta.json'),
      JSON.stringify({
        editId: 'edit-old',
        sessionKey: null,
        path: 'outputs/x/a.md',
        action: 'manual',
        scope: { type: 'text-range', start: 0, end: 1 },
        at: Date.now() - 25 * 60 * 60 * 1000,
        status: 'proposed',
        baseHash: 'x',
        beforeFile: 'before.md',
        candidateFile: 'candidate.md',
        originalBytes: 1,
      }),
    )
    await writeFile(path.join(editDir, 'before.md'), 'a')
    await writeFile(path.join(editDir, 'candidate.md'), 'b')

    await writeAt('.lumii/tmp/old/x.bin', 2)
    const oldDir = path.join(root, '.lumii', 'tmp', 'old')
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(oldDir, oldTime, oldTime)
    await mkdir(path.join(root, '.lumii', 'tmp', 'fresh'), { recursive: true })

    const result = await runScheduledCleanup({
      dir: root,
      prefs: DEFAULT_STORAGE_CLEANUP_PREFS,
      idleSeconds: 9999,
      logDir,
    })
    expect(result.ran).toBe(true)
    expect(await exists('.lumii/edits/edit-old')).toBe(false)
    expect(await exists('.lumii/tmp/old')).toBe(false)
    expect(await exists('.lumii/tmp/fresh')).toBe(true)
  })
})

describe('hasRunCleanupToday', () => {
  it('没有审计文件 → false；有内容 → true', async () => {
    expect(await hasRunCleanupToday(logDir)).toBe(false)
    await mkdir(logDir, { recursive: true })
    const day = new Date()
    const name = `cleanup-${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}.jsonl`
    await writeFile(path.join(logDir, name), '{"action":"trash"}\n')
    expect(await hasRunCleanupToday(logDir)).toBe(true)
  })
})
