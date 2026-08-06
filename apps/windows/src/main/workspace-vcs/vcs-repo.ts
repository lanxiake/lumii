/**
 * WorkspaceVcs — 工作空间本地 Git 版本管理
 *
 * 基于 isomorphic-git（纯 JS，零系统 git 依赖）对 workspace 目录做快照、
 * 历史、diff 与回滚。元数据存于独立 gitdir（{workspaceDir}/.mtbot-vcs），
 * 与用户可能存在的标准 .git 隔离。
 *
 * 设计要点见 .qoder/design/conversation-rewind-and-workspace-git/。
 */

import path from 'node:path'
import fs from 'node:fs'
import git from 'isomorphic-git'
import type {
  VcsCommit,
  VcsCommitOptions,
  VcsDiffEntry,
  VcsFileStatus,
  VcsRollbackResult,
} from './types'
import { buildDefaultGitignore, VCS_SKIP_DIRS } from './vcs-ignore'
import { computeFileDiff, computeDiffStats, MAX_DIFF_BYTES } from './vcs-diff'

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcs]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcs]', ...args),
  error: (...args: unknown[]) => console.error('[WorkspaceVcs]', ...args),
}

/** commit message 中嵌入元信息的 trailer 前缀 */
const TRAILER_CONV = 'Mtbot-Conversation:'
const TRAILER_RUN = 'Mtbot-Run:'
const TRAILER_AUTHOR = 'Mtbot-Author:'

/** 提交身份（isomorphic-git 要求 author/committer） */
const GIT_AUTHOR = { name: 'Mtbot', email: 'vcs@mtbot.local' } as const

export class WorkspaceVcs {
  private readonly workspaceDir: string
  private readonly gitdir: string

  constructor(opts: { workspaceDir: string }) {
    this.workspaceDir = opts.workspaceDir
    this.gitdir = path.join(opts.workspaceDir, '.mtbot-vcs')
  }

  /** isomorphic-git 通用参数 */
  private get base() {
    return { fs, dir: this.workspaceDir, gitdir: this.gitdir }
  }

  /** 仓库是否已初始化 */
  private isInitialized(): boolean {
    return fs.existsSync(path.join(this.gitdir, 'HEAD'))
  }

