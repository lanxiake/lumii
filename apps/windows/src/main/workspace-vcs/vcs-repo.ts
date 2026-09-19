/**
 * WorkspaceVcs — 工作空间本地 Git 版本管理
 *
 * 对 workspace 目录做快照、历史、diff 与回滚。元数据存于独立 gitdir
 * （{workspaceDir}/.mtbot-vcs），与用户可能存在的标准 .git 隔离。
 *
 * ## 实现：全部走真 git 子进程
 *
 * 这个模块曾经是**两种实现共用同一仓库**（真 git 暂存 + isomorphic-git 提交/读历史）。
 * 2026-09-19 复盘后把 isomorphic-git 整体摘除，原因是双实现共用的全部麻烦都来自
 * 「仓库形状必须迁就能力更弱的那一方」：
 *
 *  - iso 读 pack 是整个读进内存 → 要禁自动 gc、限单包尺寸、gc 后还要自检；
 *    绕开「禁 gc」的拆包脚本曾毁掉 1.3GB 历史。
 *  - iso 的 GitWalkerFs 会 lstat 整个工作树（含自定义 gitdir 自己）→ gitdir 里不能留
 *    瞬时文件，连 `git commit` 产生的 `index.lock` 都会撞出 `ENOENT: lstat`。
 *  - iso 跑在主线程上 → 冷路径（log/statusDiff/readBlob）大仓库上照样能卡到秒级，
 *    只是因为它「只在用户打开面板时跑」才没被算进卡死账。
 *
 * 摘掉之后这些约束全部消失，两条路径都在子进程里。代价是真 git 成为**硬依赖**
 * （已确认接受）：`detectGit()` 失败时本模块拒绝干活并给出明确日志，而不是退回一个
 * 会把主线程冻死的实现。
 *
 * ## 分工
 *
 *   vcs-git-cli.ts  写路径（暂存、排除规则、index 锁重试、仓库安全配置）
 *   git-ops.ts      读路径（历史、状态、diff、读 blob）+ 提交
 *   本文件          组装与对外契约（trailer 元信息、回滚、二进制跳过等）
 *
 * 设计要点见 .qoder/design/conversation-rewind-and-workspace-git/。
 */

import path from 'node:path'
import fs from 'node:fs'
import type {
  VcsCommit,
  VcsCommitOptions,
  VcsDiffEntry,
  VcsRollbackResult,
} from './types'
import { buildDefaultGitignore, stripOutputsIgnoreRules } from './vcs-ignore'
import { detectGit, pinNoAutoGc, runGit, stageAllCli } from './vcs-git-cli'
import {
  GIT_AUTHOR,
  commitCli,
  diffCommitsCli,
  diffFileCli,
  hasStagedChangesCli,
  initCli,
  listFilesAt,
  logCli,
  readBlobBytes,
  readFileAt,
  statusDiffCli,
  type RawLogEntry,
} from './git-ops'

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcs]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcs]', ...args),
  error: (...args: unknown[]) => console.error('[WorkspaceVcs]', ...args),
}

/** commit message 中嵌入元信息的 trailer 前缀 */
const TRAILER_CONV = 'Mtbot-Conversation:'
const TRAILER_RUN = 'Mtbot-Run:'
const TRAILER_AUTHOR = 'Mtbot-Author:'

/** 暂存耗时超过这个值就记一笔（正常约 76ms，劣化时要看得见） */
const STAGE_SLOW_MS = 500

/**
 * index 文件损坏（被截断、零填充或校验和不符）时的错误特征。
 *
 * 真 git 的措辞**不止一种**，实测撞到过：
 *   - 零填充（写到一半断电）→ `error: bad signature 0x00000000` + `fatal: index file corrupt`
 *   - 清空成 0 字节        → `fatal: index file smaller than expected`
 * 后三条是 isomorphic-git 的 —— 工作区已不再用 iso，认着不亏（多认不会误判）。
 */
const INDEX_CORRUPTION_HINTS = [
  'bad signature',
  'index file corrupt',
  'index file smaller than expected',
  'dircache',
  'Index file is empty',
  'Invalid checksum in GitIndex',
]

