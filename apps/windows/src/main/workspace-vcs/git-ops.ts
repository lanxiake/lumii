/**
 * Workspace VCS — 真 git 操作层（读历史 + 提交）
 *
 * ## 这个文件为什么存在
 *
 * 本模块原先把 log / statusMatrix / walk / readBlob / commit 全部交给 isomorphic-git。
 * 2026-09-19 复盘后改为**只用真 git**，理由是双实现共用仓库本身是全部麻烦的源头：
 *
 *   - iso 读 pack 是**整个读进内存**的，于是仓库形状必须迁就它 —— 要禁 gc、
 *     要给 gc 限单包尺寸、还要在 gc 后自检（因为 git 对不认识的配置静默忽略），
 *     每一条都是「约定」而非机制。绕开「禁 gc」的拆包脚本曾毁掉 1.3GB 历史。
 *   - iso 的 GitWalkerFs 会 readdir + lstat 整个工作树（**含自定义 gitdir 自己**，
 *     它的跳过规则只认 `.git`），所以 gitdir 里不能留任何瞬时文件；真 git 写 index
 *     时的 `index.lock` 会与它撞出 `ENOENT: lstat`，连 `git commit` 都不敢用。
 *   - iso 跑在主线程上。log/statusDiff/readBlob 目前只因「用户打开版本面板才跑」
 *     侥幸没被算进卡死账，大仓库上同样能卡到秒级。
 *
 * 摘掉之后这些约束**全部消失**：仓库形状不再受限、commit 可以走真 git、
 * 冷路径也一并离开主线程。代价是真 git 成为硬依赖（已确认接受）。
 *
 * ## 分工
 *
 *   vcs-git-cli.ts  写路径（暂存、有没有变更、index 损坏自愈、排除规则、iso 安全配置）
 *   本文件          读路径（历史、状态、diff、读 blob）+ 提交
 *
 * 暂存与提交**都留在真 git**（原先是「真 git 暂存 + iso 提交」，只因后者不产生
 * `index.lock`）；现在没有第二个实现去 lstat gitdir，那条 TOCTOU 不再存在。
 *
 * ## 解析原则
 *
 * 纯字符串解析都抽成导出的独立函数（`parseLogOutput` 等），与执行分开 ——
 * 这样格式假设可以单独测，不必为了验一个解析分支去造真仓库。
 */

import path from 'node:path'
import fs from 'node:fs'
import { runGit as sharedRunGit, hasFatalError, type GitRunResult } from '../git-cli'
import type { VcsCommit, VcsDiffEntry, VcsFileStatus } from './types'
import { isVcsBinaryPath } from './vcs-ignore'
import { computeDiffStats, computeFileDiff, MAX_DIFF_BYTES } from './vcs-diff'
import { ensureExcludeFile } from './vcs-git-cli'

const log = {
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcs:git-ops]', ...args),
}

/**
 * 探针用的哨兵字符。选 US/RS（单元/记录分隔符）是因为它们不可能出现在 commit
 * message 里，且不需要转义 —— 用 `|` 或 `\n` 之类的可打印字符做分隔，message 里
 * 一出现同样的字符就会把解析撕开。
 */
const F = '\x1f'
const R = '\x1e'

const LOG_FORMAT = `--format=%H${F}%at${F}%s${F}%B${R}`

/** 提交身份（与 vcs-git-cli.ts 保持一致；真 git 走环境变量，见 gitEnvFor） */
export const GIT_AUTHOR = { name: 'Mtbot', email: 'vcs@mtbot.local' } as const

function authorEnv(author: { name: string; email: string }): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  }
}

/** 在本仓库上跑 git（自动带上硬剪枝的 excludesFile） */
function runGit(
  workspaceDir: string,
  gitdir: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; raw?: boolean; stdin?: string } = {},
): Promise<GitRunResult> {
  return sharedRunGit({
    workTree: workspaceDir,
    gitDir: gitdir,
    args,
    config: ['-c', `core.excludesFile=${ensureExcludeFile(gitdir)}`],
    ...opts,
  })
}

