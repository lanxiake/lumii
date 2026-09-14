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
import git, { TREE } from 'isomorphic-git'
import type { PromiseFsClient, WalkerEntry } from 'isomorphic-git'
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
import type { FileChangeSet } from './sync-importer'

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

/**
 * 取 blob 型条目的 oid；目录条目与缺失条目一律返回 null。
 * 用于 git.walk 树差异：目录的 oid 是 tree oid，其内容变化由子条目各自体现。
 */
async function blobOid(entry: WalkerEntry | null): Promise<string | null> {
  if (!entry) return null
  if ((await entry.type()) !== 'blob') return null
  return (await entry.oid()) ?? null
}

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

  /** 轻量自动提交进行中（防重入；不改 state，state 归完整同步所有） */
  private localCommitInFlight = false

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

      // ===== 流程：export 本地 → fetch → merge → import → export → push =====
      // 用户文件方向的 export 必须早于 import：export 产生的 commit 就是三方合并的
      // ours（等价于 Unison 的 archive）。反过来先 import，会拿陈旧的 sync 内容覆盖
      // 本地尚未导出的改动。jsonl 那类「数据库生成物」才适用先 import 后 export。

      // 3. 先把本地改动固定成一次 commit（不 push），其 oid 作为本次合并基线
      logger.info('[sync] 1. 导出本地改动...')
      const baselineOid =
        (await this.exportAndCommit(p, { localEditsOnly: true })) ??
        (await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null))

      // 4. fetch 远端
      logger.info('[sync] 2. Fetch 远端数据...')
      let remoteOid: string | null
      try {
        await git.fetch({ ...p, http, remote: 'origin', ref: branch, singleBranch: true, onAuth: auth })
        remoteOid = await git.resolveRef({ ...p, ref: remoteRef })
      } catch {
        remoteOid = null
      }

      const localOid = await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null)

      // 5. 首次推送（远端为空）
      if (remoteOid === null) {
        logger.info('[sync] 远端为空，准备首次推送')
        await this.exportAndCommit(p)
        await this.push(p, url, localRef, auth)
        return this.finishIdle('首次推送完成')
      }

      // 6. 本地无 commit（全新设备）：只增不删地拉取远端
      if (!localOid) {
        logger.info('[sync] 本地无提交，拉取远端')
        await git.checkout({ ...p, ref: branch, force: true })
        await this.importData(p, null)
        return this.finishIdle('已拉取远程数据')
      }

      // 7. 判断远端和本地的关系
      const baseOids = await git.findMergeBase({ ...p, oids: [localOid, remoteOid] })

      if (baseOids.length === 0) {
        logger.info('[sync] 与远端历史无关，做双亲合并（保留本地）')
        await this.mergeUnrelatedHistory(p, localRef, localOid, remoteOid)
        await this.exportAndCommit(p)
        await this.push(p, url, localRef, auth)
        return this.finishIdle('已合并远端历史')
      }

      const baseOid = baseOids[0]

      // 8. 远端无变化（仅本地新）
      if (baseOid === remoteOid) {
        logger.info('[sync] 仅本地有新提交')
        await this.exportAndCommit(p)
        await this.push(p, url, localRef, auth)
        return this.finishIdle('同步完成')
      }

      // 9. 本地无变化（仅远端新）→ 快进
      if (baseOid === localOid) {
        logger.info('[sync] 仅远端有新提交，快进合并')
        await git.writeRef({ ...p, ref: localRef, value: remoteOid, force: true })
        await git.checkout({ ...p, ref: localRef, force: true })
        await this.importData(p, baselineOid)
        return this.finishIdle('已拉取远程变更')
      }

      // 10. 双方都有新提交 → merge → import → export → push
      logger.info('[sync] 双方都有新提交，执行三方合并')

      // 10.1 先尝试 merge（可能产生冲突）
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

      // 不带 force：本地改动已在步骤 3 落成 commit，工作树理应干净；
      // 若仍有未提交修改，宁可报错也不要静默丢弃
      await git.checkout({ ...p, ref: 'HEAD' })

      // 10.2 导入：jsonl 走时间戳 merge，用户文件走 git 树差异
      await this.importData(p, baselineOid)

      // 10.3 导出当前状态（本地 + 远端合并后的结果）
      await this.exportAndCommit(p)

      // 10.4 推送
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

  /**
   * 无关历史（首次同步且两边都有数据）：保留本地历史，与远端做双亲合并。
   *
   * 旧实现（adoptRemote）把分支直接钉到远端 HEAD，本地 git 历史丢失，
   * 本地独有文件只能靠 import 的「只增不删」侥幸留下。现在改为：
   * 远端独有的文件补入本地（**本地优先，同名不覆盖**），再提交一个
   * parent 为 [localOid, remoteOid] 的合并提交，两条历史都保留。
   *
   * 为什么不用 isomorphic-git 的 `merge({ allowUnrelatedHistories: true })`：
   * 它以**空树**作 merge base，于是两边都存在的同名文件一律判定为
   * 「双方各自新增且内容不同」→ 全部冲突。首次同步时同名文件往往几十个，
   * 会把冲突 Agent 拖进一个极重的任务。这里的语义是用户明确选择的
   * 「本地文件优先、远端文件补入」，无冲突且可预期。
   */
  private async mergeUnrelatedHistory(
    p: GitParams,
    localRef: string,
    localOid: string,
    remoteOid: string,
  ): Promise<void> {
    this.backupSyncDir()

    // 1. 远端独有的用户文件补入本地（本地已存在的同名文件一律不覆盖）
    await this.adoptRemoteOnlyFiles(p, localOid, remoteOid)

    // 2. 远端 jsonl 合入数据库（时间戳 merge，只动数据库不动文件）
    await this.importData(p, null)

    // 3. 把合并后的本地状态（本地 ∪ 远端）镜像进工作树
    const exporter = new SyncExporter({
      dbPath: this.dbPath,
      syncDir: this.syncDir,
      workspaceDir: this.workspaceDir,
      dataDir: this.dataDir,
    })
    await exporter.export()

    // 4. stage 后提交双亲 commit（不传 tree：commit 会从 index 生成，index 此刻就是本地状态）
    await this.stageAllChanges(p)
    await git.commit({
      ...p,
      ref: localRef,
      parent: [localOid, remoteOid],
      message: '合并无关历史的远端数据',
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    // 挂回分支指针，避免 detached（否则后续 commit 落到游离提交、push 推空）
    await this.attachHeadToBranch(p, localRef)
    logger.info('[mergeUnrelatedHistory] 已提交双亲合并，本地历史保留')
  }

  /**
   * 无关历史合并用：把远端相对本地**新增**的文件复制到本地。
   *
   * - 本地已存在同名文件 → 一律跳过（本地优先）
   * - 远端删除的文件 → 忽略（无关历史时「远端没有」不构成删除信号）
   */
  private async adoptRemoteOnlyFiles(
    p: GitParams,
    localOid: string,
    remoteOid: string,
  ): Promise<void> {
    const changes = await this.computeFileChanges(p, localOid, remoteOid)
    if (!changes || changes === 'all') return

    let adopted = 0
    for (const repoPath of changes.copy) {
      const localPath = this.toLocalPath(repoPath)
      if (!localPath) continue
      if (fs.existsSync(localPath)) continue
      try {
        const { blob } = await git.readBlob({ ...p, oid: remoteOid, filepath: repoPath })
        fs.mkdirSync(path.dirname(localPath), { recursive: true })
        fs.writeFileSync(localPath, Buffer.from(blob))
        adopted += 1
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn(`[adoptRemoteOnlyFiles] 补入失败已跳过: ${repoPath} (${msg})`)
      }
    }
    logger.info(`[adoptRemoteOnlyFiles] 补入远端独有文件 ${adopted} 个（本地同名文件全部保留）`)
  }

  /** 备份 sync 目录（无关历史合并前兜底；失败不阻断同步） */
  private backupSyncDir(): void {
    const backupDir = `${this.syncDir}.lumii-sync-backup-${Date.now()}`
    try {
      fs.cpSync(this.syncDir, backupDir, {
        recursive: true,
        filter: (src) => !src.includes('.git'),
        // Windows 上复制符号链接需要管理员权限，跟随链接而非复制它
        verbatimSymlinks: false,
      })
      logger.warn(`[backupSyncDir] 检测到无关历史，本地已备份到 ${backupDir}`)
    } catch (err) {
      logger.warn(`[backupSyncDir] 备份失败（将继续同步）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 计算两个提交之间所有路径的增删改。
   *
   * 这是删除传播的唯一依据 —— 不扫描目录做差集：只看两侧状态无法区分
   * 「本地删了」与「远端新增」，扫描式镜像会在首次同步时删空本地独有文件。
   *
   * @returns null 表示无可用基线（首次同步 / 无变化），调用方应退化为只增不删
   */
  private async computeFileChanges(
    p: GitParams,
    baselineOid: string | null,
    headOid: string | null,
  ): Promise<FileChangeSet | null> {
    if (!baselineOid || !headOid || baselineOid === headOid) return null

    const copy: string[] = []
    const deleted: string[] = []

    await git.walk({
      ...p,
      trees: [TREE({ ref: baselineOid }), TREE({ ref: headOid })],
      map: async (filepath, entries) => {
        // 注意：返回 undefined 不会剪枝子树，返回 null 才会 —— 这里必须返回 undefined
        if (filepath === '.') return
        const [before, after] = entries as Array<WalkerEntry | null>
        const beforeOid = await blobOid(before)
        const afterOid = await blobOid(after)
        if (beforeOid === afterOid) return
        if (afterOid === null) deleted.push(filepath)
        else copy.push(filepath)
      },
    })

    logger.info(`[computeFileChanges] 树差异：写入 ${copy.length} 项，删除 ${deleted.length} 项`)
    return { copy, delete: deleted }
  }

  /**
   * 把工作树的变化 stage 进 index，返回是否有变更。
   *
   * isomorphic-git 的 add 从目录遍历文件，**已删除的文件不在遍历结果里** ——
   * 删除必须显式 git.remove，否则永远进不了 commit（「删了又回来」的根因之一）。
   */
  private async stageAllChanges(p: GitParams): Promise<boolean> {
    const status = await git.statusMatrix({ ...p })
    const hasChanges = status.some(([, head, workdir, stage]) => head !== workdir || workdir !== stage)
    if (!hasChanges) return false

    for (const [filepath, head, workdir] of status) {
      if (head !== 0 && workdir === 0) {
        await git.remove({ ...p, filepath })
      }
    }
    await git.add({ ...p, filepath: '.' })
    return true
  }

  /**
   * sync 仓库内路径 → 本地绝对路径；不属于「用户文件类」时返回 null。
   * 与 exporter 的导入范围一一对应。
   */
  private toLocalPath(repoPath: string): string | null {
    const mappings: Array<{ prefix: string; base: string }> = [
      { prefix: 'profile/', base: this.dataDir },
      { prefix: 'workspace/files/', base: path.join(this.workspaceDir, 'files') },
      { prefix: 'workspace/outputs/', base: path.join(this.workspaceDir, 'outputs') },
    ]
    for (const { prefix, base } of mappings) {
      if (repoPath.startsWith(prefix)) return path.join(base, repoPath.slice(prefix.length))
    }
    return null
  }

  /**
   * 导出数据并提交（如果有变更）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - 在事务中导出，确保一致性快照
   * - 导出后检查 git status，有变更才提交（删除需显式 stage，见 stageAllChanges）
   *
   * @param opts.localEditsOnly 只导出 profile + workspace 用户文件，跳过数据库全量 dump。
   *        用于同步流程第 0 步 —— 把本地改动固定成三方合并的 ours，无需重写整份 jsonl。
   * @returns 新提交的 oid；无变更时返回 null
   */
  private async exportAndCommit(
    p: GitParams,
    opts?: { localEditsOnly?: boolean },
  ): Promise<string | null> {
    logger.info(`[exportAndCommit] 导出数据到 sync/${opts?.localEditsOnly ? '（仅用户文件类）' : ''}...`)
    const exporter = new SyncExporter({
      dbPath: this.dbPath,
      syncDir: this.syncDir,
      workspaceDir: this.workspaceDir,
      dataDir: this.dataDir,
    })
    const exportResult = opts?.localEditsOnly
      ? await exporter.exportLocalEdits()
      : await exporter.export()
    if (!exportResult.success) {
      logger.warn(`[exportAndCommit] 导出有错误: ${exportResult.errors.join(', ')}`)
    }

    const hasChanges = await this.stageAllChanges(p)
    if (!hasChanges) {
      logger.info('[exportAndCommit] 无变更需要提交')
      return null
    }

    const oid = await git.commit({
      ...p,
      message: `sync: export at ${new Date().toISOString()}`,
      author: { name: 'Lumii CloudSync', email: 'sync@lumii.local' },
    })
    logger.info(`[exportAndCommit] 已提交本地变更 ${oid.slice(0, 8)}`)
    return oid
  }

  /**
   * 文件监听触发的轻量提交：只把本地用户文件类改动导出并提交，不 fetch、不 push。
   *
   * 与 sync() 共用同一串行队列；不改 state —— state 归完整同步所有，
   * 否则会和 watcher 自身的抑制条件（state !== idle 即抑制）互相打架。
   */
  async commitLocalChanges(): Promise<boolean> {
    const cfg = loadCloudSyncConfig()
    if (!cfg.enabled || !cfg.repoUrl) return false

    return enqueueWorkspace(this.workspaceDir, async () => {
      // 队列内重新判定：同步可能已在此期间占用了 state
      if (this.state !== 'idle') return false
      if (this.localCommitInFlight) return false
      this.localCommitInFlight = true
      try {
        const p = this.getSyncGitParams()
        if (!fs.existsSync(path.join(this.syncDir, '.git'))) return false
        const oid = await this.exportAndCommit(p, { localEditsOnly: true })
        if (oid) logger.info(`[commitLocalChanges] 自动提交 ${oid.slice(0, 8)}`)
        return oid !== null
      } catch (err) {
        // 失败不抛出：变更仍留在本地，下一次完整同步的步骤 0 会兜底
        logger.warn(
          `[commitLocalChanges] 自动提交失败（下次同步兜底）: ${err instanceof Error ? err.message : String(err)}`,
        )
        return false
      } finally {
        this.localCommitInFlight = false
      }
    })
  }

  /**
   * 导入数据（从 sync/ 目录）
   *
   * 设计：docs/superpowers/specs/2026-09-09-lightweight-cloud-sync-design.md
   * - jsonl 按时间戳 merge 规则合并到本地数据库，在事务中执行
   * - 用户文件按 git 树差异应用（新增/修改复制、删除删除），**不做目录扫描式镜像**
   *
   * @param baselineOid 本次合并前的本地 HEAD，用于算出「远端带来的用户文件变更」。
   *        传 null 时退化为只增不删（首次同步 / 本地无 commit）。
   */
  private async importData(p: GitParams, baselineOid: string | null): Promise<void> {
    try {
      logger.info('[importData] 导入远程数据...')

      const headOid = await git.resolveRef({ ...p, ref: 'HEAD' }).catch(() => null)
      let fileChanges: FileChangeSet = 'all'
      try {
        fileChanges = (await this.computeFileChanges(p, baselineOid, headOid)) ?? 'all'
      } catch (err) {
        // 树差异算不出时退化为只增不删：宁可删除不传播，也不能用不可信的差异去删本地文件
        logger.warn(
          `[importData] 树差异计算失败，本次退化为只增不删: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const importer = new SyncImporter({
        dbPath: this.dbPath,
        syncDir: this.syncDir,
        workspaceDir: this.workspaceDir,
        dataDir: this.dataDir,
      })
      const result = await importer.import({ fileChanges })
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
      // 落决后把 sync 内容导回本地 data/workspace：
      // 以冲突时的本地 oid 为基线，选 keep-remote 的文件会复制回本地，keep-local 的为 no-op
      await this.importData(p, c.localOid)
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