function isIndexCorruptionError(err: unknown): boolean {
  const segments: string[] = []
  if (err instanceof Error) segments.push(err.message)
  const data = (err as { data?: { message?: unknown } } | null)?.data
  if (typeof data?.message === 'string') segments.push(data.message)
  const text = segments.join(' ')
  return INDEX_CORRUPTION_HINTS.some((hint) => text.includes(hint))
}

export class WorkspaceVcs {
  private readonly workspaceDir: string
  private readonly gitdir: string
  private readonly indexPath: string

  constructor(opts: { workspaceDir: string }) {
    this.workspaceDir = opts.workspaceDir
    this.gitdir = path.join(opts.workspaceDir, '.mtbot-vcs')
    this.indexPath = path.join(this.gitdir, 'index')
  }

  /** 真 git 是否可用（进程级缓存）。不可用时本模块拒绝干活，见文件头。 */
  private isReady(): Promise<boolean> {
    return detectGit()
  }

  /**
   * 执行会读写 index 的 git 操作；若 index 已损坏，则删除后重试一次。
   *
   * index 只是可由工作树与 HEAD 完全重建的暂存缓存，删除它不会丢失任何提交，
   * 因此自愈远优于让后续每一次快照都失败刷屏。
   *
   * `onRepair`（可选）：删掉 index **之后**、重试之前跑。删除本身不够 ——
   * 空 index 会让 git 失去全部 stat 信息，把 HEAD 里每个文件都当成「已删除 +
   * 未跟踪」（实测 `git status` 对同一条路径同时输出 `D  x` 与 `?? x`），
   * 于是重试拿到的是一份**错误**结果而不是失败。需要重建 index 的调用方传这个钩子。
   */
  private async withIndexRepair<T>(
    label: string,
    op: () => Promise<T>,
    onRepair?: () => Promise<void>,
  ): Promise<T> {
    try {
      return await op()
    } catch (err) {
      if (!isIndexCorruptionError(err)) throw err
      const reason = err instanceof Error ? err.message : String(err)
      log.warn(`[${label}] index 文件已损坏，删除后重建：${reason}`)
      this.discardIndex()
      if (onRepair) await onRepair()
      return op()
    }
  }

  /**
   * 从 HEAD 重建 index（自愈用）。HEAD 未出生时无事可做 —— 那种情形本来就没有
   * 可恢复的暂存状态，下一次 `add -A` 会自然建出完整 index。
   */
  private async rebuildIndexFromHead(): Promise<void> {
    const r = await runGit(this.workspaceDir, this.gitdir, ['read-tree', 'HEAD'])
    if (r.code !== 0) {
      log.warn(`[rebuildIndexFromHead] 失败（退出码 ${r.code}）：${r.stderr.trim().slice(0, 160)}`)
    }
  }

  /**
   * 删除损坏的 index 及其锁。
   *
   * 锁也要删：index 坏掉时往往留下一个残留的 `index.lock`，只删 index 的话重试仍会
   * 失败（git 报 "Unable to create index.lock: File exists"）。两个都是可重建的暂存态。
   */
  private discardIndex(): void {
    try {
      fs.rmSync(this.indexPath, { force: true })
      fs.rmSync(`${this.indexPath}.lock`, { force: true })
    } catch (err) {
      log.warn('[discardIndex] 删除损坏的 index 失败:', err)
    }
  }

  private isInitialized(): boolean {
    return fs.existsSync(path.join(this.gitdir, 'HEAD'))
  }

  /**
   * 确保仓库存在：首次 init → 写 .gitignore → 首个 commit。
   * 幂等，可重复调用。已初始化时也会校正 .gitignore，确保 outputs/ 不被误忽略。
   *
   * 真 git 不可用时**直接返回**（不回退任何实现）：所有对外方法都以
   * `isInitialized()` 为前置判断，仓库建不起来就等于整个 VCS 静默关闭，
   * 只留一条 warn 说明原因。这是把「真 git」定为硬依赖后的明确取舍。
   */
  async ensureInitialized(): Promise<void> {
    if (!(await this.isReady())) {
      log.warn('[ensureInitialized] 真 git 不可用，工作区版本管理已停用')
      return
    }

    const gitignorePath = path.join(this.workspaceDir, '.gitignore')

    if (!this.isInitialized()) {
      log.info(`[ensureInitialized] 初始化工作空间仓库: ${this.workspaceDir}`)
      fs.mkdirSync(this.workspaceDir, { recursive: true })
      await initCli(this.workspaceDir, this.gitdir)

      // 写默认 .gitignore（若用户已有则不覆盖）
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, buildDefaultGitignore(), 'utf-8')
      }

