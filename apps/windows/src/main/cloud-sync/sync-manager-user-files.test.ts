/**
 * 用户文件同步端到端测试（**不 mock** SyncExporter / SyncImporter）。
 *
 * 核心回归：本地删除的文件，同步到远端后不能再被 import 复活。
 * 旧实现里 export 与 import 都是「只增不减」的单向复制，删除既进不了
 * git commit（isomorphic-git 的 add 不 stage 删除），又会在下一次 import 时
 * 被 sync 侧的残留复制回本地。
 *
 * 与 sync-manager.test.ts 的分工：那边 mock 掉数据面、专注 Git 合并与冲突落决；
 * 这边跑真实导出/导入，专注用户文件的增删改传播。
 * 数据库相关的导出/导入会因缺表报错（被 exporter/importer 内部吞掉），不影响文件面。
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

describe('CloudSyncManager 用户文件同步', () => {
  let clientRoot: string
  let workspaceDir: string
  let syncDir: string
  let remoteDir: string
  let remoteGitdir: string
  let manager: CloudSyncManager

  /** 本地 workspace 下的文件绝对路径 */
  const localPath = (rel: string) => path.join(workspaceDir, rel)

  /** 远端仓库下的文件绝对路径 */
  const remotePath = (rel: string) => path.join(remoteDir, rel)

  const writeLocal = (rel: string, content: string) => {
    const abs = localPath(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
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

  /** 模拟「另一台设备」在远端提交文件 */
  const commitRemote = async (rel: string, content: string) => {
    const abs = remotePath(rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf-8')
    await git.add({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, filepath: rel })
    await git.commit({
      fs: REMOTE_FS,
      dir: remoteDir,
      gitdir: remoteGitdir,
      message: `remote: ${rel}`,
      author: { name: 'Remote', email: 'remote@test' },
    })
  }

  beforeEach(async () => {
    clientRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-files-'))
    workspaceDir = path.join(clientRoot, 'workspace')
    syncDir = path.join(clientRoot, 'sync')
    fs.mkdirSync(path.join(workspaceDir, 'files'), { recursive: true })
    fs.mkdirSync(path.join(workspaceDir, 'outputs'), { recursive: true })
    fs.mkdirSync(path.join(clientRoot, 'data'), { recursive: true })
    remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-files-remote-'))
    remoteGitdir = path.join(remoteDir, '.git')
    // 远端仓库先建好（但无 commit）：push mock 需要 .git 已存在才能写 ref
    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })

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

  it('本地新增的文件会被推送到远端', async () => {
    writeLocal('files/note.md', 'hello')
    manager = new CloudSyncManager()

    expect((await manager.sync()).success).toBe(true)

    expect(fs.readFileSync(remotePath('workspace/files/note.md'), 'utf8')).toBe('hello')
  })

  it('本地删除的文件同步后从远端消失（核心回归：不再「删了又回来」）', async () => {
    writeLocal('files/note.md', 'hello')
    writeLocal('files/keep.md', 'keep')
    manager = new CloudSyncManager()
    expect((await manager.sync()).success).toBe(true)
    expect(fs.existsSync(remotePath('workspace/files/note.md'))).toBe(true)

    // 用户在文件面板删除 note.md
    fs.rmSync(localPath('files/note.md'))
    expect((await manager.sync()).success).toBe(true)

    // 远端必须跟着删掉，而不是保留残留
    expect(fs.existsSync(remotePath('workspace/files/note.md'))).toBe(false)
    expect(fs.readFileSync(remotePath('workspace/files/keep.md'), 'utf8')).toBe('keep')
  })

  it('全新设备拉取时不会复活已删除的文件', async () => {
    // 设备 A：创建 → 同步 → 删除 → 同步（远端此时已无该文件）
    writeLocal('files/note.md', 'hello')
    manager = new CloudSyncManager()
    await manager.sync()
    fs.rmSync(localPath('files/note.md'))
    await manager.sync()
    expect(fs.existsSync(remotePath('workspace/files/note.md'))).toBe(false)

    // 设备 B：全新环境（无本地 sync 缓存、无本地文件）
    fs.rmSync(syncDir, { recursive: true, force: true })
    fs.mkdirSync(syncDir, { recursive: true })
    fs.rmSync(path.join(workspaceDir, 'files'), { recursive: true, force: true })
    fs.mkdirSync(path.join(workspaceDir, 'files'), { recursive: true })

    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(true)
    expect(fs.existsSync(localPath('files/note.md'))).toBe(false)
  })

  it('首次同步（本地与远端历史无关）不删除本地独有文件，并补入远端独有文件', async () => {
    // 远端已有另一台设备的数据
    await git.init({ fs: REMOTE_FS, dir: remoteDir, gitdir: remoteGitdir, defaultBranch: 'main' })
    await commitRemote('workspace/files/remote-note.md', 'from-other-device')

    // 本机已有自己的文件，且从未同步过
    writeLocal('files/local-note.md', 'mine')

    manager = new CloudSyncManager()
    const r = await manager.sync()
    expect(r.success).toBe(true)

    // 本地独有文件必须原样保留（旧 adoptRemote 行为会把它顶掉）
    expect(fs.readFileSync(localPath('files/local-note.md'), 'utf8')).toBe('mine')
    // 远端独有文件补入本地
    expect(fs.readFileSync(localPath('files/remote-note.md'), 'utf8')).toBe('from-other-device')
  })

  it('本地产出（outputs）同样支持新增与删除传播', async () => {
    writeLocal('outputs/report.md', 'v1')
    manager = new CloudSyncManager()
    await manager.sync()
    expect(fs.readFileSync(remotePath('workspace/outputs/report.md'), 'utf8')).toBe('v1')

    fs.rmSync(localPath('outputs/report.md'))
    await manager.sync()
    expect(fs.existsSync(remotePath('workspace/outputs/report.md'))).toBe(false)
  })
})
