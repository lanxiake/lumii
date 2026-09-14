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
vi.mock('./sync-exporter', () => ({
  SyncExporter: class {
    async export() {
      return { success: true, exportedFiles: [], errors: [], stats: {} }
    }
    /** 同步流程第 0 步的轻量导出（只 profile + workspace 用户文件） */
    async exportLocalEdits() {
      return { success: true, exportedFiles: [], errors: [], stats: {} }
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
import { CloudSyncManager } from './sync-manager'
import {
  setActiveWorkspaceDirGetter,
  _resetActiveWorkspaceDirGetterForTest,
} from '../workspace-paths'
import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import { resetWorkspaceVcs } from '../workspace-vcs/vcs-snapshot'

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

  /** 递归拷贝 git 对象库（测试仓库全是 loose object） */
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

  it('双方改不同文件 → 自动 merge 成功', async () => {
    await setupBase()
    writeSync('a.md', 'A1-local')
    await commitSync('local a')
    await commitRemote('b.md', 'B1-remote')
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(r.state).toBe('idle')
    expect(readSync('a.md')).toBe('A1-local')
    expect(readSync('b.md')).toBe('B1-remote')
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
})