      // 首个提交：即使工作区为空也建立 root commit，便于后续 diff/rollback。
      // `--allow-empty` 让空工作区也能落点（git-ops 的 commitCli 已带该参数）。
      const initMessage = this.buildMessage('初始化工作空间版本管理', 'user')
      await this.stageAndCommit(initMessage)
      log.info('[ensureInitialized] 完成，已建立初始提交')
    }

    // 把「本仓库不跑自动 gc」写死进仓库自身 config：本仓库规模敏感（工作区可达数 GB），
    // `gc --auto` 会在某次提交后顺带 repack，那是落在用户会话中间的一次不可预测 IO 尖峰。
    // 放在 if 之外：历史仓库同样需要这条。函数内按 gitdir 记忆，每进程最多一次子进程。
    await pinNoAutoGc(this.workspaceDir, this.gitdir)

    // 校正：去掉误忽略整个 outputs/ 的规则（Agent 产出需纳入版本管理）
    this.ensureOutputsTracked(gitignorePath)
  }

  /**
   * 若 .gitignore 中存在 `outputs/` 等目录级忽略，移除之并写回磁盘
   */
  private ensureOutputsTracked(gitignorePath: string): void {
    try {
      if (!fs.existsSync(gitignorePath)) return
      const raw = fs.readFileSync(gitignorePath, 'utf-8')
      const next = stripOutputsIgnoreRules(raw)
      if (next !== raw) {
        fs.writeFileSync(gitignorePath, next.endsWith('\n') ? next : `${next}\n`, 'utf-8')
        log.info('[ensureOutputsTracked] 已移除 .gitignore 中对 outputs/ 的目录级忽略')
      }
    } catch (err) {
      log.warn('[ensureOutputsTracked] 校正 .gitignore 失败:', err)
    }
  }

  /**
   * 暂存全部变更并提交；无变更返回 null。
   *
   * **热路径**：每个助手消息都会走到这里（bridge-instance-factory 的
   * onAssistantMessagePersisted）。真 git 的 index 自带 stat 缓存 + racy 判定，
   * 所以「无变更」场景也能便宜地走完（线上实测 76ms），不需要自己实现短路。
   *
   * 暂存与「有无变更」一起包进 withIndexRepair：坏 index 会让 `add -A` 直接 fatal，
   * 自愈后重跑即可。提交刻意留在外面 —— 它不读 index 的 stat 缓存，
   * 而重跑提交会产生重复提交。
   */
  private async stageAndCommit(message: string): Promise<string | null> {
    const t0 = Date.now()
    const hasChanges = await this.withIndexRepair(
      'stageAndCommit',
      async () => {
        await stageAllCli(this.workspaceDir, this.gitdir)
        return hasStagedChangesCli(this.workspaceDir, this.gitdir)
      },
      // 重建后重试。这里其实不重建也行（紧接着的 add -A 会把 index 建全），
      // 但统一走一条自愈路径比「每个调用点各自论证为什么可以不重建」更不容易错。
      () => this.rebuildIndexFromHead(),
    )
    if (!hasChanges) return null

    const oid = await commitCli(this.workspaceDir, this.gitdir, message, GIT_AUTHOR)
    const ms = Date.now() - t0
    if (ms > STAGE_SLOW_MS) log.info(`[stageAndCommit] 暂存并提交耗时 ${ms}ms`)
    return oid
  }

  /**
   * 提交当前工作区全量变更。无变更返回 null（不产生空提交）。
   *
   * 判断「有无变更」用的是 index 与 HEAD 的差异，而不是工作树 stat ——
   * 前者由 git 的 racy 判定兜底（内容变了就一定重算），后者在某些时序下会漏检。
   */
  async commit(opts: VcsCommitOptions): Promise<VcsCommit | null> {
    await this.ensureInitialized()
    if (!this.isInitialized()) return null

    const message = this.buildMessage(opts.message, opts.author, opts.conversationId, opts.runId)
    const oid = await this.stageAndCommit(message)
    if (!oid) {
      log.info('[commit] 工作区无变更，跳过提交')
      return null
    }
    log.info(`[commit] 已提交 oid=${oid.slice(0, 8)} author=${opts.author}`)

    return {
      oid,
      message: opts.message,
      timestamp: Date.now(),
      author: opts.author,
      conversationId: opts.conversationId,
      runId: opts.runId,
    }
  }

  /**
   * 工作区是否有未提交变更（相对 HEAD）。
   * 先暂存（让 index 反映工作树最新状态），再比对 index 与 HEAD。
   */
  async hasUncommittedChanges(): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.isInitialized()) return false
    return this.withIndexRepair(
      'hasUncommittedChanges',
      async () => {
        await stageAllCli(this.workspaceDir, this.gitdir)
        return hasStagedChangesCli(this.workspaceDir, this.gitdir)
      },
      () => this.rebuildIndexFromHead(),
    )
  }

  /**
   * 列出提交历史（按时间倒序，最新在前）。
   */
  async log(opts?: { limit?: number; offset?: number }): Promise<VcsCommit[]> {
    if (!this.isInitialized()) return []

    const limit = opts?.limit ?? 50
    const offset = opts?.offset ?? 0
    const entries = await logCli(this.workspaceDir, this.gitdir, limit + offset)

    return entries.slice(offset, offset + limit).map((e) => this.toCommit(e))
  }

  /**
   * 工作区相对某 commit（默认 HEAD）的文件级变更列表（不含 hunks）。
   * 二进制（如 outputs/*.pdf）跳过文本 diff，仅报告状态，避免把 PDF 当 UTF-8 解析拖垮面板。
   */
  async statusDiff(baseOid?: string): Promise<VcsDiffEntry[]> {
    if (!this.isInitialized()) return []
    return this.withIndexRepair(
      'statusDiff',
      () => statusDiffCli(this.workspaceDir, this.gitdir, baseOid ?? 'HEAD'),
      // 重建 index 后重试：光删 index 不够，空 index 会让 git 把 HEAD 里每个文件
      // 都报成「已删除 + 未跟踪」。这里**不调 stageAllCli** —— statusDiff 是只读的，
      // 它只报告「相对 HEAD 的变更」，不该顺手把工作树暂存进 index。
      () => this.rebuildIndexFromHead(),
    )
  }

  /**
   * 两个 commit 之间的文件级差异；withHunks=true 时附带逐行 hunks。
   */
  async diffCommits(
    fromOid: string,
    toOid: string,
    opts?: { withHunks?: boolean },
  ): Promise<VcsDiffEntry[]> {
    if (fromOid === toOid) return []
    return diffCommitsCli(this.workspaceDir, this.gitdir, fromOid, toOid, opts)
  }

  /**
   * 单文件逐行 diff。任一侧超过 MAX_DIFF_BYTES 则返回 truncated，不跑 Myers。
   * fromOid/toOid 可为 commit oid；toOid 也可为 'WORKTREE' 读工作区当前内容。
   */
  async diffFile(fromOid: string, toOid: string, filepath: string): Promise<VcsDiffEntry> {
    return diffFileCli(this.workspaceDir, this.gitdir, fromOid, toOid, filepath)
  }

  /**
   * 读取某 commit 下单个文件内容。文件不存在返回 null。
   */
  async readFileAt(oid: string, filepath: string): Promise<string | null> {
    return readFileAt(this.workspaceDir, this.gitdir, oid, filepath)
  }

  /**
   * 回滚整个工作区到指定 commit。
   * 安全：先把当前状态自动提交为备份点（可逆），再用目标版本内容覆盖工作树，
   * 最后追加一条线性回滚提交（不切换 HEAD，避免 detached HEAD 与 checkout 工作树语义坑）。
   */
  async rollbackTo(oid: string): Promise<VcsRollbackResult> {
    await this.ensureInitialized()

    // 1. 回滚前自动备份当前工作区（若有变更）
    const backup = await this.commit({
      author: 'user',
      message: '回滚前自动备份',
    })

    // 2. 用目标版本的文件内容覆盖工作树（纯内容回放，最可控）
    const targetFiles = await listFilesAt(this.workspaceDir, this.gitdir, oid)
    const currentFiles = await listFilesAt(this.workspaceDir, this.gitdir, 'HEAD')

    // 2a. 写回目标版本存在的文件
    for (const filepath of targetFiles) {
      const content = await readBlobBytes(this.workspaceDir, this.gitdir, oid, filepath)
      if (content === null) continue
      const abs = path.join(this.workspaceDir, filepath)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }

    // 2b. 删除目标版本不存在、但当前 tracked 的文件
    for (const filepath of currentFiles) {
      if (!targetFiles.has(filepath)) {
        const abs = path.join(this.workspaceDir, filepath)
        try {
          fs.rmSync(abs, { force: true })
        } catch {
          /* 忽略删除失败 */
        }
      }
    }

    // 3. 暂存并追加一条线性回滚提交（stageAndCommit 内部已含「无变更不提交」）
    const short = oid.slice(0, 8)
    await this.stageAndCommit(this.buildMessage(`已回滚至 ${short}`, 'user'))

    log.info(`[rollbackTo] 已回滚至 ${short}，备份点=${backup?.oid.slice(0, 8) ?? '无'}`)
    return { backupOid: backup?.oid ?? null, restoredOid: oid }
  }

  /**
   * 撤销单个文件到指定版本的内容（仅影响该文件，不动其他文件）。
   *
   * 用途：
   * - 撤销「未提交变更」中的某个文件 → 传 oid='HEAD'，把工作树该文件恢复到最近提交。
   * - 把某文件回退到历史某版本 → 传对应 commit oid。
   *
   * 行为：
   * - 目标版本存在该文件 → 用其内容覆盖工作树文件。
   * - 目标版本不存在该文件（说明该版本时尚未创建）→ 删除工作树中的该文件。
   * 不产生提交，调用方可在需要时再 commit。
   */
  async revertFile(oid: string, filepath: string): Promise<{ reverted: boolean }> {
    await this.ensureInitialized()
    const ref = oid === 'HEAD' || !oid ? 'HEAD' : oid
    const abs = path.join(this.workspaceDir, filepath)

    const content = await readBlobBytes(this.workspaceDir, this.gitdir, ref, filepath)
    if (content === null) {
      // 目标版本无此文件：删除工作树中的该文件（等价于撤销「新增」）
      try {
        fs.rmSync(abs, { force: true })
      } catch {
        /* 忽略删除失败 */
      }
      log.info(`[revertFile] ${filepath} 在 ${ref.slice(0, 8)} 不存在，已从工作树删除`)
      return { reverted: true }
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    log.info(`[revertFile] 已将 ${filepath} 恢复到 ${ref.slice(0, 8)}`)
    return { reverted: true }
  }

  /**
   * 查找匹配指定 conversationId 的最近提交（用于回溯联动）。
   * 返回最近一条匹配的 commit，没有匹配返回 null。
   */
  async findCommitByConversation(conversationId: string): Promise<VcsCommit | null> {
    if (!this.isInitialized()) return null
    const entries = await logCli(this.workspaceDir, this.gitdir, 100)
    for (const e of entries) {
      const convId = this.parseTrailer(e.body, TRAILER_CONV)
      if (convId === conversationId) return this.toCommit(e)
    }
    return null
  }

  // ─── 内部工具 ───

  /** 把 git-ops 的原始 log 记录转成对外的 VcsCommit（trailer → 结构化字段） */
  private toCommit(e: RawLogEntry): VcsCommit {
    return {
      oid: e.oid,
      message: e.subject,
      timestamp: e.tsSec * 1000,
      author: this.parseTrailer(e.body, TRAILER_AUTHOR) === 'agent' ? 'agent' : 'user',
      conversationId: this.parseTrailer(e.body, TRAILER_CONV),
      runId: this.parseTrailer(e.body, TRAILER_RUN),
    }
  }

  /** 把元信息以 trailer 形式拼到 commit message 末尾 */
  private buildMessage(
    message: string,
    author: 'agent' | 'user',
    conversationId?: string,
    runId?: string,
  ): string {
    const lines = [message, '', `${TRAILER_AUTHOR} ${author}`]
    if (conversationId) lines.push(`${TRAILER_CONV} ${conversationId}`)
    if (runId) lines.push(`${TRAILER_RUN} ${runId}`)
    return lines.join('\n')
  }

  private parseTrailer(message: string, key: string): string | undefined {
    for (const line of message.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith(key)) {
        return trimmed.slice(key.length).trim() || undefined
      }
    }
    return undefined
  }
}
