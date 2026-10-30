// @vitest-environment node
/**
 * 工作区清理：扫描 / 干跑 / 删除进回收站 / 恢复 / 安全闸。
 * 用真文件系统（临时目录），不用 mock——这一层就是要验证 IO 行为。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { listTrash, restoreTrash, runCleanup, scanWorkspace, trashPaths } from './workspace-cleanup'
import { getLocalDateString } from './local-time'

let base = ''
let root = ''
let logDir = ''

const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000)

async function writeFileAt(rel: string, content = 'x', old = true): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  if (old) await utimes(abs, OLD, OLD)
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
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-cleanup-'))
  root = path.join(base, 'ws')
  logDir = path.join(base, 'logs')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('scanWorkspace', () => {
  it('四类统计正确，候选只含中间/临时，最近写入被跳过', async () => {
    await writeFileAt('outputs/pet-demo/final.png')
    await writeFileAt('notes.md')
    for (let index = 0; index < 10; index += 1) {
      await writeFileAt(`outputs/pet-demo/cut-${index}.png`)
    }
    // 最近写入的中间文件不能进候选
    await writeFileAt('outputs/pet-demo/cut-fresh.png', 'x', false)
    await writeFileAt('temp/github3/a.txt')
    await writeFileAt('temp/github3/b.txt')
    await writeFileAt('wiki/a.md.lumii-ref')
    await writeFileAt('node_modules/pkg/index.js')

    const scan = await scanWorkspace({ dir: root })

    expect(scan.truncated).toBe(false)
    expect(scan.classes.deliverable.count).toBe(2)
    expect(scan.classes.intermediate.count).toBe(11)
    expect(scan.classes.ephemeral.count).toBe(2)
    // node_modules 不遍历；.lumii-ref 算 internal
    expect(scan.classes.internal.count).toBe(1)
    expect(scan.candidates).toHaveLength(12)
    expect(
      scan.candidates.every((item) => item.role === 'intermediate' || item.role === 'ephemeral'),
    ).toBe(true)
    expect(scan.skipped.some((item) => item.reason === 'too-recent')).toBe(true)
  })

  it('产物侧车算 internal，不进清理候选', async () => {
    await writeFileAt('outputs/x/final.pptx')
    await writeFileAt('outputs/x/final.pptx.lumii-artifact.json', '{"kind":"slides"}')

    const scan = await scanWorkspace({ dir: root })
    expect(scan.classes.deliverable.count).toBe(1)
    expect(scan.classes.internal.count).toBe(1)
    expect(scan.candidates).toHaveLength(0)
  })
})

describe('runCleanup', () => {
  it('dryRun 不动文件；真删只动过程文件，成品保留，可恢复', async () => {
    await writeFileAt('outputs/pet-demo/final.png')
    await writeFileAt('outputs/pet-demo/cut-1.png')
    await writeFileAt('outputs/pet-demo/cut-2.png')
    await writeFileAt('outputs/pet-demo/cut-3.png')
    await writeFileAt('temp/github3/repo/a.txt')

    const dry = await runCleanup({ dir: root, target: 'intermediate', dryRun: true, logDir })
    expect(dry).toMatchObject({ ok: true, dryRun: true, removed: 3 })
    expect(await exists('outputs/pet-demo/cut-1.png')).toBe(true)

    const real = await runCleanup({ dir: root, target: 'intermediate', dryRun: false, logDir })
    expect(real).toMatchObject({ ok: true, dryRun: false, removed: 3 })
    expect(real.trashId).toBeTruthy()

    expect(await exists('outputs/pet-demo/final.png')).toBe(true)
    expect(await exists('outputs/pet-demo/cut-1.png')).toBe(false)
    // 只清 intermediate：temp 不动
    expect(await exists('temp/github3/repo/a.txt')).toBe(true)

    const trash = await listTrash({ dir: root })
    expect(trash).toHaveLength(1)
    expect(trash[0]?.files).toBe(3)

    const restored = await restoreTrash({ dir: root, id: real.trashId! })
    expect(restored).toMatchObject({ ok: true, restored: 3, conflicts: 0 })
    expect(await exists('outputs/pet-demo/cut-1.png')).toBe(true)
    expect(await readFile(path.join(root, 'outputs/pet-demo/cut-1.png'), 'utf8')).toBe('x')
    // 恢复后回收站条目与嵌套空目录都要消失
    expect(await listTrash({ dir: root })).toEqual([])
  })

  it('工具声明为成品的路径即使像中间产物也不删', async () => {
    await writeFileAt('outputs/x/frames/final.mp4')
    await writeFileAt('outputs/x/cut-1.png')

    const result = await runCleanup({
      dir: root,
      target: 'intermediate',
      dryRun: false,
      logDir,
      protectedPaths: ['outputs/x/frames/final.mp4'],
    })
    expect(result).toMatchObject({ ok: true, removed: 1 })
    expect(await exists('outputs/x/frames/final.mp4')).toBe(true)
    expect(await exists('outputs/x/cut-1.png')).toBe(false)
  })

  it('扫描被预算截断时拒绝删除（不拿不完整的引用集冒险）', async () => {
    await writeFileAt('outputs/x/cut-1.png')
    const result = await runCleanup({
      dir: root,
      target: 'intermediate',
      dryRun: false,
      logDir,
      budgetMs: 0,
    })
    expect(result.ok).toBe(false)
    expect(await exists('outputs/x/cut-1.png')).toBe(true)
  })

  it('非法回收站 id（含 .）被拒绝', async () => {
    expect((await restoreTrash({ dir: root, id: '.' })).ok).toBe(false)
  })

  it('被成品引用的中间文件跳过（宁可少删）', async () => {
    await writeFileAt('outputs/x/index.html', '<img src="cut-1.png">')
    await writeFileAt('outputs/x/cut-1.png')
    await writeFileAt('outputs/x/cut-2.png')

    const result = await runCleanup({ dir: root, target: 'intermediate', dryRun: false, logDir })
    expect(result.removed).toBe(1)
    expect(result.skipped).toBe(1)
    expect(await exists('outputs/x/cut-1.png')).toBe(true)
    expect(await exists('outputs/x/cut-2.png')).toBe(false)
  })

  it('最近一小时写入的跳过', async () => {
    await writeFileAt('outputs/x/cut-old.png')
    await writeFileAt('outputs/x/cut-fresh.png', 'x', false)

    const result = await runCleanup({ dir: root, target: 'intermediate', dryRun: false, logDir })
    expect(result.removed).toBe(1)
    expect(await exists('outputs/x/cut-fresh.png')).toBe(true)
  })

  it('both 会同时清 temp', async () => {
    await writeFileAt('outputs/x/cut-1.png')
    await writeFileAt('temp/github3/a.txt')

    const result = await runCleanup({ dir: root, target: 'both', dryRun: false, logDir })
    expect(result.removed).toBe(2)
    expect(await exists('temp/github3/a.txt')).toBe(false)
  })

  it('非法回收站 id 被拒绝', async () => {
    const result = await restoreTrash({ dir: root, id: '../escape' })
    expect(result.ok).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('符号链接不进候选', async () => {
    const target = path.join(base, 'external.png')
    await writeFile(target, 'x')
    await writeFileAt('outputs/x/real.png')
    await symlink(target, path.join(root, 'outputs/x/link.png'))

    const scan = await scanWorkspace({ dir: root })
    expect(scan.candidates.some((item) => item.path === 'outputs/x/link.png')).toBe(false)
    expect(scan.skipped.some((item) => item.reason === 'symlink')).toBe(true)
  })
})

describe('trashPaths（显式删除）', () => {
  it('成品也能删；回收站可恢复；审计 trigger=manual', async () => {
    await writeFileAt('outputs/x/final.png', 'final')
    const result = await trashPaths({ dir: root, paths: ['outputs/x/final.png'], logDir })
    expect(result).toMatchObject({ ok: true, removed: 1, skipped: 0 })
    expect(result.bytes).toBe(5)
    expect(result.trashId).toBeTruthy()
    expect(await exists('outputs/x/final.png')).toBe(false)

    const trash = await listTrash({ dir: root })
    expect(trash[0]?.files).toBe(1)
    const restored = await restoreTrash({ dir: root, id: result.trashId! })
    expect(restored).toMatchObject({ ok: true, restored: 1 })
    expect(await readFile(path.join(root, 'outputs/x/final.png'), 'utf8')).toBe('final')

    // 审计文件名用**本地**日期（生产侧 `getLocalDateString`）；这里也对齐本地，
    // 否则 UTC+8 的 0–8 点跑测试时 UTC 日期差一天 ⇒ ENOENT
    const audit = await readFile(
      path.join(logDir, `cleanup-${getLocalDateString().replace(/-/g, '')}.jsonl`),
      'utf8',
    )
    const line = audit.trim().split('\n')[0]!
    expect(JSON.parse(line)).toMatchObject({ action: 'trash', path: 'outputs/x/final.png', trigger: 'manual' })
  })

  it('刚写入的成品也删（不看 1 小时门槛），但被成品引用的跳过', async () => {
    await writeFileAt('outputs/x/index.html', '<img src="cover.png">', false)
    await writeFileAt('outputs/x/cover.png', 'c', false)
    await writeFileAt('outputs/x/fresh.png', 'f', false)

    const result = await trashPaths({
      dir: root,
      paths: ['outputs/x/cover.png', 'outputs/x/fresh.png'],
      logDir,
    })
    expect(result).toMatchObject({ ok: true, removed: 1, skipped: 1 })
    expect(await exists('outputs/x/cover.png')).toBe(true)
    expect(await exists('outputs/x/fresh.png')).toBe(false)
  })

  it('非法路径（绝对/..）与符号链接被跳过；全部被跳过时报错而不是回 ok', async () => {
    const result = await trashPaths({
      dir: root,
      paths: ['/etc/passwd', '../outside.png', ''],
      logDir,
    })
    expect(result.ok).toBe(false)
    expect(result.removed).toBe(0)
    expect(result.skipped).toBe(3)
  })

  it('扫描被预算截断时一个都不删（不留死链）', async () => {
    await writeFileAt('outputs/x/index.html', '<img src="cover.png">')
    await writeFileAt('outputs/x/cover.png')

    const result = await trashPaths({
      dir: root,
      paths: ['outputs/x/cover.png'],
      logDir,
      budgetMs: 0,
    })
    expect(result.ok).toBe(false)
    expect(await exists('outputs/x/cover.png')).toBe(true)
  })
})

describe('runCleanup 扩展（TTL / 配额）', () => {
  it('olderThanMs 覆盖默认的 1 小时门槛', async () => {
    // 10 分钟前写的：默认 1 小时门槛会跳过，TTL 传 1 分钟则应当清掉
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
    const abs = await writeFileAt('outputs/x/cut-tenmin.png', 'x', false)
    await utimes(abs, tenMinAgo, tenMinAgo)

    const kept = await runCleanup({
      dir: root,
      target: 'intermediate',
      dryRun: false,
      logDir,
      budgetMs: 30000,
    })
    expect(kept.removed).toBe(0)
    expect(await exists('outputs/x/cut-tenmin.png')).toBe(true)

    const result = await runCleanup({
      dir: root,
      target: 'intermediate',
      dryRun: false,
      logDir,
      olderThanMs: 60_000,
      trigger: 'ttl',
      budgetMs: 30000,
    })
    expect(result.removed).toBe(1)
    expect(await exists('outputs/x/cut-tenmin.png')).toBe(false)
  })

  it('budgetBytes 按最老优先，达到预算即停', async () => {
    const older = await writeFileAt('outputs/x/cut-old.png', 'aaaa')
    const newer = await writeFileAt('outputs/x/cut-new.png', 'bbbb')
    await utimes(older, OLD, OLD)
    const mid = new Date(Date.now() - 30 * 60 * 1000)
    await utimes(newer, mid, mid)

    const result = await runCleanup({
      dir: root,
      target: 'intermediate',
      dryRun: false,
      logDir,
      budgetBytes: 1,
      trigger: 'quota',
    })
    expect(result.removed).toBe(1)
    expect(await exists('outputs/x/cut-old.png')).toBe(false)
    expect(await exists('outputs/x/cut-new.png')).toBe(true)
  })
})

describe('purgeTrash', () => {
  it('只删超过 TTL 的批次，且报告释放字节', async () => {
    const { purgeTrash } = await import('./workspace-cleanup')
    const trashRoot = path.join(root, '.lumii', 'trash')
    const oldBatch = path.join(trashRoot, `${Date.now() - 10 * 24 * 60 * 60 * 1000}-aaa`)
    const freshBatch = path.join(trashRoot, `${Date.now() - 60 * 1000}-bbb`)
    await mkdir(oldBatch, { recursive: true })
    await mkdir(freshBatch, { recursive: true })
    await writeFile(path.join(oldBatch, 'a.png'), 'xxxxx')

    const result = await purgeTrash({ dir: root, olderThanMs: 7 * 24 * 60 * 60 * 1000 })
    expect(result).toEqual({ removed: 1, bytes: 5 })
    expect(await exists('.lumii/trash/' + path.basename(oldBatch))).toBe(false)
    expect(await exists('.lumii/trash/' + path.basename(freshBatch))).toBe(true)
  })
})