  /**
   * 确保仓库存在：首次 init → 写 .gitignore → 首个 commit。
   * 幂等，可重复调用。
   */
  async ensureInitialized(): Promise<void> {
    if (this.isInitialized()) return

    log.info(`[ensureInitialized] 初始化工作空间仓库: ${this.workspaceDir}`)
    fs.mkdirSync(this.workspaceDir, { recursive: true })
    await git.init({ ...this.base, defaultBranch: 'main' })

    // 写默认 .gitignore（若用户已有则不覆盖）
    const gitignorePath = path.join(this.workspaceDir, '.gitignore')
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, buildDefaultGitignore(), 'utf-8')
    }

    // 首个 commit（即使工作区为空也建立 root commit，便于后续 diff/rollback）
    await this.stageAll()
    await git.commit({
      ...this.base,
      message: this.buildMessage('初始化工作空间版本管理', 'user'),
      author: GIT_AUTHOR,
    })
    log.info('[ensureInitialized] 完成，已建立初始提交')
  }

  /**
   * 暂存工作区全部变更（含新增、修改、删除），遵循 .gitignore。
   *
   * 不依赖 statusMatrix 的 worktree 列（其 stat 快速路径会漏检同秒同大小的小文件），
   * 而是：① 递归 walk 工作树实际文件并逐个 git.add（add 内部按内容重算 blob hash）；
   *       ② 对 HEAD/index 中存在但工作树已不存在的文件执行 git.remove。
   */
  private async stageAll(): Promise<void> {
    // ① 收集工作树实际文件（相对路径，POSIX 分隔），并 add
    const worktreeFiles = await this.walkWorktreeFiles()
    for (const filepath of worktreeFiles) {
      const ignored = await git.isIgnored({ ...this.base, filepath }).catch(() => false)
      if (ignored) continue
      await git.add({ ...this.base, filepath })
    }

    // ② 处理删除：index/HEAD 有、但工作树已无的文件
    const matrix = await git.statusMatrix(this.base)
    const present = new Set(worktreeFiles)
    for (const [filepath, head, workdir, stage] of matrix) {
      const existsOnDisk = present.has(filepath)
      if (!existsOnDisk && (head !== 0 || stage !== 0) && workdir === 0) {
        await git.remove({ ...this.base, filepath })
      }
    }
  }

  /** 递归列出工作树下所有文件（相对工作区根、POSIX 分隔），跳过 .mtbot-vcs */
  private async walkWorktreeFiles(): Promise<string[]> {
    const results: string[] = []
    const walk = (absDir: string, relDir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name === '.mtbot-vcs' || entry.name === '.git') continue
        if (VCS_SKIP_DIRS.has(entry.name)) continue
        const abs = path.join(absDir, entry.name)
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(abs, rel)
        } else if (entry.isFile()) {
          results.push(rel)
        }
      }
    }
    walk(this.workspaceDir, '')
    return results
  }

  /**
   * 提交当前工作区全量变更。无变更返回 null（不产生空提交）。
   *
   * 注意：isomorphic-git 的 statusMatrix 基于文件 stat（mtime 秒级 + size）做快速路径，
   * 同秒、同大小但内容不同的小文件会被漏检。故此处先 stageAll（强制按内容重算 blob hash 写入 index），
   * 再以 index(stage) 与 HEAD tree 的差异判断是否真有变更，绕开 stat 缓存。
   */
  async commit(opts: VcsCommitOptions): Promise<VcsCommit | null> {
    await this.ensureInitialized()

    await this.stageAll()
    const hasChanges = await this.hasStagedChanges()
    if (!hasChanges) {
      log.info('[commit] 工作区无变更，跳过提交')
      return null
    }

    const message = this.buildMessage(opts.message, opts.author, opts.conversationId, opts.runId)
    const oid = await git.commit({ ...this.base, message, author: GIT_AUTHOR })
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
   * 先 stageAll 重算 index，再比对 index(stage) 与 HEAD，避免 stat 缓存漏检。
   */
  async hasUncommittedChanges(): Promise<boolean> {
    await this.ensureInitialized()
    await this.stageAll()
    return this.hasStagedChanges()
  }

  /** 比对 index(stage) 与 HEAD tree：stage 列与 head 列不同即有待提交变更 */
  private async hasStagedChanges(): Promise<boolean> {
    const matrix = await git.statusMatrix(this.base)
    // 行格式 [filepath, head, workdir, stage]；head!==stage 表示已暂存的变更
    return matrix.some(([, head, , stage]) => head !== stage)
  }

  /**
   * 列出提交历史（按时间倒序，最新在前）。
   */
  async log(opts?: { limit?: number; offset?: number }): Promise<VcsCommit[]> {
    if (!this.isInitialized()) return []

    const limit = opts?.limit ?? 50
    const offset = opts?.offset ?? 0
    const entries = await git.log({ ...this.base, depth: limit + offset })

    return entries.slice(offset, offset + limit).map((e) => {
      const msg = e.commit.message
      return {
        oid: e.oid,
        message: this.stripTrailers(msg),
        timestamp: e.commit.author.timestamp * 1000,
        author: this.parseTrailer(msg, TRAILER_AUTHOR) === 'agent' ? 'agent' : 'user',
        conversationId: this.parseTrailer(msg, TRAILER_CONV),
        runId: this.parseTrailer(msg, TRAILER_RUN),
      }
    })
  }

  /**
   * 工作区相对某 commit（默认 HEAD）的文件级变更列表（不含 hunks）。
   */
  async statusDiff(baseOid?: string): Promise<VcsDiffEntry[]> {
    if (!this.isInitialized()) return []
    const ref = baseOid ?? 'HEAD'
    const matrix = await git.statusMatrix({ ...this.base, ref })
    const entries: VcsDiffEntry[] = []

    for (const [filepath, head, workdir] of matrix) {
      if (head === workdir) continue
      const status: VcsFileStatus = head === 0 ? 'added' : workdir === 0 ? 'deleted' : 'modified'
      const oldContent = head === 0 ? '' : (await this.readFileAt(ref, filepath)) ?? ''
      const newContent = workdir === 0 ? '' : this.readWorktreeFile(filepath)
      const stats = computeDiffStats(oldContent, newContent)
      entries.push({ filepath, status, ...stats })
    }
    return entries
  }

  /**
   * 两个 commit 之间的文件级差异；withHunks=true 时附带逐行 hunks。
   * 通过 git.walk 对比 tree OID，跳过未变更子树，避免全量 readBlob。
   */
  async diffCommits(
    fromOid: string,
    toOid: string,
    opts?: { withHunks?: boolean },
  ): Promise<VcsDiffEntry[]> {
    const withHunks = opts?.withHunks === true
    const entries: VcsDiffEntry[] = []

    await git.walk({
      ...this.base,
      trees: [git.TREE({ ref: fromOid }), git.TREE({ ref: toOid })],
      map: async (filepath, [a, b]) => {
        if (filepath === '.') return
        const aType = a ? await a.type() : null
        const bType = b ? await b.type() : null
        // 两侧都是 tree 且 OID 相同 → 剪枝整棵子树
        if (aType === 'tree' || bType === 'tree') {
          if (a && b && (await a.oid()) === (await b.oid())) return null
          return undefined // 继续往下走
        }
        // blob（或一侧缺失）
        const aOid = a ? await a.oid() : null
        const bOid = b ? await b.oid() : null
        if (aOid === bOid) return undefined

        const status: VcsFileStatus = !a ? 'added' : !b ? 'deleted' : 'modified'
        const oldContent = a
          ? new TextDecoder().decode((await a.content()) ?? new Uint8Array())
          : ''
        const newContent = b
          ? new TextDecoder().decode((await b.content()) ?? new Uint8Array())
          : ''

        if (withHunks) {
          const d = computeFileDiff(filepath, oldContent, newContent)
          entries.push({
            filepath,
            status,
            insertions: d.insertions,
            deletions: d.deletions,
            hunks: d.hunks,
          })
        } else {
          const stats = computeDiffStats(oldContent, newContent)
          entries.push({ filepath, status, ...stats })
        }
        return undefined
      },
    })

    return entries
  }

  /**
   * 单文件逐行 diff。任一侧超过 MAX_DIFF_BYTES 则返回 truncated，不跑 Myers。
   * fromOid/toOid 可为 commit oid；toOid 也可为 'WORKTREE' 读工作区当前内容。
   */
  async diffFile(fromOid: string, toOid: string, filepath: string): Promise<VcsDiffEntry> {
    const oldContent =
      fromOid === 'WORKTREE'
        ? this.readWorktreeFile(filepath)
        : (await this.readFileAt(fromOid, filepath)) ?? ''
    const newContent =
      toOid === 'WORKTREE'
        ? this.readWorktreeFile(filepath)
        : (await this.readFileAt(toOid, filepath)) ?? ''
    const status: VcsFileStatus =
      oldContent === '' && newContent !== ''
        ? 'added'
        : newContent === '' && oldContent !== ''
          ? 'deleted'
          : 'modified'

    if (
      Buffer.byteLength(oldContent, 'utf8') > MAX_DIFF_BYTES ||
      Buffer.byteLength(newContent, 'utf8') > MAX_DIFF_BYTES
    ) {
      return {
        filepath,
        status,
        insertions: 0,
        deletions: 0,
        hunks: [],
        truncated: true,
        skipReason: '文件过大，已跳过逐行差异',
      }
    }

    const d = computeFileDiff(filepath, oldContent, newContent)
    return {
      filepath,
      status,
      insertions: d.insertions,
      deletions: d.deletions,
      hunks: d.hunks,
    }
  }

  /**
   * 读取某 commit 下单个文件内容。文件不存在返回 null。
   */
  async readFileAt(oid: string, filepath: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ ...this.base, oid, filepath })
      return new TextDecoder().decode(blob)
    } catch {
      return null
    }
  }

  /** 读取某 commit 下单文件的原始字节（用于回滚写回，保留二进制） */
  private async readBlobBytes(oid: string, filepath: string): Promise<Uint8Array | null> {
    try {
      const { blob } = await git.readBlob({ ...this.base, oid, filepath })
      return blob
    } catch {
      return null
    }
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
    const targetFiles = await this.listFilesAt(oid)
    const currentFiles = await this.listFilesAt('HEAD')

    // 2a. 写回目标版本存在的文件
    for (const filepath of targetFiles) {
      const content = await this.readBlobBytes(oid, filepath)
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

    // 3. 暂存并追加一条线性回滚提交
    await this.stageAll()
    const short = oid.slice(0, 8)
    const hasChanges = await this.hasUncommittedChanges()
    if (hasChanges) {
      await git.commit({
        ...this.base,
        message: this.buildMessage(`已回滚至 ${short}`, 'user'),
        author: GIT_AUTHOR,
      })
    }

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

    const content = await this.readBlobBytes(ref, filepath)
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
    const entries = await git.log({ ...this.base, depth: 100 })
    for (const e of entries) {
      const msg = e.commit.message
      const convId = this.parseTrailer(msg, TRAILER_CONV)
      if (convId === conversationId) {
        return {
          oid: e.oid,
          message: this.stripTrailers(msg),
          timestamp: e.commit.author.timestamp * 1000,
          author: this.parseTrailer(msg, TRAILER_AUTHOR) === 'agent' ? 'agent' : 'user',
          conversationId: convId,
          runId: this.parseTrailer(msg, TRAILER_RUN),
        }
      }
    }
    return null
  }

  // ─── 内部工具 ───

  private readWorktreeFile(filepath: string): string {
    try {
      return fs.readFileSync(path.join(this.workspaceDir, filepath), 'utf-8')
    } catch {
      return ''
    }
  }

  private async listFilesAt(oid: string): Promise<Set<string>> {
    try {
      const files = await git.listFiles({ ...this.base, ref: oid })
      return new Set(files)
    } catch {
      return new Set()
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

  private stripTrailers(message: string): string {
    return message.split('\n')[0] ?? message
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
