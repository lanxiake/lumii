/**
 * sync-manager 十三场景单测。
 *
 * 模拟 GitCode 远程：用两个本地临时目录互推（mock git.fetch/git.push 做对象拷贝 +
 * ref 搬运），其余 commit/merge/findMergeBase/checkout 全部真实跑 isomorphic-git，
 * 不联网。配置走 mock('./sync-config')，避免依赖 safeStorage / 真实数据目录。
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

import { loadCloudSyncConfig } from './sync-config'
import { CloudSyncManager } from './sync-manager'
import {
  setActiveWorkspaceDirGetter,
  _resetActiveWorkspaceDirGetterForTest,
} from '../workspace-paths'
import { getWorkspaceVcs, resetWorkspaceVcs } from '../workspace-vcs/vcs-snapshot'

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
  let workspaceDir: string
  let remoteDir: string
  let remoteGitdir: string
  let manager: CloudSyncManager
  let rejectPush: boolean

  const localParams = () => getWorkspaceVcs(workspaceDir).getGitParams()

  const writeLocal = (name: string, content: string) => {
    const abs = path.join(workspaceDir, name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
  }
  const readLocal = (name: string) =>
    fs.readFileSync(path.join(workspaceDir, name), 'utf-8')

  const localHead = async () =>
    git.resolveRef({ ...localParams(), ref: 'refs/heads/main' })
  const remoteHead = async () =>
    git.resolveRef({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, ref: 'refs/heads/main' })

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

  /** 递归拷贝 git 对象库（测试仓库全是 loose object，无 pack） */
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

  /** 建立共享基线：本地建 base 提交 → 首推给远端 */
  const setupBase = async () => {
    const repo = getWorkspaceVcs(workspaceDir)
    await repo.ensureInitialized()
    writeLocal('a.md', 'A0')
    writeLocal('b.md', 'B0')
    writeLocal('shared.md', 'base')
    await repo.commit({ author: 'user', message: 'base' })
    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    manager = new CloudSyncManager()
    await manager.sync()
  }

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-ws-'))
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-remote-'))
    remoteGitdir = path.join(remoteDir, '.git')
    rejectPush = false
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
      // 物化远端工作树 + index，便于后续 commitRemote 在其上继续提交
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
    fs.rmSync(workspaceDir, { recursive: true, force: true })
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
    writeLocal('new.md', 'v1')
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(await remoteHead()).toBe(await localHead())
    expect(await remoteHead()).not.toBe(baseRemote)
  })

  it('仅远程新提交 → 本地快进，文件更新且不 push', async () => {
    await setupBase()
    await commitRemote('b.md', 'B1-remote')
    const beforeRemote = await remoteHead()
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(readLocal('b.md')).toBe('B1-remote')
    expect(await remoteHead()).toBe(beforeRemote) // 未 push，远端不变
    expect(await localHead()).toBe(await remoteHead())
  })

  it('双方改不同文件 → 自动 merge 成功', async () => {
    await setupBase()
    writeLocal('a.md', 'A1-local')
    await commitRemote('b.md', 'B1-remote')
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(r.state).toBe('idle')
    expect(readLocal('a.md')).toBe('A1-local')
    expect(readLocal('b.md')).toBe('B1-remote')
    expect(await localHead()).toBe(await remoteHead())
  })

  it('双方改同一文件 → conflict，ConflictInfo 正确，未 push', async () => {
    await setupBase()
    writeLocal('shared.md', 'local')
    await commitRemote('shared.md', 'remote')
    const beforeRemote = await remoteHead()
    const r = await manager.sync()
    expect(r.success).toBe(false)
    expect(r.state).toBe('conflict')
    const c = manager.getConflict()!
    expect(c.files).toContain('shared.md')
    expect(c.bothModified).toContain('shared.md')
    expect(await remoteHead()).toBe(beforeRemote) // 冲突未 push
  })

  it('resolveConflict keep-local → 远端变为本地版本', async () => {
    await setupBase()
    writeLocal('shared.md', 'local')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    const r = await manager.resolveConflict('keep-local')
    expect(r.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(await remoteHead()).toBe(await localHead())
    expect(fs.readFileSync(path.join(remoteDir, 'shared.md'), 'utf-8')).toBe('local')
  })

  it('resolveConflict keep-remote → 本地变为远程版本', async () => {
    await setupBase()
    writeLocal('shared.md', 'local')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    const r = await manager.resolveConflict('keep-remote')
    expect(r.success).toBe(true)
    expect(readLocal('shared.md')).toBe('remote')
    expect(await localHead()).toBe(await remoteHead())
  })

  it('resolveConflict per-file → 逐文件选侧正确', async () => {
    await setupBase()
    writeLocal('a.md', 'A-local')
    writeLocal('b.md', 'B-local')
    await commitRemote('a.md', 'A-remote')
    await commitRemote('b.md', 'B-remote')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')
    const r = await manager.resolveConflict('per-file', [
      { path: 'a.md', side: 'local' },
      { path: 'b.md', side: 'remote' },
    ])
    expect(r.success).toBe(true)
    expect(readLocal('a.md')).toBe('A-local')
    expect(readLocal('b.md')).toBe('B-remote')
  })

  it('远程分支不存在 → 首推成功', async () => {
    const repo = getWorkspaceVcs(workspaceDir)
    await repo.ensureInitialized()
    writeLocal('only.md', 'hello')
    await repo.commit({ author: 'user', message: '首推' })
    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(await remoteHead()).toBe(await localHead())
    expect(fs.readFileSync(path.join(remoteDir, 'only.md'), 'utf-8')).toBe('hello')
  })

  it('无关历史 → 备份本地 + 采用远端', async () => {
    // 本地与远端各自独立 root，无共同祖先
    const repo = getWorkspaceVcs(workspaceDir)
    await repo.ensureInitialized()
    writeLocal('local-only.md', 'L')
    await repo.commit({ author: 'user', message: 'local root' })

    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    await commitRemote('remote-only.md', 'R')

    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(await localHead()).toBe(await remoteHead())
    expect(readLocal('remote-only.md')).toBe('R')
    // 本地被备份（排除 .mtbot-vcs）
    const backups = fs
      .readdirSync(path.dirname(workspaceDir))
      .filter((n) => n.startsWith(path.basename(workspaceDir) + '.lumii-sync-backup-'))
    expect(backups.length).toBe(1)
  })

  it('criss-cross（多 merge base）→ error', async () => {
    await setupBase()
    writeLocal('a.md', 'A-local')
    await getWorkspaceVcs(workspaceDir).commit({ author: 'user', message: 'local diverge' })
    await commitRemote('b.md', 'B-remote')
    vi.spyOn(git, 'findMergeBase').mockResolvedValueOnce(['1'.repeat(40), '2'.repeat(40)])
    const r = await manager.sync()
    expect(r.success).toBe(false)
    expect(r.state).toBe('error')
    expect(manager.getStatus().lastError).toMatch(/交叉合并/)
  })

  it('conflict 期间再调 sync → 直接返回不重试', async () => {
    await setupBase()
    writeLocal('shared.md', 'local')
    await commitRemote('shared.md', 'remote')
    await manager.sync()
    expect(manager.getStatus().state).toBe('conflict')
    const calls = vi.mocked(git.fetch).mock.calls.length
    const r = await manager.sync()
    expect(r.success).toBe(false)
    expect(r.state).toBe('conflict')
    expect(vi.mocked(git.fetch).mock.calls.length).toBe(calls) // 未再 fetch
  })

  it('push 被拒 → 不强推，返回 idle 等下轮', async () => {
    await setupBase()
    const baseRemote = await remoteHead()
    writeLocal('new.md', 'v1')
    rejectPush = true
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(r.state).toBe('idle')
    expect(await remoteHead()).toBe(baseRemote) // 远端未更新
  })

  it('并发 sync 串行执行，不丢提交', async () => {
    await setupBase()
    writeLocal('c.md', 'v1')
    const [r1, r2] = await Promise.all([manager.sync(), manager.sync()])
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(manager.getStatus().state).toBe('idle')
    expect(await remoteHead()).toBe(await localHead())
  })
})
