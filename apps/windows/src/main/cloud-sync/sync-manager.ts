/**
 * CloudSyncManager — 云同步主流程。
 *
 * Git 仓库位于 `~/.lumii/sync`（syncDir）；与 Turn 快照通过 enqueueWorkspace 串行，
 * 避免并发操作 index/HEAD。冲突读写/落决必须使用 getSyncGitParams()，禁止落到工作区 .mtbot-vcs。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import git from 'isomorphic-git'
import type { PromiseFsClient } from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { enqueueWorkspace } from '../workspace-vcs/vcs-snapshot'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { createLogger } from '../logger'
import { getProvider } from './git-provider'
import { loadCloudSyncConfig, decryptToken } from './sync-config'
import { appendSyncLog } from './sync-log'
import type { SyncState, SyncStatus, ConflictInfo } from './types'
import { SyncExporter } from './sync-exporter'
import { SyncImporter } from './sync-importer'

const logger = createLogger('cloud-sync/manager')
const execFileAsync = promisify(execFile)

/** push 超时，避免 Agent 工具永久挂起（错误仓库或超大对象库时） */
const PUSH_TIMEOUT_MS = 120_000

/**
 * 冲突落决总超时。
 * sync/.git 若因重复 fetch 膨胀到数 GB，全量 checkout/push 可能卡数十分钟；
 * 必须让 Agent 工具在有限时间内返回，否则 UI 一直停在「正在调用 resolve_sync_conflict」。
 */
const RESOLVE_TIMEOUT_MS = 90_000

/** 冲突落决路径上的 push 超时（短于总超时，给 import/收尾留余量） */
const RESOLVE_PUSH_TIMEOUT_MS = 60_000

/** isomorphic-git 每次 fetch 会新增 pack；超过此数量则触发系统 git gc */
const PACK_GC_THRESHOLD = 3

type GitParams = { fs: PromiseFsClient; dir: string; gitdir: string }

type AuthFn = () => { username: string; password: string }

type PushOptions = {
  /** true：被拒时抛错（冲突落决必须成功推送，禁止假成功） */
  failOnReject?: boolean
  /** 覆盖默认 PUSH_TIMEOUT_MS */
  timeoutMs?: number
}

