/**
 * sync-manager 单测（轻量云同步：操作 syncDir，不联网）。
 *
 * 远程用本地临时目录模拟；git.fetch/git.push mock 为对象拷贝 + ref 搬运。
 * SyncExporter / SyncImporter mock 为 no-op，专注 Git 合并与冲突落决路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import fsp from 'node:fs/promises'
import git from 'isomorphic-git'
import type { PromiseFsClient } from 'isomorphic-git'

vi.mock('./sync-config', () => ({
  loadCloudSyncConfig: vi.fn(),
  decryptToken: vi.fn((enc?: string) => (enc ?? '').replace(/^plain:/, '')),
}))
vi.mock('./sync-log', () => ({
  appendSyncLog: vi.fn(),
}))

/** 可控的导出结果：让测试能模拟「被删除安全阀挡下」并断言确认指纹的传递 */
const mockExportState = vi.hoisted(() => ({
  deleteAborted: false,
  abortedFingerprint: undefined as string | undefined,
  abortedCount: undefined as number | undefined,
  /** 最近一次 SyncExporter 的构造参数 */
  lastOptions: undefined as { confirmedMassDeleteFingerprint?: string } | undefined,
}))

vi.mock('./sync-exporter', () => ({
  SyncExporter: class {
    constructor(options: { confirmedMassDeleteFingerprint?: string }) {
      mockExportState.lastOptions = options
    }
    private result() {
      return {
        success: true,
        exportedFiles: [],
        errors: [],
        stats: {},
        deleteAborted: mockExportState.deleteAborted,
        abortedFingerprint: mockExportState.abortedFingerprint,
        abortedCount: mockExportState.abortedCount,
      }
    }
    async export() {
      return this.result()
    }
    /** 同步流程第 0 步的轻量导出（只 profile + workspace 用户文件） */
    async exportLocalEdits() {
      return this.result()
    }
  },
}))
vi.mock('./sync-importer', () => ({
  SyncImporter: class {
    async import() {
      return {
        success: true,
        errors: [],
        stats: { wikiRows: 0, memoriesImported: 0, autonomousGoals: 0, workspaceFiles: 0 },
      }
    }
  },
}))

import { loadCloudSyncConfig } from './sync-config'
import { CloudSyncManager, PushTimeoutError, computeStagePlan } from './sync-manager'
import {
  setActiveWorkspaceDirGetter,
  _resetActiveWorkspaceDirGetterForTest,
} from '../workspace-paths'
import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import { enqueueWorkspace, resetWorkspaceVcs } from '../workspace-vcs/vcs-snapshot'

const REMOTE_FS = { promises: fsp } as unknown as PromiseFsClient

const baseCfg = {
  enabled: true,
  provider: 'gitcode' as const,
  repoUrl: 'https://gitcode.com/alice/notes.git',
  branch: 'main',
  intervalMinutes: 15,
  tokenEnc: 'plain:test-token',
}

