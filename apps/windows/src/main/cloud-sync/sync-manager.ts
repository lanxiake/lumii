/**
 * CloudSyncManager — 云同步主流程。
 *
 * 唯一有分支逻辑的模块。复用 workspace-vcs 的同一仓库实例与串行队列
 * （enqueueWorkspace），避免与 Turn 快照并发操作 index/HEAD 丢提交。
 * isomorphic-git 关键行为已对照 1.40.0 源码核实（见计划 §1.1）。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import git from 'isomorphic-git'
import type { PromiseFsClient } from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getWorkspaceVcs, enqueueWorkspace } from '../workspace-vcs/vcs-snapshot'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import { createLogger } from '../logger'
import { getProvider } from './git-provider'
import { loadCloudSyncConfig, decryptToken } from './sync-config'
import { appendSyncLog } from './sync-log'
import type { SyncState, SyncStatus, ConflictInfo } from './types'

const logger = createLogger('cloud-sync/manager')

type GitParams = { fs: PromiseFsClient; dir: string; gitdir: string }

type AuthFn = () => { username: string; password: string }

interface MergeConflictErrorData {
  filepaths: string[]
  bothModified: string[]
  deleteByUs: string[]
  deleteByTheirs: string[]
}

function isMergeConflict(err: unknown): err is { data: MergeConflictErrorData } {
  return (err as { code?: string } | null)?.code === 'MergeConflictError'
}

function isMergeNotSupported(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'MergeNotSupportedError'
}

function isRejectedPush(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\[rejected\]|non-fast-forward|not a simple fast-forward/i.test(msg)
}

export class CloudSyncManager extends EventEmitter {
  private state: SyncState = 'idle'
  private status: SyncStatus = { state: 'idle' }
  private conflict: ConflictInfo | undefined

  /** 不缓存目录，每次惰性取（切工作空间无需重建实例） */
  private get workspaceDir(): string {
    return resolveActiveWorkspaceDir()
  }

  getStatus(): SyncStatus {
    return this.status
  }

  getConflict(): ConflictInfo | undefined {
    return this.conflict
  }

  /** 唯一同步入口，进程内串行；conflict/syncing 期间重入直接返回 */
  async sync(): Promise<{ success: boolean; state: SyncState }> {
    return enqueueWorkspace(this.workspaceDir, () => this.syncInner())
  }

  private async syncInner(): Promise<{ success: boolean; state: SyncState }> {
    const cfg = loadCloudSyncConfig()
    if (!cfg.enabled || !cfg.repoUrl || !cfg.tokenEnc) {
      this.setState('idle', '云同步未启用')
      return { success: false, state: 'idle' }
    }
    if (this.state === 'conflict') return { success: false, state: 'conflict' }
    if (this.state === 'syncing') return { success: false, state: 'syncing' }

    this.setState('syncing', '开始同步')
    try {
      const repo = getWorkspaceVcs(this.workspaceDir)
      const p = repo.getGitParams()
      const provider = getProvider(cfg.provider)
      const token = decryptToken(cfg.tokenEnc)
      const auth = (): ReturnType<AuthFn> => provider.auth(token)
      const url = cfg.repoUrl.trim()
      const branch = cfg.branch || 'main'
      const localRef = `refs/heads/${branch}`
      const remoteRef = `refs/remotes/origin/${branch}`

      // 1. 本地未提交变更先落 commit
      await repo.ensureInitialized()
      await repo.commit({ author: 'user', message: '云同步自动提交' })

      // 2. 确保 remote origin（force 覆盖 URL 变更）
      await git.addRemote({ ...p, remote: 'origin', url, force: true })

      // 3. fetch（远程分支不存在 → 首推）
      let remoteOid: string | null
      try {
        await git.fetch({ ...p, http, remote: 'origin', ref: branch, singleBranch: true, onAuth: auth })
        remoteOid = await git.resolveRef({ ...p, ref: remoteRef })
      } catch {
        remoteOid = null
      }

      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' })

      // 4. 首推
      if (remoteOid === null) {
        await this.push(p, url, localRef, auth)
        this.setState('idle', '首次推送完成')
        return { success: true, state: 'idle' }
      }
      if (remoteOid === localOid) {
        this.setState('idle', '已是最新')
        return { success: true, state: 'idle' }
      }

      // 5. commit 图关系判定（findMergeBase 入参是 oids，返回数组）
      const baseOids = await git.findMergeBase({ ...p, oids: [localOid, remoteOid] })

      if (baseOids.length === 0) {
        // 无关历史：新设备首同步 → 远端为准，先备份
        await this.adoptRemote(p, localRef, remoteOid)
        this.setState('idle', '已采用远端历史作为本地主线')
        return { success: true, state: 'idle' }
      }
      if (baseOids.length > 1) {
        // criss-cross：isomorphic-git 无递归合并，人工介入
        this.setState('error', '检测到交叉合并历史，暂不支持自动同步')
        return { success: false, state: 'error' }
      }
      const baseOid = baseOids[0]

      if (baseOid === remoteOid) {
        // 仅本地新 → 直接 push
        await this.push(p, url, localRef, auth)
        this.setState('idle', '同步完成')
        return { success: true, state: 'idle' }
      }
      if (baseOid === localOid) {
        // 仅远程新 → 本地快进（writeRef + checkout；不用 git.fastForward，它会重新 _pull 需 http）
        await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
        await git.checkout({ ...p, ref: localRef, force: true })
        this.setState('idle', '已拉取远程变更')
        return { success: true, state: 'idle' }
      }

      // 双方都新 → 尝试 merge（默认 abortOnConflict，冲突时干净抛出带 filepaths）
      try {
        await git.merge({
          ...p,
          ours: 'HEAD',
          theirs: remoteRef,
          author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
          message: '合并远程变更',
        })
      } catch (err) {
        if (isMergeConflict(err)) {
          return this.enterConflict(err.data, localOid, remoteOid, baseOid)
        }
        if (isMergeNotSupported(err)) {
          this.setState('error', '冲突类型暂不支持自动合并（新增文件/重命名），请手动处理')
          return { success: false, state: 'error' }
        }
        throw err
      }

      // merge 只更新 index + 建提交，不回写工作树，需 checkout 物化合并结果
      await git.checkout({ ...p, ref: 'HEAD', force: true })
      await this.push(p, url, localRef, auth)
      this.setState('idle', '同步完成')
      return { success: true, state: 'idle' }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const token = decryptToken(cfg.tokenEnc)
      const safeReason = token ? reason.split(token).join('***') : reason
      logger.error(`[sync] 同步失败: ${safeReason}`)
      this.setState('error', safeReason)
      return { success: false, state: 'error' }
    }
  }

  /** 推送；被拒不强推，等下轮（remote 又变） */
  private async push(p: GitParams, url: string, localRef: string, auth: AuthFn): Promise<void> {
    try {
      await git.push({ ...p, http, remote: 'origin', ref: localRef, remoteRef: localRef, onAuth: auth })
    } catch (err) {
      if (isRejectedPush(err)) {
        logger.warn('[sync] 远程有更新，下轮重试')
        return
      }
      throw err
    }
  }

  /** 无关历史：备份本地 → 分支钉到远端 HEAD → checkout 远端内容 */
  private async adoptRemote(p: GitParams, localRef: string, remoteOid: string): Promise<void> {
    const backupDir = `${this.workspaceDir}.lumii-sync-backup-${Date.now()}`
    fs.cpSync(this.workspaceDir, backupDir, {
      recursive: true,
      filter: (src) => !src.includes('.mtbot-vcs'),
    })
    logger.warn(`[adoptRemote] 检测到无关历史，本地已备份到 ${backupDir}`)
    await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
    await git.checkout({ ...p, ref: remoteOid, force: true })
    logger.info('[adoptRemote] 已采用远端历史作为本地主线')
  }

  private enterConflict(
    data: MergeConflictErrorData,
    localOid: string,
    remoteOid: string,
    baseOid: string,
  ): { success: false; state: 'conflict' } {
    this.conflict = {
      files: data.filepaths ?? [],
      bothModified: data.bothModified ?? [],
      deleteByUs: data.deleteByUs ?? [],
      deleteByTheirs: data.deleteByTheirs ?? [],
      localOid,
      remoteOid,
      baseOid,
    }
    this.status.conflict = this.conflict
    this.setState('conflict', `检测到 ${this.conflict.files.length} 个冲突文件，等待 Agent 处理`)
    return { success: false, state: 'conflict' }
  }

  /** Agent 落决：选侧 checkout → 双亲 commit → push */
  async resolveConflict(
    strategy: 'keep-local' | 'keep-remote' | 'per-file',
    choices?: { path: string; side: 'local' | 'remote' }[],
  ): Promise<{ success: boolean; error?: string }> {
    return enqueueWorkspace(this.workspaceDir, () => this.resolveInner(strategy, choices))
  }

  private async resolveInner(
    strategy: 'keep-local' | 'keep-remote' | 'per-file',
    choices?: { path: string; side: 'local' | 'remote' }[],
  ): Promise<{ success: boolean; error?: string }> {
    const c = this.conflict
    if (!c) return { success: false, error: '当前无冲突' }

    const cfg = loadCloudSyncConfig()
    const branch = cfg.branch || 'main'
    const localRef = `refs/heads/${branch}`
    const remoteRef = `refs/remotes/origin/${branch}`
    const token = decryptToken(cfg.tokenEnc)
    const auth = (): ReturnType<AuthFn> => getProvider(cfg.provider).auth(token)
    const p = getWorkspaceVcs(this.workspaceDir).getGitParams()

    try {
      for (const f of c.files) {
        const side = strategy === 'per-file'
          ? (choices?.find((x) => x.path === f)?.side ?? 'local')
          : strategy === 'keep-local'
            ? 'local'
            : 'remote'
        await git.checkout({
          ...p,
          ref: side === 'local' ? 'HEAD' : remoteRef,
          filepaths: [f],
          force: true,
          noUpdateHead: true,
        })
      }
      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' })
      const remoteOid = await git.resolveRef({ ...p, ref: remoteRef })
      await git.commit({
        ...p,
        ref: localRef,
        message: `解决云同步冲突（${strategy}）`,
        parent: [localOid, remoteOid],
        author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
      })
      await this.push(p, cfg.repoUrl.trim(), localRef, auth)
      this.conflict = undefined
      this.status.conflict = undefined
      this.setState('idle', '冲突已解决')
      return { success: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const safeReason = token ? reason.split(token).join('***') : reason
      logger.error(`[resolveConflict] 解决失败: ${safeReason}`)
      return { success: false, error: safeReason }
    }
  }

  /** 读三方任一版本内容，供 Agent 判断 */
  async readFileAt(oid: 'local' | 'remote' | 'base', filepath: string): Promise<string | null> {
    const c = this.conflict
    if (!c) return null
    const ref = oid === 'local' ? 'HEAD' : oid === 'remote' ? `refs/remotes/origin/${loadCloudSyncConfig().branch || 'main'}` : c.baseOid
    return getWorkspaceVcs(this.workspaceDir).readFileAt(ref, filepath)
  }

  private setState(state: SyncState, message: string): void {
    this.state = state
    this.status = {
      ...this.status,
      state,
      message,
      lastSyncAt: state === 'idle' ? Date.now() : this.status.lastSyncAt,
      lastError: state === 'error' ? message : undefined,
    }
    this.emit('status', this.status)
    appendSyncLog(state, message)
    logger.info(`[状态变更] ${state}: ${message}`)
  }
}