/** 失败即抛（带 stderr 摘要），用于「不成功就说明实现有问题」的调用 */
async function mustRun(
  workspaceDir: string,
  gitdir: string,
  args: string[],
  errPrefix: string,
  opts: { env?: Record<string, string>; raw?: boolean; stdin?: string } = {},
): Promise<GitRunResult> {
  const r = await runGit(workspaceDir, gitdir, args, opts)
  // 退出码之外还要看 stderr：`git status` 在 index 损坏时会打 fatal 却以 0 退出
  // （见 git-cli.ts 的 hasFatalError）。只看退出码会拿到半截输出继续解析。
  if (r.code !== 0 || hasFatalError(r.stderr)) {
    throw new Error(`${errPrefix} 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
  return r
}

// ─────────────────────────── 解析器（纯函数，可单测） ───────────────────────────

/** log 的一条原始记录 */
export interface RawLogEntry {
  oid: string
  /** 作者时间，**秒**（git 原生单位；调用方乘 1000 得到毫秒） */
  tsSec: number
  /** 第一行（提交标题） */
  subject: string
  /** 完整 message（含 trailer） */
  body: string
}

/**
 * 解析 `LOG_FORMAT` 的输出。
 *
 * 记录之间用 RS 分隔。注意 `git log` 会在**每条记录末尾**追加换行，于是 RS 后面
 * 跟着一个 `\n`；用 RS 切分后每条记录开头都会有它，所以下面统一 trim 掉。
 */
function parseLogOutput(stdout: string): RawLogEntry[] {
  const out: RawLogEntry[] = []
  for (const chunk of stdout.split(R)) {
    const rec = chunk.replace(/^\n+/, '')
    if (!rec) continue
    const parts = rec.split(F)
    if (parts.length < 4) continue
    const [oid, ts, subject, ...rest] = parts
    // body 里可能含 F？不会 —— 但 message 里可能有换行，rest 是「其余全部」，
    // 因为 %B 是最后一个字段，直接 join 回去即可（多出的 F 只会来自 message 自身，
    // 那种情况罕见且无害，join 保留原文比丢字段好）。
    const body = rest.join(F).replace(/\n+$/, '')
    out.push({ oid, tsSec: Number(ts) || 0, subject, body })
  }
  return out
}

/**
 * 解析 `git status --porcelain -z` 的输出，返回「相对 HEAD 有差异」的路径与状态。
 *
 * -z 用 NUL 分隔，路径里的空格/换行都不需要转义；rename 条目会多一个「原路径」
 * 字段。本模块**不启用** rename 检测（不加 -M，并显式带 --no-renames），所以
 * 只处理两字段形态；万一出现 R/C（调用方传了别的参数），跳过而非错位解析。
 *
 * 状态字母（XY 两位）：? 未跟踪、A 新增、D 删除、M 修改、T 类型变化。
 */
function parseStatusPorcelain(stdout: string): Array<{ filepath: string; status: VcsFileStatus }> {
  const out: Array<{ filepath: string; status: VcsFileStatus }> = []
  const fields = stdout.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const filepath = entry.slice(3)
    // rename/copy 会多带一个原路径字段，解析形状不同 —— 跳过，别错位
    if (xy.includes('R') || xy.includes('C')) {
      i++
      continue
    }
    let status: VcsFileStatus
    if (xy === '??' || xy[0] === 'A' || xy[1] === 'A') status = 'added'
    else if (xy[0] === 'D' || xy[1] === 'D') status = 'deleted'
    else status = 'modified'
    out.push({ filepath, status })
  }
  return out
}

/** 解析 `git diff --name-status` 的输出（只认 A/D/M/T，见文件头说明） */
function parseNameStatus(stdout: string): Array<{ filepath: string; status: VcsFileStatus }> {
  const out: Array<{ filepath: string; status: VcsFileStatus }> = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const letter = line.slice(0, tab).charAt(0)
    const filepath = line.slice(tab + 1)
    if (!filepath) continue
    const status: VcsFileStatus =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
    out.push({ filepath, status })
  }
  return out
}

/** 解析 `git ls-tree -r --name-only` 的输出 */
function parseLsTree(stdout: string): string[] {
  return stdout.split('\n').filter(Boolean)
}

// ─────────────────────────── 读历史 ───────────────────────────

/** 提交历史（最新在前）。`limit` 语义与原先 iso 的 depth 一致。 */
export async function logCli(
  workspaceDir: string,
  gitdir: string,
  limit: number,
): Promise<RawLogEntry[]> {
  const r = await runGit(workspaceDir, gitdir, ['log', `-n${limit}`, LOG_FORMAT])
  if (r.code !== 0 || hasFatalError(r.stderr)) {
    // 空仓库（HEAD 未出生）会 fatal，这不算错误 —— 与原先 iso 抛错被上层吞掉等价
    if (/does not have any commits|unknown revision|bad revision|ambiguous argument/i.test(r.stderr)) {
      return []
    }
    throw new Error(`git log 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
  return parseLogOutput(r.stdout)
}

// ─────────────────────────── 状态与差异 ───────────────────────────

/**
 * 工作区相对 ref（默认 HEAD）的文件级变更列表（不含 hunks）。
 *
 * 用 `git status --porcelain` 而非 `git diff HEAD`：后者**不刷新 index 的 stat 信息**，
 * 进程刚起来（index 是上一轮留在磁盘上的）时会把「内容改了但 mtime/size 没进 index」
 * 的文件算成未变更。status 会先刷新 index，是唯一稳妥的「工作树 vs HEAD」原语。
 *
 * `--no-renames`：把重命名报成 删除+新增。与原先 iso 的 statusMatrix 行为一致
 * （它没有重命名检测），对外契约（added/deleted/modified）不变。
 */
export async function statusDiffCli(
  workspaceDir: string,
  gitdir: string,
  ref: string,
): Promise<VcsDiffEntry[]> {
  const r = await mustRun(
    workspaceDir, gitdir,
    ['status', '--porcelain', '-z', '--no-renames', `--untracked-files=all`],
    'git status',
  )
  const changed = parseStatusPorcelain(r.stdout)
  // ref 目前只有 'HEAD' 一种取值（上层默认值）。若要支持任意 ref，需要改成
  // `git diff --name-status <ref> --no-renames` + 单独的 untracked 扫描；先不做，
  // 免得留一条没人走的代码路径。
  if (ref !== 'HEAD') {
    log.warn(`[statusDiffCli] ref=${ref} 暂不支持，按 HEAD 处理`)
  }

  const entries: VcsDiffEntry[] = []
  for (const { filepath, status } of changed) {
    if (isVcsBinaryPath(filepath)) {
      entries.push({
        filepath,
        status,
        insertions: status === 'deleted' ? 0 : 1,
        deletions: status === 'added' ? 0 : 1,
        truncated: true,
        skipReason: '二进制文件（已纳入版本管理，跳过文本 diff）',
      })
      continue
    }
    const oldContent = status === 'added' ? '' : (await readFileAt(workspaceDir, gitdir, 'HEAD', filepath)) ?? ''
    const newContent = status === 'deleted' ? '' : readWorktreeFile(workspaceDir, filepath)
    entries.push({ filepath, status, ...computeDiffStats(oldContent, newContent) })
  }
  return entries
}

/**
 * 两个 commit 之间的文件级差异；withHunks=true 时附带逐行 hunks。
 *
 * 原先用 `git.walk` 逐 tree 对比并**剪枝 OID 相同的子树**以避免全量 readBlob。
 * 现在交给 `git diff --name-status` —— 剪枝本来就是它的内建行为，而且它跑在
 * 子进程里，工作区再大也不占主线程。
 */
export async function diffCommitsCli(
  workspaceDir: string,
  gitdir: string,
  fromOid: string,
  toOid: string,
  opts: { withHunks?: boolean } = {},
): Promise<VcsDiffEntry[]> {
  const r = await mustRun(
    workspaceDir, gitdir,
    ['diff', '--name-status', '--no-renames', fromOid, toOid],
    'git diff --name-status',
  )
  const changed = parseNameStatus(r.stdout)
  const entries: VcsDiffEntry[] = []
  for (const { filepath, status } of changed) {
    const oldContent = status === 'added' ? '' : (await readFileAt(workspaceDir, gitdir, fromOid, filepath)) ?? ''
    const newContent = status === 'deleted' ? '' : (await readFileAt(workspaceDir, gitdir, toOid, filepath)) ?? ''
    if (opts.withHunks) {
      const d = computeFileDiff(filepath, oldContent, newContent)
      entries.push({ filepath, status, insertions: d.insertions, deletions: d.deletions, hunks: d.hunks })
    } else {
      entries.push({ filepath, status, ...computeDiffStats(oldContent, newContent) })
    }
  }
  return entries
}

/**
 * 单文件逐行 diff。任一侧超过 MAX_DIFF_BYTES 则返回 truncated，不跑 Myers。
 * fromOid/toOid 可为 commit oid；toOid 也可为 'WORKTREE' 读工作区当前内容。
 */
export async function diffFileCli(
  workspaceDir: string,
  gitdir: string,
  fromOid: string,
  toOid: string,
  filepath: string,
): Promise<VcsDiffEntry> {
  const oldContent =
    fromOid === 'WORKTREE'
      ? readWorktreeFile(workspaceDir, filepath)
      : (await readFileAt(workspaceDir, gitdir, fromOid, filepath)) ?? ''
  const newContent =
    toOid === 'WORKTREE'
      ? readWorktreeFile(workspaceDir, filepath)
      : (await readFileAt(workspaceDir, gitdir, toOid, filepath)) ?? ''
  const status: VcsFileStatus =
    oldContent === '' && newContent !== '' ? 'added'
      : newContent === '' && oldContent !== '' ? 'deleted'
        : 'modified'

  if (
    Buffer.byteLength(oldContent, 'utf8') > MAX_DIFF_BYTES ||
    Buffer.byteLength(newContent, 'utf8') > MAX_DIFF_BYTES
  ) {
    return { filepath, status, insertions: 0, deletions: 0, hunks: [], truncated: true, skipReason: '文件过大，已跳过逐行差异' }
  }
  const d = computeFileDiff(filepath, oldContent, newContent)
  return { filepath, status, insertions: d.insertions, deletions: d.deletions, hunks: d.hunks }
}

// ─────────────────────────── 读内容 ───────────────────────────

/** 某 commit 下单个文件的原始字节；不存在返回 null */
export async function readBlobBytes(
  workspaceDir: string,
  gitdir: string,
  oid: string,
  filepath: string,
): Promise<Uint8Array | null> {
  const r = await runGit(workspaceDir, gitdir, ['show', `${oid}:${filepath}`], { raw: true })
  if (r.code !== 0) return null
  return r.stdoutRaw ?? new Uint8Array()
}

/** 某 commit 下单个文件内容（UTF-8）；不存在返回 null */
export async function readFileAt(
  workspaceDir: string,
  gitdir: string,
  oid: string,
  filepath: string,
): Promise<string | null> {
  const bytes = await readBlobBytes(workspaceDir, gitdir, oid, filepath)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/** 某 commit 下的全部文件路径 */
export async function listFilesAt(
  workspaceDir: string,
  gitdir: string,
  oid: string,
): Promise<Set<string>> {
  const r = await runGit(workspaceDir, gitdir, ['ls-tree', '-r', '--name-only', oid])
  if (r.code !== 0) return new Set()
  return new Set(parseLsTree(r.stdout))
}

function readWorktreeFile(workspaceDir: string, filepath: string): string {
  try {
    return fs.readFileSync(path.join(workspaceDir, filepath), 'utf-8')
  } catch {
    return ''
  }
}

// ─────────────────────────── 初始化与提交 ───────────────────────────

/** `git init`（幂等）。defaultBranch 用 -b 指定，与原先 iso 的 defaultBranch 参数等价。 */
export async function initCli(
  workspaceDir: string,
  gitdir: string,
  defaultBranch = 'main',
): Promise<void> {
  await mustRun(workspaceDir, gitdir, ['init', '-q', '-b', defaultBranch], 'git init')
}

/**
 * 提交已暂存的内容。
 *
 * `--no-verify` 跳过钩子：本仓库是应用自己的私有 gitdir，用户不会在这里放钩子，
 * 但工作区里若有 `core.hooksPath` 指向的目录，钩子失败会让快照静默停摆。
 *
 * 身份走环境变量（gitEnvFor），不读写用户 config —— 与暂存路径同一套。
 */
export async function commitCli(
  workspaceDir: string,
  gitdir: string,
  message: string,
  author = GIT_AUTHOR,
): Promise<string | null> {
  // message 从 stdin 传：走 -m 的话多行 message（含 trailer）要经过命令行参数，
  // Windows 上引号与换行的转义是另一个坑。stdin 由 runGit 负责写入并关闭 ——
  // 只 spawn 不关 stdin，git 会一直等 EOF（这个坑真实发生过，见 git-cli.ts）。
  const r = await runGit(
    workspaceDir, gitdir,
    ['commit', '-q', '--no-verify', '--allow-empty', '-F', '-'],
    { env: authorEnv(author), stdin: message },
  )
  if (r.code !== 0 || hasFatalError(r.stderr)) {
    throw new Error(`git commit 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
  const head = await runGit(workspaceDir, gitdir, ['rev-parse', 'HEAD'])
  return head.code === 0 ? head.stdout.trim() : null
}

/**
 * index 是否与 HEAD 有差异（即「有没有已暂存变更」）。
 *
 * 退出码约定：0 = 无差异，1 = 有差异，其它为真错误。
 * HEAD 未出生（新仓库还没提交）时 `--cached` 会以 128 失败，此时按「有变更」处理 ——
 * 上层紧接着的 commit 需要它这么做。
 */
export async function hasStagedChangesCli(
  workspaceDir: string,
  gitdir: string,
): Promise<boolean> {
  const r = await runGit(workspaceDir, gitdir, ['diff', '--cached', '--quiet'])
  // 先看 stderr：index 损坏时 git 可能打 fatal 却以 0/1 退出，那会被误读成
  // 「有变更」或「没变更」。必须让它抛出去，交给上层的 withIndexRepair 自愈。
  if (hasFatalError(r.stderr)) {
    throw new Error(`git diff --cached 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
  if (r.code === 0) return false
  if (r.code === 1) return true
  if (/ambiguous argument|unknown revision|does not have any commits/i.test(r.stderr)) return true
  throw new Error(`git diff --cached 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
}