describe('CloudSyncManager', () => {
  let clientRoot: string
  let workspaceDir: string
  let syncDir: string
  let remoteDir: string
  let remoteGitdir: string
  let manager: CloudSyncManager
  let rejectPush: boolean

  /** syncDir 的 isomorphic-git 参数 */
  const syncParams = () => ({
    fs,
    dir: syncDir,
    gitdir: path.join(syncDir, '.git'),
  })

  /** 写入 sync 工作树文件 */
  const writeSync = (name: string, content: string) => {
    const abs = path.join(syncDir, name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }

  /** 读取 sync 工作树文件 */
  const readSync = (name: string) => fs.readFileSync(path.join(syncDir, name), 'utf-8')

  /** 在 syncDir 提交当前变更 */
  const commitSync = async (message: string) => {
    const p = syncParams()
    await git.add({ ...p, filepath: '.' })
    return git.commit({
      ...p,
      message,
      author: { name: 'Local', email: 'local@test' },
    })
  }

  const localHead = async () => git.resolveRef({ ...syncParams(), ref: 'refs/heads/main' })
  const remoteHead = async () =>
    git.resolveRef({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, ref: 'refs/heads/main' })

  /** 在模拟远端提交文件 */
  const commitRemote = async (name: string, content: string) => {
    const abs = path.join(remoteDir, name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
    await git.add({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, filepath: name })
    await git.commit({
      fs: REMOTE_FS,
      dir: remoteDir,
      gitdir: remoteGitdir,
      message: `remote: ${name}`,
      author: { name: 'Remote', email: 'remote@test' },
    })
  }

  /**
   * 递归拷贝 git 对象库（测试仓库全是 loose object）。
   *
   * 已存在就跳过，不做覆盖：object 是**内容寻址**的，目标路径就是它的哈希 ——
   * 同一路径必然是同一份内容，覆盖本身没有意义。
   * 这个跳过不是优化而是必需：真 git 写出的 loose object 在 Windows 上带只读属性
   * （实测 mode=444），对只读目标 copyFileSync 会 EPERM。
   * 此前能工作只是因为 staged 路径全由 isomorphic-git 写、恰好可写 —— 那是个偶然依赖。
   */
  const copyObjects = (fromGitdir: string, toGitdir: string) => {
    const src = path.join(fromGitdir, 'objects')
    if (!fs.existsSync(src)) return
    const walk = (dir: string, rel: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(abs, r)
        else {
          const target = path.join(toGitdir, 'objects', r)
          if (fs.existsSync(target)) continue
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.copyFileSync(abs, target)
        }
      }
    }
    walk(src, '')
  }

  /** 建立共享基线：syncDir 基提交 → 首推远端 */
  const setupBase = async () => {
    fs.mkdirSync(syncDir, { recursive: true })
    const p = syncParams()
    await git.init({ ...p, defaultBranch: 'main' })
    writeSync('a.md', 'A0')
    writeSync('b.md', 'B0')
    writeSync('shared.md', 'base')
    writeSync('profile/user-memory.md', 'memory-base')
    await commitSync('base')
    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    manager = new CloudSyncManager()
    await manager.sync()
  }

  beforeEach(() => {
    clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-client-'))
    workspaceDir = path.join(clientRoot, 'workspace')
    syncDir = path.join(clientRoot, 'sync')
    fs.mkdirSync(workspaceDir, { recursive: true })
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-remote-'))
    remoteGitdir = path.join(remoteDir, '.git')
    rejectPush = false
    mockExportState.deleteAborted = false
    mockExportState.abortedFingerprint = undefined
    mockExportState.abortedCount = undefined
    mockExportState.lastOptions = undefined

    process.env.LUMII_CLIENT_DATA_DIR = clientRoot
    _resetWindowsClientDataRootCacheForTest()
    setActiveWorkspaceDirGetter(() => workspaceDir)
    vi.mocked(loadCloudSyncConfig).mockReturnValue({ ...baseCfg })

    vi.spyOn(git, 'fetch').mockImplementation((async (args: any) => {
      const remoteOid = await git.resolveRef({
        fs: REMOTE_FS,
        dir: remoteDir,
        gitdir: remoteGitdir,
        ref: `refs/heads/${args.ref}`,
      })
      copyObjects(remoteGitdir, args.gitdir)
      await git.writeRef({
        fs: args.fs,
        dir: args.dir,
        gitdir: args.gitdir,
        ref: `refs/remotes/origin/${args.ref}`,
        value: remoteOid,
        force: true,
      })
    }) as unknown as typeof git.fetch)

    vi.spyOn(git, 'push').mockImplementation((async (args: any) => {
      if (rejectPush) {
        rejectPush = false
        throw new Error('[rejected] non-fast-forward')
      }
      // 守卫：resolve/sync 必须推 syncDir，绝不能推到工作区 .mtbot-vcs
      expect(path.normalize(args.dir)).toBe(path.normalize(syncDir))
      expect(String(args.gitdir)).toContain(`${path.sep}sync${path.sep}.git`)

      const localOid = await git.resolveRef({
        fs: args.fs,
        dir: args.dir,
        gitdir: args.gitdir,
        ref: args.ref,
      })
      copyObjects(args.gitdir, remoteGitdir)
      await git.writeRef({
        fs: REMOTE_FS,
        dir: remoteDir,
        gitdir: remoteGitdir,
        ref: 'refs/heads/main',
        value: localOid,
        force: true,
      })
      await git.checkout({
        fs: REMOTE_FS,
        dir: remoteDir,
        gitdir: remoteGitdir,
        ref: 'refs/heads/main',
        force: true,
      })
    }) as unknown as typeof git.push)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    _resetActiveWorkspaceDirGetterForTest()
    resetWorkspaceVcs()
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(clientRoot, { recursive: true, force: true })
    fs.rmSync(remoteDir, { recursive: true, force: true })
  })

  it('未启用（无 repoUrl/token）→ idle 失败', async () => {
    vi.mocked(loadCloudSyncConfig).mockReturnValue({ ...baseCfg, repoUrl: '' })
    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(false)
    expect(r.state).toBe('idle')
  })

  // ── 批量删除确认（2026-09-16 远端清空事故的回归防护） ──────────────────

  it('批量删除：被挡下只记录待确认，绝不自动放行', async () => {
    await setupBase()

    mockExportState.deleteAborted = true
    mockExportState.abortedFingerprint = 'fp-abc123'
    mockExportState.abortedCount = 896
    await manager.sync()

    const pending = manager.getPendingMassDelete()
    expect(pending?.fingerprint).toBe('fp-abc123')
    expect(pending?.count).toBe(896)

    // 关键回归点：**不确认**就再同步一次。
    // 旧实现会在这一步自动放行（正是事故根因）；现在绝不携带确认指纹。
    mockExportState.lastOptions = undefined
    await manager.sync()
    const optsAfterUnconfirmedRetry = mockExportState.lastOptions as
      | { confirmedMassDeleteFingerprint?: string }
      | undefined
    expect(optsAfterUnconfirmedRetry?.confirmedMassDeleteFingerprint).toBeUndefined()
  })

  it('批量删除：指纹不匹配被拒，匹配才放行', async () => {
    await setupBase()

    mockExportState.deleteAborted = true
    mockExportState.abortedFingerprint = 'fp-abc123'
    mockExportState.abortedCount = 896
    await manager.sync()

    // 指纹不匹配 → 拒绝，待确认保留
    expect(manager.confirmMassDelete('fp-wrong').success).toBe(false)
    expect(manager.getPendingMassDelete()).toBeDefined()

    // 指纹匹配 → 放行，待确认清空
    expect(manager.confirmMassDelete('fp-abc123').success).toBe(true)
    expect(manager.getPendingMassDelete()).toBeUndefined()

    // 确认后下一次同步携带该指纹（真正是否删除由 sync-copy 比对决定）
    await manager.sync()
    expect(mockExportState.lastOptions?.confirmedMassDeleteFingerprint).toBe('fp-abc123')
  })

  it('批量删除：无待确认时确认被拒；源侧恢复后待确认作废', async () => {
    await setupBase()
    expect(manager.getPendingMassDelete()).toBeUndefined()
    expect(manager.confirmMassDelete('any').success).toBe(false)

    mockExportState.deleteAborted = true
    mockExportState.abortedFingerprint = 'fp-1'
    mockExportState.abortedCount = 10
    await manager.sync()
    expect(manager.getPendingMassDelete()).toBeDefined()

    // 源侧恢复正常（本次无超阈值删除）→ 先前的待确认作废
    mockExportState.deleteAborted = false
    mockExportState.abortedFingerprint = undefined
    mockExportState.abortedCount = undefined
    await manager.sync()
    expect(manager.getPendingMassDelete()).toBeUndefined()
  })

  // ── 落决守卫（2026-09-17 心跳重入死循环的回归防护） ────────────────────

  it('落决守卫：resolveInner 未结束时拒绝重复请求，结束后复位', async () => {
    await setupBase()

    let releaseGate!: () => void
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    const spy = vi
      .spyOn(
        manager as unknown as {
          resolveInner: (s: string, c?: unknown) => Promise<{ success: boolean }>
        },
        'resolveInner',
      )
      .mockImplementation(async () => {
        await gate
        return { success: true }
      })

    expect(manager.isResolveInFlight()).toBe(false)

    // 发起落决但不等待完成 —— 模拟「超时后仍在后台跑」的状态
    const inflight = manager.resolveConflict('keep-local')
    await new Promise((r) => setTimeout(r, 20))
    expect(manager.isResolveInFlight()).toBe(true)

    // 飞行中重复请求被拒（心跳/调度器每轮都会来一次，必须挡住）
    const dup = await manager.resolveConflict('keep-local')
    expect(dup.success).toBe(false)
    expect(dup.error).toContain('仍在后台执行')

    releaseGate()
    await inflight
    expect(manager.isResolveInFlight()).toBe(false)

    spy.mockRestore()
  })

  // ── stage 计划：分级传输的误删防护（statusMatrix 行 = [路径, HEAD, 工作区, index]） ──

  it('computeStagePlan：HEAD 有 + 工作区没有 → 判为删除', () => {
    const status: Array<[string, number, number, number]> = [['gone.md', 1, 0, 1]]
    const plan = computeStagePlan(status, () => false)

    expect(plan.hasChanges).toBe(true)
    expect(plan.removals).toEqual(['gone.md'])
  })

  it('computeStagePlan：排除集内的大文件不判删除 —— 阶段一不能删掉阶段二的成果', () => {
    // 这正是分级传输的核心风险：大文件在 HEAD 里（阶段二提交过），
    // 但阶段一导出时被 1MB 阈值过滤掉、不在工作区 → 默认会被判成删除
    const status: Array<[string, number, number, number]> = [
      ['workspace/outputs/big.mp4', 1, 0, 1],
    ]
    const plan = computeStagePlan(status, (f) => f === 'workspace/outputs/big.mp4')

    expect(plan.hasChanges).toBe(false)
    expect(plan.removals).toEqual([])
  })

  it('computeStagePlan：排除集只豁免被排除的路径，其他删除照常判定', () => {
    const status: Array<[string, number, number, number]> = [
      ['workspace/outputs/big.mp4', 1, 0, 1], // 被排除
      ['workspace/outputs/small.md', 1, 0, 1], // 未排除 → 真删除
    ]
    const plan = computeStagePlan(status, (f) => f.endsWith('.mp4'))

    expect(plan.hasChanges).toBe(true)
    expect(plan.removals).toEqual(['workspace/outputs/small.md'])
  })

  // ── stageAllChanges 的**端到端**行为（含真 git 快路径）──
  //
  // 上面几条守的是 computeStagePlan 这个纯函数；而暂存现在优先走真 git 子进程
  // （见 sync-manager.ts 的 stageAllChangesViaCli），**不再经过那个纯函数**。
  // 于是「排除集内的大文件不能被判为删除」这条语义一度变成后端到端无人守 ——
  // 而这正是分级传输的核心风险：大文件在 HEAD 里（阶段二提交过）、
  // 阶段一导出时被阈值跳过 → 不做豁免就会每跑一次阶段一删掉阶段二的成果。

  /** 直接调私有的 stageAllChanges（它是本用例的 SUT） */
  const stageAll = (p: ReturnType<typeof syncParams>, excluded?: readonly string[]) =>
    (
      manager as unknown as {
        stageAllChanges: (p: unknown, ex?: readonly string[]) => Promise<boolean>
      }
    ).stageAllChanges(p, excluded)

  it('stageAllChanges：排除集内且工作区已不存在的路径不被暂存为删除', async () => {
    await setupBase()
    const p = syncParams()

    // 模拟「阶段二已提交的大文件」：它在 HEAD 里
    writeSync('workspace/files/big.bin', 'BIG-CONTENT')
    await commitSync('phase2: 提交大文件')

    // 阶段一导出按阈值跳过它 → 工作区里不存在
    fs.rmSync(path.join(syncDir, 'workspace/files/big.bin'))

    const changed = await stageAll(p, ['workspace/files/big.bin'])

    // [filepath, head, workdir, stage]：stage 必须仍是 1（与 HEAD 一致）；
    // 若被当成删除就是 0 —— 那等于每跑一次阶段一就删掉阶段二的成果
    const row = (await git.statusMatrix({ ...p })).find(([f]) => f === 'workspace/files/big.bin')
    expect(row?.[1]).toBe(1)
    expect(row?.[3]).toBe(1)
    // 排除集内是唯一差异 → 整轮判为无变更
    expect(changed).toBe(false)
  })

  it('stageAllChanges：未被排除的删除照常暂存', async () => {
    await setupBase()
    const p = syncParams()

    writeSync('workspace/files/gone.md', 'x')
    await commitSync('加一个待删文件')
    fs.rmSync(path.join(syncDir, 'workspace/files/gone.md'))

    const changed = await stageAll(p, [])

    expect(changed).toBe(true)
    const row = (await git.statusMatrix({ ...p })).find(([f]) => f === 'workspace/files/gone.md')
    expect(row?.[1]).toBe(1) // HEAD 里有
    expect(row?.[3]).toBe(0) // index 里没了 = 已暂存为删除
  })

  it('computeStagePlan：内容变化计入 hasChanges 但不产生 remove', () => {
    const status: Array<[string, number, number, number]> = [['a.md', 1, 2, 1]]
    const plan = computeStagePlan(status, () => false)

    expect(plan.hasChanges).toBe(true)
    expect(plan.removals).toEqual([])
  })

  it('仅本地新提交 → push 成功，远程收到', async () => {
    await setupBase()
    const baseRemote = await remoteHead()
    writeSync('new.md', 'v1')
    await commitSync('local new')
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(await remoteHead()).toBe(await localHead())
    expect(await remoteHead()).not.toBe(baseRemote)
  })

  it('仅远程新提交 → 本地快进，文件更新且不 push', async () => {
    await setupBase()
    await commitRemote('b.md', 'B1-remote')
    const beforeRemote = await remoteHead()
    const pushCallsBefore = vi.mocked(git.push).mock.calls.length
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(readSync('b.md')).toBe('B1-remote')
    expect(await remoteHead()).toBe(beforeRemote)
    expect(await localHead()).toBe(await remoteHead())
    expect(vi.mocked(git.push).mock.calls.length).toBe(pushCallsBefore)
  })

  it('双方改不同文件 → 自动 merge 成功，且分支指针指向合并结果', async () => {
    await setupBase()
    writeSync('a.md', 'A1-local')
    await commitSync('local a')
    await commitRemote('b.md', 'B1-remote')
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(r.state).toBe('idle')
    expect(readSync('a.md')).toBe('A1-local')
    expect(readSync('b.md')).toBe('B1-remote')

    // HEAD 必须仍挂在分支上。isomorphic-git 的 merge 以 ours 为 ref 直接 writeRef，
    // 传 'HEAD' 会把 .git/HEAD 覆盖成裸 oid（detached）且 refs/heads/main 不动，
    // 之后 commit 落到游离提交、push 推的还是旧 main。
    const head = fs.readFileSync(path.join(syncDir, '.git', 'HEAD'), 'utf-8').trim()
    expect(head).toBe('ref: refs/heads/main')

    // 远端必须同时拿到双方改动。只断言 localHead() === remoteHead() 会假绿 ——
    // 分支指针没更新时两者都是旧值，照样相等。
    expect(fs.readFileSync(path.join(remoteDir, 'a.md'), 'utf-8')).toBe('A1-local')
    expect(fs.readFileSync(path.join(remoteDir, 'b.md'), 'utf-8')).toBe('B1-remote')
    expect(await localHead()).toBe(await remoteHead())
  })

  it('双方改同一文件 → conflict，ConflictInfo 正确，未 push', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    const beforeRemote = await remoteHead()
    const r = await manager.sync()
    expect(r.success).toBe(false)
    expect(r.state).toBe('conflict')
    const c = manager.getConflict()!
    expect(c.files).toContain('shared.md')
    expect(c.bothModified).toContain('shared.md')
    expect(await remoteHead()).toBe(beforeRemote)
  })

  it('resolveConflict keep-local → 在 syncDir 落决且远端变为本地版本', async () => {
    await setupBase()
    writeSync('profile/user-memory.md', 'local-memory')
    await commitSync('local memory')
    await commitRemote('profile/user-memory.md', 'remote-memory')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')

    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(await remoteHead()).toBe(await localHead())
    expect(fs.readFileSync(path.join(remoteDir, 'profile/user-memory.md'), 'utf-8')).toBe(
      'local-memory',
    )
    expect(readSync('profile/user-memory.md')).toBe('local-memory')
  })

  it('resolveConflict：远端 tracking ref 丢失时仍可用 conflict.remoteOid 落决', async () => {
    await setupBase()
    writeSync('profile/user-memory.md', 'local-memory')
    await commitSync('local memory')
    await commitRemote('profile/user-memory.md', 'remote-memory')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')

    // 模拟历史故障：refs/remotes/origin/main 被删
    const syncGitdir = path.join(syncDir, '.git')
    const remoteTracking = path.join(syncGitdir, 'refs', 'remotes', 'origin', 'main')
    fs.rmSync(remoteTracking, { force: true })

    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(readSync('profile/user-memory.md')).toBe('local-memory')
    // HEAD 应挂回分支（非 detached）
    const head = fs.readFileSync(path.join(syncGitdir, 'HEAD'), 'utf-8').trim()
    expect(head).toBe('ref: refs/heads/main')
  })

  it('resolveConflict keep-remote → syncDir 变为远程版本', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    const r = await manager.resolveConflict('keep-remote')
    expect(r.success).toBe(true)
    expect(readSync('shared.md')).toBe('remote')
    expect(await localHead()).toBe(await remoteHead())
  })

  it('resolveConflict per-file → 逐文件选侧正确', async () => {
    await setupBase()
    writeSync('a.md', 'A-local')
    writeSync('b.md', 'B-local')
    await commitSync('local both')
    await commitRemote('a.md', 'A-remote')
    await commitRemote('b.md', 'B-remote')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')
    const r = await manager.resolveConflict('per-file', [
      { path: 'a.md', side: 'local' },
      { path: 'b.md', side: 'remote' },
    ])
    expect(r.success).toBe(true)
    expect(readSync('a.md')).toBe('A-local')
    expect(readSync('b.md')).toBe('B-remote')
  })

  it('resolveConflict：远端非冲突变更不会在落决时被丢弃', async () => {
    await setupBase()
    // 本地改 shared.md —— 会与远端冲突
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    // 远端改同一文件（冲突），同时新增另一文件（非冲突）
    await commitRemote('shared.md', 'remote')
    await commitRemote('new-from-remote.md', 'R-new')

    expect((await manager.sync()).state).toBe('conflict')

    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(true)

    // 冲突文件按策略落决
    expect(readSync('shared.md')).toBe('local')
    // 关键：远端的非冲突新增必须存活 ——
    // 落决 commit 的 parent 含 remoteOid，tree 里若没有它，就等于把它删了
    expect(readSync('new-from-remote.md')).toBe('R-new')
    expect(fs.existsSync(path.join(remoteDir, 'new-from-remote.md'))).toBe(true)
    expect(await localHead()).toBe(await remoteHead())
  })

  it('resolveConflict：远端非冲突的删除同样会传播', async () => {
    await setupBase()
    // 本地改 a.md（不冲突）
    writeSync('a.md', 'A-local')
    await commitSync('local a')
    // 远端改 shared.md（与下面本地的改动冲突）并删除 b.md
    await commitRemote('shared.md', 'remote-shared')
    fs.rmSync(path.join(remoteDir, 'b.md'))
    // 只能 git.remove：add 对已删除的文件会抛 NotFoundError（工作树遍历不到它）
    await git.remove({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, filepath: 'b.md' })
    await git.commit({
      fs: REMOTE_FS,
      dir: remoteDir,
      gitdir: remoteGitdir,
      message: 'remote: delete b.md',
      author: { name: 'Remote', email: 'remote@test' },
    })
    writeSync('shared.md', 'local-shared')
    await commitSync('local shared')

    expect((await manager.sync()).state).toBe('conflict')

    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(true)

    expect(readSync('a.md')).toBe('A-local')
    expect(fs.existsSync(path.join(remoteDir, 'b.md'))).toBe(false)
  })

  it('readFileAt 在冲突时可读 syncDir 三方内容', async () => {
    await setupBase()
    writeSync('profile/user-memory.md', 'local-memory')
    await commitSync('local memory')
    await commitRemote('profile/user-memory.md', 'remote-memory')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')

    const local = await manager.readFileAt('local', 'profile/user-memory.md')
    const remote = await manager.readFileAt('remote', 'profile/user-memory.md')
    const base = await manager.readFileAt('base', 'profile/user-memory.md')
    expect(local).toBe('local-memory')
    expect(remote).toBe('remote-memory')
    expect(base).toBe('memory-base')
  })

  it('gitStatus：未初始化仓库返回 initialized=false', async () => {
    const status = await manager.gitStatus()
    expect(status.initialized).toBe(false)
  })

  it('gitStatus：冲突时含 conflictFiles 与 headOid', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')

    const status = await manager.gitStatus()
    expect(status.initialized).toBe(true)
    expect(status.state).toBe('conflict')
    expect(status.conflictFiles).toContain('shared.md')
    expect(status.headOid).toBeTruthy()
  })

  it('gitLog：返回提交历史，未初始化返回空 commits', async () => {
    const empty = await manager.gitLog()
    expect(empty.initialized).toBe(false)
    expect(empty.commits).toEqual([])

    await setupBase()
    const log = await manager.gitLog(10)
    expect(log.initialized).toBe(true)
    const commits = log.commits as Array<{ oid: string; message: string }>
    expect(commits.length).toBeGreaterThan(0)
    expect(commits[0]!.oid).toBeTruthy()
  })

  it('gitRemote：getRemoteInfo 失败返回 reachable=false（脱敏）', async () => {
    vi.spyOn(git, 'getRemoteInfo').mockRejectedValue(new Error('boom plain:test-token'))
    const remote = await manager.gitRemote()
    expect(remote.enabled).toBe(true)
    expect(remote.reachable).toBe(false)
    expect(String(remote.error)).toContain('***')
    expect(String(remote.error)).not.toContain('test-token')
  })

  it('gitRemote：远端 tip 与本地分支一致 → pushed=true', async () => {
    await setupBase()
    const head = await localHead()
    vi.spyOn(git, 'getRemoteInfo').mockResolvedValue({
      refs: { 'refs/heads/main': head },
    } as never)
    const remote = await manager.gitRemote()
    expect(remote.reachable).toBe(true)
    expect(remote.headOid).toBe(head)
    expect(remote.localHead).toBe(head)
    expect(remote.pushed).toBe(true)
  })

  it('gitRemote：远端 tip 落后于本地 → pushed=false', async () => {
    await setupBase()
    const remoteHead = await localHead()
    writeSync('extra.md', 'x')
    await commitSync('本地前进')
    vi.spyOn(git, 'getRemoteInfo').mockResolvedValue({
      refs: { 'refs/heads/main': remoteHead },
    } as never)
    const remote = await manager.gitRemote()
    expect(remote.reachable).toBe(true)
    expect(remote.pushed).toBe(false)
  })

  it('resolveConflict push 被拒 → 保持 conflict，不假成功', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    rejectPush = true
    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(false)
    expect(manager.getStatus().state).toBe('conflict')
    expect(r.error).toMatch(/rejected|non-fast-forward/i)
  })

  it('远程分支不存在 → 首推成功', async () => {
    fs.mkdirSync(syncDir, { recursive: true })
    const p = syncParams()
    await git.init({ ...p, defaultBranch: 'main' })
    writeSync('only.md', 'hello')
    await commitSync('首推')
    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(await remoteHead()).toBe(await localHead())
    expect(fs.readFileSync(path.join(remoteDir, 'only.md'), 'utf-8')).toBe('hello')
  })

  it('无关历史 → 备份 syncDir + 保留本地做双亲合并', async () => {
    fs.mkdirSync(syncDir, { recursive: true })
    await git.init({ ...syncParams(), defaultBranch: 'main' })
    writeSync('local-only.md', 'L')
    await commitSync('local root')

    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    await commitRemote('remote-only.md', 'R')

    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(true)

    // 本地内容保留（旧行为 adoptRemote 会把本地历史整个丢掉）
    expect(readSync('local-only.md')).toBe('L')
    expect(await localHead()).toBe(await remoteHead())

    // 合并提交有两个父提交：本地一条、远端一条，两条历史都保留
    const { commit } = await git.readCommit({ ...syncParams(), oid: await localHead() })
    expect(commit.parent.length).toBe(2)

    const backups = fs
      .readdirSync(clientRoot)
      .filter((n) => n.startsWith('sync.lumii-sync-backup-'))
    expect(backups.length).toBe(1)
  })

  it('conflict 期间再调 sync → 直接返回不重试', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')
    const calls = vi.mocked(git.fetch).mock.calls.length
    const r = await manager.sync()
    expect(r.success).toBe(false)
    expect(r.state).toBe('conflict')
    expect(vi.mocked(git.fetch).mock.calls.length).toBe(calls)
  })

  it('push 被拒（普通 sync）→ 不强推，返回 idle 等下轮', async () => {
    await setupBase()
    const baseRemote = await remoteHead()
    writeSync('new.md', 'v1')
    await commitSync('local new')
    rejectPush = true
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(r.state).toBe('idle')
    expect(await remoteHead()).toBe(baseRemote)
  })

  it('并发 sync 串行执行，不丢提交', async () => {
    await setupBase()
    writeSync('c.md', 'v1')
    await commitSync('local c')
    const [r1, r2] = await Promise.all([manager.sync(), manager.sync()])
    expect(r1.success || r2.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(await remoteHead()).toBe(await localHead())
  })

  it('fetch 不使用 singleBranch（否则本地有未推送提交时服务端无法增量协商）', async () => {
    await setupBase()
    writeSync('new.md', 'v1')
    await commitSync('local new')
    await manager.sync()
    const calls = vi.mocked(git.fetch).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [args] of calls) {
      expect((args as { singleBranch?: boolean }).singleBranch).not.toBe(true)
    }
  })

  // ── 生成物冲突自动落决（v3 设计不变量：DB 导出物不参与 git 文字合并）──

  it('生成物冲突（wiki jsonl）自动取远端收尾，不进 conflict、不打扰 Agent', async () => {
    await setupBase()
    // 双方各自改了同一个生成物文件（本地的由 DB 导出、远端的来自另一台设备）
    writeSync('wiki/wiki_inbox.jsonl', '{"id":"a","created_at":"T1"}\n')
    await commitSync('local wiki base')
    writeSync('wiki/wiki_inbox.jsonl', '{"id":"a","created_at":"T1"}\n{"id":"c","created_at":"T3"}\n')
    await commitSync('local wiki edit')
    await commitRemote(
      'wiki/wiki_inbox.jsonl',
      '{"id":"a","created_at":"T1"}\n{"id":"b","created_at":"T2"}\n',
    )

    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(r.state).toBe('idle')
    // 不进入 conflict 状态，Agent 不会被唤醒
    expect(manager.getConflict()).toBeUndefined()
    // 落决取远端版本（本地记录由后续 import 并入 DB，再 export 重建文件）
    expect(readSync('wiki/wiki_inbox.jsonl')).toBe(
      '{"id":"a","created_at":"T1"}\n{"id":"b","created_at":"T2"}\n',
    )
    expect(await localHead()).toBe(await remoteHead())
  })

  it('生成物与用户文件混合冲突：只有用户文件交给 Agent，生成物已取远端', async () => {
    await setupBase()
    writeSync('wiki/wiki_sources.jsonl', '{"id":"s1","created_at":"T1"}\n')
    writeSync('shared.md', 'local')
    await commitSync('local edits')
    await commitRemote('wiki/wiki_sources.jsonl', '{"id":"s1","created_at":"T1"}\n{"id":"s2","created_at":"T2"}\n')
    await commitRemote('shared.md', 'remote')

    const r = await manager.sync()
    expect(r.state).toBe('conflict')
    const c = manager.getConflict()!
    // 冲突清单里只剩用户文件；生成物已自动落决
    expect(c.files).toEqual(['shared.md'])
    expect(readSync('wiki/wiki_sources.jsonl')).toContain('s2')

    const rr = await manager.resolveConflict('keep-local')
    expect(rr.success).toBe(true)
    expect(readSync('shared.md')).toBe('local')
    expect(readSync('wiki/wiki_sources.jsonl')).toContain('s2')
    expect(await localHead()).toBe(await remoteHead())
  })

  // ── 冲突快照 CAS 刷新（落决期间远端前进）──

  it('落决 push 被拒且远端已前进 → 刷新快照，下一轮落决收敛（不丢远端新提交）', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    expect((await manager.sync()).state).toBe('conflict')
    const staleRemoteOid = manager.getConflict()!.remoteOid

    // 冲突期间另一台设备又推了一次，远端前进
    await commitRemote('shared.md', 'remote-v2')
    const newRemoteOid = await remoteHead()
    expect(newRemoteOid).not.toBe(staleRemoteOid)

    // 本轮落决推送必然被拒（远端已不是快照里的 oid）
    rejectPush = true
    const r1 = await manager.resolveConflict('keep-local')
    expect(r1.success).toBe(false)
    expect(r1.error).toMatch(/刷新/)
    // 快照已刷新为新远端 tip，仍在 conflict 等待重新处理
    expect(manager.getStatus().state).toBe('conflict')
    expect(manager.getConflict()!.remoteOid).toBe(newRemoteOid)

    // 第二轮按新快照落决成功
    const r2 = await manager.resolveConflict('keep-local')
    expect(r2.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(fs.readFileSync(path.join(remoteDir, 'shared.md'), 'utf-8')).toBe('local')
    expect(await localHead()).toBe(await remoteHead())
  })

  it('落决 push 超时视为「服务端可能已接收」→ 刷新后复核收敛', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    expect((await manager.sync()).state).toBe('conflict')

    // 模拟：服务端实际已接收落决提交（远端 main 前进到落决提交），但客户端等待回执超时
    const pushMock = vi.mocked(git.push)
    const original = pushMock.getMockImplementation()!
    pushMock.mockImplementationOnce((async (args: {
      dir: string
      gitdir: string
      fs: typeof fs
      ref: string
    }) => {
      const localOid = await git.resolveRef({ ...args, ref: args.ref })
      copyObjects(args.gitdir, remoteGitdir)
      await git.writeRef({
        fs: REMOTE_FS,
        dir: remoteDir,
        gitdir: remoteGitdir,
        ref: 'refs/heads/main',
        value: localOid,
        force: true,
      })
      throw new PushTimeoutError(1)
    }) as unknown as typeof git.push)

    const r = await manager.resolveConflict('keep-local')
    pushMock.mockImplementation(original)
    expect(r.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(await localHead()).toBe(await remoteHead())
  })

  it('落决 push 被拒且远端未前进 → 保持 conflict 并上报原错误', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    expect((await manager.sync()).state).toBe('conflict')
    const before = manager.getConflict()!

    rejectPush = true
    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/rejected|non-fast-forward/i)
    expect(manager.getStatus().state).toBe('conflict')
    expect(manager.getConflict()!.remoteOid).toBe(before.remoteOid)
  })

  it('删除/修改型冲突：keep-local 保持删除语义，不因选侧缺文件而失败', async () => {
    await setupBase()
    // 本地删除 shared.md 并提交（对应导出镜像的删除传播）
    fs.rmSync(path.join(syncDir, 'shared.md'))
    await git.remove({ ...syncParams(), filepath: 'shared.md' })
    await commitSync('local delete shared')
    // 远端修改了 shared.md（删除 vs 修改 → deleteByUs 冲突）
    await commitRemote('shared.md', 'remote-modified')

    expect((await manager.sync()).state).toBe('conflict')
    const c = manager.getConflict()!
    expect(c.deleteByUs).toContain('shared.md')

    const r = await manager.resolveConflict('keep-local')
    expect(r.success, `resolve 失败: ${r.error}`).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    // 删除语义保留：本地与远端都不再有这个文件
    expect(fs.existsSync(path.join(syncDir, 'shared.md'))).toBe(false)
    expect(fs.existsSync(path.join(remoteDir, 'shared.md'))).toBe(false)
    expect(await localHead()).toBe(await remoteHead())
  })

  it('并发 resolveConflict 串行执行，最终一致收敛', async () => {
    await setupBase()
    writeSync('shared.md', 'local')
    await commitSync('local shared')
    await commitRemote('shared.md', 'remote')
    expect((await manager.sync()).state).toBe('conflict')

    const [r1, r2] = await Promise.all([
      manager.resolveConflict('keep-local'),
      manager.resolveConflict('keep-local'),
    ])
    expect(r1.success || r2.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(await localHead()).toBe(await remoteHead())
  })

  /**
   * 排队可见性（2026-09-17 P0 回归）。
   *
   * 云同步与 Turn 快照共用一条串行队列，快照高峰期单个要跑 30–80 秒、队列深度可达 14，
   * `sync()` 排在后面等好几分钟。此前的症状是「设置页按钮一直转圈，状态栏却显示上一次的
   * 同步完成」—— 因为排队期间状态一个字都不变，看起来和一切正常完全一样。
   */
  it('排队中：status 报出前面还有几个任务，且不污染 state 与 lastSyncAt', async () => {
    // 用一条未完成的任务占住工作区队列，模拟 Turn 快照正在跑
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueWorkspace(workspaceDir, () => gate, 'test:blocker')

    const before = manager.getStatus().lastSyncAt
    const p = manager.sync() // 不 await：它会排在 blocker 后面

    const s = manager.getStatus()
    expect(s.queuedBehind).toBe(1)
    // 排队不是「引擎在跑同步」—— state 必须留在 idle，
    // 否则会打断 watcher 的抑制判断与 commitLocalChanges 的 state 守卫
    expect(s.state).toBe('idle')
    // 排队不是一次同步，不能更新 lastSyncAt（否则「最近同步」显示成从没发生过的时刻）
    expect(s.lastSyncAt).toBe(before)
    expect(s.message).toContain('前面还有 1 个任务')

    release()
    await blocker
    await p
    // 任何真实状态迁移之后，排队标记都必须被清掉，不能一直挂着「排队中」
    expect(manager.getStatus().queuedBehind).toBeUndefined()
  })

  it('未排队时 status 不带 queuedBehind（避免把「已完成」误读成「在排队」）', async () => {
    await setupBase()
    await manager.sync()
    expect(manager.getStatus().queuedBehind).toBeUndefined()
  })

  it('syncInner 提前返回时也要清掉排队标记（不能永远挂着「排队中」）', async () => {
    // syncInner 有多条**不调 setState** 的提前返回路径（未启用 / conflict / syncing）。
    // 排队标记若只靠 setState 清，这些路径会把「排队中」永远留在状态栏上 ——
    // 所以清除动作放在「任务真正开始执行」那一步。
    vi.mocked(loadCloudSyncConfig).mockReturnValue({ ...baseCfg, enabled: false })

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blocker = enqueueWorkspace(workspaceDir, () => gate, 'test:blocker')

    const p = manager.sync()
    expect(manager.getStatus().queuedBehind).toBe(1)

    release()
    await blocker
    await p
    expect(manager.getStatus().queuedBehind).toBeUndefined()
  })
})