/**
 * 给 Promise 加超时；超时后原 Promise 仍可能在后台继续，但调用方立即收到错误。
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer)
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

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
  private onConflictDetected?: (conflict: ConflictInfo) => void

  /** 不缓存目录，每次惰性取（切工作空间无需重建实例） */
  private get workspaceDir(): string {
    return resolveActiveWorkspaceDir()
  }

  /** sync 目录（新的同步数据目录） */
  private get syncDir(): string {
    const clientRoot = resolveWindowsClientDataRoot()
    return path.join(clientRoot, 'sync')
  }

  /** 数据目录 */
  private get dataDir(): string {
    const clientRoot = resolveWindowsClientDataRoot()
    return path.join(clientRoot, 'data')
  }

  /** 数据库路径 */
  private get dbPath(): string {
    return path.join(this.dataDir, 'agent-runtime.db')
  }

  /** syncDir 仓库的 git 参数（冲突读写/落决必须用此，禁止落到工作区 .mtbot-vcs） */
  private getSyncGitParams(): GitParams {
    return {
      fs,
      dir: this.syncDir,
      gitdir: path.join(this.syncDir, '.git'),
    }
  }

  /** 设置冲突检测回调（由 main/index.ts 注入，用于创建自主目标） */
  setOnConflictDetected(callback: (conflict: ConflictInfo) => void): void {
    this.onConflictDetected = callback
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
      // 确保 sync 目录存在
      if (!fs.existsSync(this.syncDir)) {
        fs.mkdirSync(this.syncDir, { recursive: true })
      }

      // 使用 sync 目录作为 Git 仓库
      const p = this.getSyncGitParams()

      const provider = getProvider(cfg.provider)
      const token = decryptToken(cfg.tokenEnc)
      const auth = (): ReturnType<AuthFn> => provider.auth(token)
      const url = cfg.repoUrl.trim()
      const branch = cfg.branch || 'main'
      const localRef = `refs/heads/${branch}`
      const remoteRef = `refs/remotes/origin/${branch}`

      // 1. 初始化 Git 仓库（如果不存在）
      if (!fs.existsSync(path.join(this.syncDir, '.git'))) {
        await git.init({ ...p, defaultBranch: branch })
        logger.info('[sync] 初始化 Git 仓库')
      }

      // 1.5 写入 .gitignore
      this.ensureSyncGitignore()

      // 2. 确保 remote origin
      try {
        await git.addRemote({ ...p, remote: 'origin', url, force: true })
      } catch (err) {
        // 已存在，忽略
      }

      // ===== 新流程：fetch → import → export → push =====

      // 3. fetch 远端
      logger.info('[sync] 1. Fetch 远端数据...')
      let remoteOid: string | null
      try {
        await git.fetch({ ...p, http, remote: 'origin', ref: branch, singleBranch: true, onAuth: auth })
        remoteOid = await git.resolveRef({ ...p, ref: remoteRef })
      } catch {
        remoteOid = null
      }

      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null)

      // 4. 首次推送（远端为空）
      if (remoteOid === null) {
        logger.info('[sync] 远端为空，准备首次推送')
        // 导出 → 提交 → 推送
        await this.exportAndCommit(p)
        await this.push(p, url, localRef, auth)
        return this.finishIdle('首次推送完成')
      }

      // 5. 本地无提交（首次拉取）
      if (!localOid) {
        logger.info('[sync] 本地无提交，拉取远端')
        await git.fetch({ ...p, http, remote: 'origin', ref: branch, onAuth: auth })
        await git.checkout({ ...p, ref: branch, force: true })
        await this.importData()
        return this.finishIdle('已拉取远程数据')
      }

      // 6. 判断远端和本地的关系
      const baseOids = await git.findMergeBase({ ...p, oids: [localOid, remoteOid] })

      if (baseOids.length === 0) {
        // 无关历史：采用远端
        await this.adoptRemote(p, localRef, remoteOid)
        await this.importData()
        return this.finishIdle('已采用远端历史作为本地主线')
      }

      const baseOid = baseOids[0]

      // 7. 远端无变化（仅本地新）
      if (baseOid === remoteOid) {
        logger.info('[sync] 仅本地有新提交')
        // 导出 → 提交 → 推送
        await this.exportAndCommit(p)
        await this.push(p, url, localRef, auth)
        return this.finishIdle('同步完成')
      }

      // 8. 本地无变化（仅远端新）
      if (baseOid === localOid) {
        logger.info('[sync] 仅远端有新提交，快进合并')
        await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
        await git.checkout({ ...p, ref: localRef, force: true })
        await this.importData()
        return this.finishIdle('已拉取远程变更')
      }

      // 9. 双方都有新提交 → merge → import → export → push
      logger.info('[sync] 双方都有新提交，执行三方合并')

      // 9.1 先尝试 merge（可能产生冲突）
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

      await git.checkout({ ...p, ref: 'HEAD', force: true })

      // 9.2 导入远端数据（merge 后的文件包含远端更新）
      await this.importData()

      // 9.3 导出当前状态（包含本地+远端合并后的结果）
      await this.exportAndCommit(p)

      // 9.4 推送
      await this.push(p, url, localRef, auth)

      return this.finishIdle('同步完成')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const token = decryptToken(cfg.tokenEnc)
      const safeReason = token ? reason.split(token).join('***') : reason
      logger.error(`[sync] 同步失败: ${safeReason}`)
      this.setState('error', safeReason)
      return { success: false, state: 'error' }
    }
  }

  /** 确保 sync 目录有 .gitignore，忽略导出时每次都会重写时间戳的 .sync-manifest.json */
  private ensureSyncGitignore(): void {
    const gitignorePath = path.join(this.syncDir, '.gitignore')
    const ignoreLine = '.sync-manifest.json'
    let content: string
    try {
      content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
    } catch {
      content = ''
    }
    // 已含该规则则跳过，避免覆盖用户自定义内容
    if (content.split(/\r?\n/).some((l) => l.trim() === ignoreLine)) return
    const sep = content && !content.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(gitignorePath, content + sep + ignoreLine + '\n')
    logger.info('[sync] 已写入 .gitignore 忽略同步清单')
  }

  /**
   * isomorphic-git 每次 fetch 都会落一份新 pack，不会自动 gc。
   * pack 数超过阈值时调用系统 git gc，避免对象库滚到数十 GB 拖死冲突落决。
   */
  private async maybePruneObjectStore(): Promise<void> {
    const packDir = path.join(this.syncDir, '.git', 'objects', 'pack')
    let packCount = 0
    try {
      packCount = fs
        .readdirSync(packDir)
        .filter((name) => name.endsWith('.pack'))
        .length
    } catch {
      return
    }
    if (packCount <= PACK_GC_THRESHOLD) return

    logger.warn(`[maybePruneObjectStore] 检测到 ${packCount} 个 pack（阈值 ${PACK_GC_THRESHOLD}），执行 git gc…`)
    try {
      await execFileAsync('git', ['gc', '--prune=now'], {
        cwd: this.syncDir,
        timeout: 180_000,
        windowsHide: true,
      })
      logger.info('[maybePruneObjectStore] git gc 完成')
    } catch (err) {
      logger.warn(
        `[maybePruneObjectStore] git gc 失败（可忽略，不影响同步）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  /** 成功收尾：先尝试压缩 pack，再切回 idle */
  private async finishIdle(message: string): Promise<{ success: true; state: 'idle' }> {
    await this.maybePruneObjectStore()
    this.setState('idle', message)
    return { success: true, state: 'idle' }
  }

  /**
   * 推送；普通 sync 被拒不强推等下轮；冲突落决传 failOnReject 禁止假成功。
   * 带超时，避免网络/错误仓库导致 Agent 工具永久挂起。
   */
  private async push(
    p: GitParams,
    _url: string,
    localRef: string,
    auth: AuthFn,
    opts?: PushOptions,
  ): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? PUSH_TIMEOUT_MS
    const pushPromise = git.push({
      ...p,
      http,
      remote: 'origin',
      ref: localRef,
      remoteRef: localRef,
      onAuth: auth,
    })
    try {
      await withTimeout(pushPromise, timeoutMs, `git push 超时（${timeoutMs}ms），已中止等待`)
    } catch (err) {
      if (isRejectedPush(err)) {
        if (opts?.failOnReject) throw err
        logger.warn('[sync] 远程有更新，下轮重试')
        return
      }
      throw err
    }
  }

  /** 无关历史：备份本地 → 分支钉到远端 HEAD → checkout 远端内容 */
  private async adoptRemote(p: GitParams, localRef: string, remoteOid: string): Promise<void> {
    const backupDir = `${this.syncDir}.lumii-sync-backup-${Date.now()}`
    try {
      // 使用 errorOnExist: true 选项，在 Windows 上遇到符号链接时会忽略而不是抛出 EPERM 错误
      fs.cpSync(this.syncDir, backupDir, {
        recursive: true,
        filter: (src) => !src.includes('.git'),
        // Windows 上复制符号链接需要管理员权限，使用 verbatimSymlinks: false 跟随链接而非复制它
        verbatimSymlinks: false,
      })
      logger.warn(`[adoptRemote] 检测到无关历史，本地已备份到 ${backupDir}`)
    } catch (err) {
      // 备份失败不应阻止同步，记录警告并继续
      logger.warn(`[adoptRemote] 备份失败（将继续同步）: ${err instanceof Error ? err.message : String(err)}`)
    }
    await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
    // 用分支名而非 oid checkout，避免 HEAD 进入 detached 状态（否则后续 commit 落到游离提交、push 推空）
    await git.checkout({ ...p, ref: localRef, force: true })
    logger.info('[adoptRemote] 已采用远端历史作为本地主线')
  }

  /**
   * 导出数据并提交（如果有变更）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 在事务中导出，确保一致性快照
   * - 导出后检查 git status，有变更才提交
   */
  private async exportAndCommit(p: GitParams): Promise<void> {
    logger.info('[exportAndCommit] 导出数据到 sync/...')
    const exporter = new SyncExporter({
      dbPath: this.dbPath,
      syncDir: this.syncDir,
      workspaceDir: this.workspaceDir,
      dataDir: this.dataDir,
    })
    const exportResult = await exporter.export()
    if (!exportResult.success) {
      logger.warn(`[exportAndCommit] 导出有错误: ${exportResult.errors.join(', ')}`)
    }

    // 检查是否有变更
    const status = await git.statusMatrix({ ...p })
    const hasChanges = status.some(([_, head, workdir, stage]) => head !== workdir || workdir !== stage)

    if (hasChanges) {
      // 添加所有文件
      await git.add({ ...p, filepath: '.' })

      // 提交
      await git.commit({
        ...p,
        message: `sync: merge and export at ${new Date().toISOString()}`,
        author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
      })
      logger.info('[exportAndCommit] 已提交本地变更')
    } else {
      logger.info('[exportAndCommit] 无变更需要提交')
    }
  }

  /**
   * 导入数据（从 sync/ 目录）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 按时间戳merge规则合并远端数据到本地数据库
   * - 在事务中执行，确保一致性
   */
  private async importData(): Promise<void> {
    try {
      logger.info('[importData] 导入远程数据...')
      const importer = new SyncImporter({
        dbPath: this.dbPath,
        syncDir: this.syncDir,
        workspaceDir: this.workspaceDir,
        dataDir: this.dataDir,
      })
      const result = await importer.import()
      if (result.success) {
        logger.info(`[importData] 导入成功: Wiki=${result.stats.wikiRows}, 记忆=${result.stats.memoriesImported}`)
      } else {
        logger.warn(`[importData] 导入有错误: ${result.errors.join(', ')}`)
      }
    } catch (err) {
      logger.error('[importData] 导入失败:', err)
      // 导入失败不应阻止同步流程
    }
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

    // 触发冲突回调，由外部（main/index.ts）创建自主目标让 Agent 处理
    if (this.onConflictDetected) {
      try {
        this.onConflictDetected(this.conflict)
      } catch (err) {
        logger.warn('[enterConflict] 冲突回调失败:', err instanceof Error ? err.message : String(err))
      }
    }

    return { success: false, state: 'conflict' }
  }

  /** Agent 落决：选侧 checkout → 双亲 commit → push */
  async resolveConflict(
    strategy: 'keep-local' | 'keep-remote' | 'per-file',
    choices?: { path: string; side: 'local' | 'remote' }[],
  ): Promise<{ success: boolean; error?: string }> {
    return enqueueWorkspace(this.workspaceDir, () =>
      withTimeout(
        this.resolveInner(strategy, choices),
        RESOLVE_TIMEOUT_MS,
        `解决冲突超时（${RESOLVE_TIMEOUT_MS}ms）。若 ~/.lumii/sync/.git 体积过大，请清理后重试或暂时关闭云同步。`,
      ).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err)
        logger.error(`[resolveConflict] 解决失败: ${reason}`)
        this.recordConflictResolutionFailure(reason)
        return { success: false as const, error: reason }
      }),
    )
  }

  /** 标记 Agent 开始处理冲突（仅更新 message + 日志，state 保持 conflict） */
  markConflictProcessing(): void {
    if (this.state !== 'conflict') return
    this.setState('conflict', `Agent 正在处理 ${this.conflict?.files.length ?? 0} 个冲突文件…`)
  }

  /** 记录一次 Agent 处理冲突失败（保留 conflict 状态，记日志） */
  recordConflictResolutionFailure(reason: string): void {
    if (this.state !== 'conflict') return
    const safeReason = reason.length > 200 ? `${reason.slice(0, 200)}…` : reason
    logger.error(`[冲突处理] Agent 处理失败: ${safeReason}`)
    this.setState('conflict', `Agent 处理冲突失败：${safeReason}`)
  }

  /**
   * 将 HEAD 挂回本地分支，不重写整个工作树。
   * 全量 `git.checkout({ force: true })` 在对象库膨胀（多 GB pack）时会卡数十分钟，
   * 导致 resolve_sync_conflict 工具无响应；冲突文件已在落决循环中按需 checkout。
   */
  private async attachHeadToBranch(p: GitParams, localRef: string): Promise<void> {
    const headPath = path.join(p.gitdir, 'HEAD')
    await fs.promises.writeFile(headPath, `ref: ${localRef}\n`, 'utf8')
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
    // 必须操作 syncDir，与 syncInner / 冲突文件路径一致（禁止工作区 .mtbot-vcs）
    const p = this.getSyncGitParams()

    try {
      // 冲突快照里已有 remoteOid：即使 tracking ref 丢失也要能落决（历史故障：Could not find refs/remotes/origin/main）
      try {
        await git.writeRef({ ...p, ref: remoteRef, value: c.remoteOid, force: true })
      } catch (err) {
        logger.warn(
          `[resolveConflict] 回写 ${remoteRef} 失败（继续用 oid）:`,
          err instanceof Error ? err.message : String(err),
        )
      }

      // 冲突后 HEAD 可能 detached：用冲突记录的 oid 作为两侧内容源（禁止再 resolveRef 远端）
      for (const f of c.files) {
        const side =
          strategy === 'per-file'
            ? (choices?.find((x) => x.path === f)?.side ?? 'local')
            : strategy === 'keep-local'
              ? 'local'
              : 'remote'
        const sideOid = side === 'local' ? c.localOid : c.remoteOid
        await git.checkout({
          ...p,
          ref: sideOid,
          filepaths: [f],
          force: true,
          noUpdateHead: true,
        })
        // 清掉 index 冲突 stage，否则双亲 commit 可能失败
        await git.add({ ...p, filepath: f })
      }
      await git.commit({
        ...p,
        ref: localRef,
        message: `解决云同步冲突（${strategy}）`,
        parent: [c.localOid, c.remoteOid],
        author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
      })
      // 挂回分支指针，避免 detached；禁止全量 force checkout（对象库过大时会挂死工具）
      await this.attachHeadToBranch(p, localRef)
      await this.push(p, cfg.repoUrl.trim(), localRef, auth, {
        failOnReject: true,
        timeoutMs: RESOLVE_PUSH_TIMEOUT_MS,
      })
      // 落决后把 sync 内容导回本地 data/workspace
      await this.importData()
      this.conflict = undefined
      this.status.conflict = undefined
      this.setState('idle', '冲突已解决')
      return { success: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const safeReason = token ? reason.split(token).join('***') : reason
      logger.error(`[resolveConflict] 解决失败: ${safeReason}`)
      this.recordConflictResolutionFailure(safeReason)
      return { success: false, error: safeReason }
    }
  }

  /** 读三方任一版本内容（syncDir），供 Agent 判断 */
  async readFileAt(side: 'local' | 'remote' | 'base', filepath: string): Promise<string | null> {
    const c = this.conflict
    if (!c) return null
    const p = this.getSyncGitParams()
    try {
      // remote 侧优先用冲突快照里的 remoteOid，避免 tracking ref 丢失时读失败
      const oid = side === 'base' ? c.baseOid : side === 'local' ? c.localOid : c.remoteOid
      const { blob } = await git.readBlob({ ...p, oid, filepath })
      return new TextDecoder().decode(blob)
    } catch {
      return null
    }
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
