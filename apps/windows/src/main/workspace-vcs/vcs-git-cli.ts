/**
 * Workspace VCS — 写路径（暂存、排除规则、index 锁重试、仓库配置）
 *
 * ## 为什么工作区仓库改用真 git
 *
 * 原实现全部走 isomorphic-git（纯 JS）。它的 `git.add('.')` 会**按内容重算全部 blob
 * hash**，而这条路径挂在「每持久化一条助手消息」上（bridge-instance-factory.ts 的
 * onAssistantMessagePersisted）。实测工作区 2.7GB / 12866 文件时：
 *
 *   isomorphic-git：中位 19,933ms，p90 27,594ms，最大 53,550ms   ← 全在主进程主线程上
 *   真 git 子进程  ：约 100ms
 *
 * 主线程被占住 = 渲染进程拿不到响应、日志停写。2026-09-18 实测因此触发
 * Windows 事件 1002「Application Hang」，electron.exe 被系统杀掉（用户侧表现为「客户端卡死」）。
 *
 * 子进程调用与配置隔离的底座在 `../git-cli.ts`（cloud-sync 共用同一份，
 * 因为「哪些 -c 是必须的」这种事复制两份必然漂移）。
 *
 * ## 为什么最后把 isomorphic-git 整体摘掉（2026-09-19）
 *
 * 中间版本是「真 git 暂存 + iso 提交/读历史」的混合。复盘后判定**双实现共用同一仓库
 * 本身就是全部麻烦的源头**：仓库形状必须迁就能力更弱的那一方，于是要禁自动 gc、
 * 限单包尺寸、gc 后自检，gitdir 里不能留瞬时文件，连 `git commit` 都要让位。
 * 这些都是靠约定维系的防线，每一道都被踩穿过一次（绕开「禁 gc」的拆包脚本毁掉 1.3GB 历史）。
 *
 * 现在写路径在本文件、读路径与提交在 `git-ops.ts`，**全部走真 git**。
 * 真 git 因此成为硬依赖（已确认接受）：detectGit() 失败时 VCS 停用并给出明确日志，
 * 而不是退回一个会把主线程冻死的实现。cloud-sync 那侧仍用 iso 做 fetch/merge/push
 * （网络与三方合并语义，替换风险高于收益），所以那个仓库仍需迁就它。
 *
 * ## 为什么用 git 默认的 stat 缓存就够（2026-09-19 修正）
 *
 * 本文件曾经每次暂存都强制全量重算 hash（临时 index + 原子改名，线上实测 2920ms），
 * 论据是「必须检出『等长 + utimesSync 还原 mtime』的改写，因为云同步导入路径会
 * utimesSync」。**括号里那句是错的**，复核 cloud-sync 后：
 *
 *   - sync-copy.ts 的 utimesSync 只在 `skipUnchanged: true` 时执行；
 *   - 只有 sync-exporter.ts 传了它，目标是 **sync 目录**，不是工作区；
 *     sync-large-queue.ts 的回写目标同样是 sync 目录；
 *   - 真正写工作区的 sync-importer.ts 只 copyFileSync、**不回写 mtime**，
 *     sync-copy.ts 的注释还专门写明「仅应在 export 方向开启」。
 *
 * 所以工作区里根本不存在「等长 + mtime 不变」的改写。scripts/probe-vcs-stat-cache-sufficiency.mjs
 * 用两组对照实测：importer 的真实行为（等长 + 不回写 mtime）被 stat 缓存**正确检出**
 * （mtime 变新 → git 重读内容），而人为还原 mtime 的场景确实漏检 —— 但那个场景不会发生。
 *
 * 线上 workspace 仓库（2148 个 index 条目）实测：
 *   stat 缓存      76ms     ← 采用
 *   强制全量重算   2920ms
 *   isomorphic-git 19933ms  （且**在主线程上**，正是卡死的成因）
 *
 * ⚠️ 这条结论依赖一个可检查的前提：**没有任何路径在写工作区文件后还原它的 mtime**。
 * 若将来 sync-importer 开启 `skipUnchanged`，或新增别的「覆盖内容 + 保留 mtime」的
 * 导入路径，这个假设就破了，必须同步回来改这里（重开全量重算，或给受影响路径
 * 显式标记待重扫）。probe-vcs-stat-cache-sufficiency.mjs 的组 B 就是那个场景的复现。
 *
 * ## 排除防线为什么放 core.excludesFile
 *
 * 真 git 的 `add -A` 会走整个工作树，而原实现靠 walkWorktreeFiles 在 JS 侧硬剪枝。
 * 由 scripts/probe-vcs-exclude-combos.mjs 实测的六种组合决定用哪种机制：
 *
 *   A. .gitignore 有规则 + 命令行 `:(exclude)` → ❌ 退出码 1
 *      （git 拒绝「已被忽略的路径又被显式命名」，而默认 .gitignore 本来就含 `.mtbot-vcs/`，
 *        所以这条在正常场景下必挂）
 *   B. .gitignore 有规则 + 无排除              → ✅（靠 .gitignore）
 *   C. .gitignore 清空 + 命令行排除            → ✅
 *   D. .gitignore 清空 + 无排除                → ❌ 灾难：.mtbot-vcs/objects、index.lock 自我索引
 *   E. .gitignore 有规则 + excludesFile        → ✅
 *   F. .gitignore 清空 + excludesFile          → ✅（**唯一两种场景都成立**）
 *
 * 另需挡住 Windows 保留设备名：工作区里真有一个 `nul`（某次 shell 重定向 `> nul`
 * 误建成真文件），真 git 对它 fatal（`error: short read while indexing nul`）。
 * 这个文件至今还在线上工作区里，挡不住就是每次快照都直接挂。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  detectGit,
  runGit as sharedRunGit,
  type GitRunResult,
} from '../git-cli'
import { VCS_SKIP_DIRS } from './vcs-ignore'

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcs:git]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcs:git]', ...args),
}

/** index.lock 争用时的重试（用户回滚与后台快照并发时会撞上） */
const LOCK_RETRY = 3
const LOCK_RETRY_DELAY_MS = 300

/**
 * Windows 保留设备名。
 *
 * 这些名字在 Win32 上是设备而非文件，真 git 无法索引它们、遇到即 fatal
 * （实测 `error: short read while indexing nul` + `fatal: updating files failed`）。
 * 但 shell 重定向 `> nul` 在非 cmd.exe 语境下会**真的建出文件**，工作区里就撞上过一个。
 */
const WINDOWS_RESERVED_NAMES = [
  'nul', 'con', 'aux', 'prn',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]

/**
 * 硬剪枝规则（gitignore 语法）。
 *
 * 目录名从 VCS_SKIP_DIRS **派生**而非重抄一遍：两份名单一旦漂移，
 * 就会出现「JS 路径剪了、CLI 路径没剪」这种只在一半场景暴露的漏洞。
 * `projects` 只剪工作区根层（加前导斜杠），镜像 shouldSkipWalkDir 的语义 ——
 * 深层同名目录是用户自己的内容，不该误伤。
 *
 * 纯常量派生，故模块级只算一次。
 */
const EXCLUDE_CONTENT = (() => {
  const dirs = [...VCS_SKIP_DIRS].filter((d) => d !== '.git').map((d) => `${d}/`)
  return [
    '# Lumii VCS 硬剪枝规则（自动生成，请勿手改）',
    '# 与 vcs-ignore.ts 的 VCS_SKIP_DIRS 对应；由 vcs-git-cli.ts 生成',
    ...dirs,
    '/projects/',
    ...WINDOWS_RESERVED_NAMES,
    '',
  ].join('\n')
})()

/** 已确保写过规则文件的 gitdir（每个进程写一次即可） */
const excludeFileReady = new Set<string>()

/** 写（或复用）排除规则文件，返回绝对路径 */
export function ensureExcludeFile(gitdir: string): string {
  const p = path.join(gitdir, 'mtbot-vcs-exclude')
  if (excludeFileReady.has(gitdir)) return p
  try {
    fs.mkdirSync(gitdir, { recursive: true })
    // 内容比对而非存在即跳过：VCS_SKIP_DIRS 改了要能自动跟上
    if (!fs.existsSync(p) || fs.readFileSync(p, 'utf-8') !== EXCLUDE_CONTENT) {
      fs.writeFileSync(p, EXCLUDE_CONTENT, 'utf-8')
    }
    excludeFileReady.add(gitdir)
  } catch (err) {
    log.warn('写入排除规则文件失败（硬剪枝防线将缺失）:', err)
  }
  return p
}

/** 在本仓库上跑 git（自动带上硬剪枝的 excludesFile） */
export function runGit(
  workspaceDir: string,
  gitdir: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<GitRunResult> {
  return sharedRunGit({
    workTree: workspaceDir,
    gitDir: gitdir,
    args,
    config: ['-c', `core.excludesFile=${ensureExcludeFile(gitdir)}`],
    timeoutMs: opts.timeoutMs,
  })
}

export { detectGit }

/**
 * 把「本仓库不跑自动 gc」写死进仓库自身的 config。
 *
 * **2026-09-19 修正理由**：这条原先是为了迁就 isomorphic-git（它把整个 pack 读进内存，
 * 1.38GB 单包直接读不动），同时还要配 `pack.packSizeLimit` 限单包尺寸。isomorphic-git
 * 已从工作区仓库整体摘除，那两条理由都不成立了，`packSizeLimit` 随之去掉。
 *
 * 保留 `gc.auto=0` 换了个理由：本仓库是**规模敏感**的 —— 工作区可达数 GB，而
 * `gc --auto` 会在某次提交后顺带跑一次 repack，那是一次不可预测的 IO 尖峰，
 * 正好落在用户会话中间。仓库维护交给 cloud-sync 的 maybePruneObjectStore
 * （它有明确节奏，且带 packSizeLimit 迁就 sync 仓库那侧的 isomorphic-git）。
 *
 * 调用方每次都带 `-c gc.auto=0`，这里再落一道到仓库自己身上 —— 防止任何不带那些参数
 * 的 git 调用（手工调试、将来的新代码、用户自己敲的 git）意外触发 gc。
 * 失败不抛：真 git 不可用时本就没有这个风险。
 */
/** 已确保写过安全配置的 gitdir（每进程一次即可，避免每个消息都多一次子进程） */
const safeConfigReady = new Set<string>()

export async function pinNoAutoGc(workspaceDir: string, gitdir: string): Promise<void> {
  if (safeConfigReady.has(gitdir)) return
  try {
    const r = await runGit(workspaceDir, gitdir, ['config', '--local', 'gc.auto', '0'])
    if (r.code !== 0) {
      log.warn(`[pinNoAutoGc] 写入 gc.auto 失败（退出码 ${r.code}）：${r.stderr.trim().slice(0, 160)}`)
      return // 不记账，下次再试
    }
  } catch (err) {
    log.warn('[pinNoAutoGc] 写入 gc.auto 异常（真 git 不可用时可忽略）:', err)
    return
  }
  safeConfigReady.add(gitdir)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isLockError = (r: GitRunResult) => /index\.lock|Unable to create .*\.lock|File exists/i.test(r.stderr)

/**
 * 带 index.lock 重试地执行 git。
 *
 * 后台快照与用户触发的回滚/还原会并发访问同一 index；真 git 用 index.lock 互斥，
 * 撞上时报 "Unable to create .../index.lock: File exists"。重试比直接失败合理：
 * 两条路径都是短任务，退避几次即可错开。
 */
async function runWithLockRetry(
  workspaceDir: string,
  gitdir: string,
  args: string[],
): Promise<GitRunResult> {
  let last: GitRunResult | undefined
  for (let i = 0; i < LOCK_RETRY; i++) {
    const r = await runGit(workspaceDir, gitdir, args)
    if (r.code === 0 || !isLockError(r)) return r
    last = r
    if (i < LOCK_RETRY - 1) await sleep(LOCK_RETRY_DELAY_MS * (i + 1))
  }
  return last!
}

/**
 * 暂存工作区全部变更（新增 / 修改 / **删除**）。
 *
 * 就是一条普通的 `git add -A`，走 git 自己的 index stat 缓存。为什么这样够用、
 * 以及它依赖的那个**可检查前提**，见本文件头「为什么用 git 默认的 stat 缓存就够」。
 *
 * ⚠️ 别改成 `git add -A --renormalize` 来「顺手强制重算」：它带 `-u` 语义，
 * 工作区有删除时会 `fatal: unable to stat '<已删文件>'`。
 *
 * ⚠️ 也别改回「临时 index（GIT_INDEX_FILE）+ 原子改名」那套强制全量重算：
 * 线上实测 2920ms vs 76ms，而它要防的场景在工作区里不会发生。若某天前提真的破了，
 * 那套写法本身是对的（尤其**不能**退化成 `rm index` —— 那会制造读者可见的空窗，
 * isomorphic-git 的 statusMatrix 此刻读不到 index 会直接报 internal error，
 * 2026-09-18 日志里的 `[VCS-IPC] statusDiff 失败` 就是这么来的）。
 */
export async function stageAllCli(workspaceDir: string, gitdir: string): Promise<void> {
  const r = await runWithLockRetry(workspaceDir, gitdir, ['add', '-A'])
  if (r.code !== 0) {
    throw new Error(`git add -A 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
}

/*
 * hasStagedChangesCli 与 commitCli 都在 git-ops.ts —— 它们属于「读/提交」路径，
 * 不属于这里（写 index 的路径）。
 *
 * 本文件的边界：暂存、排除规则文件、index 锁重试、仓库自身的安全配置。
 *
 * 曾经这里有一条「别用真 git 做 commit」的约束，理由是 `git commit` 产生的
 * `index.lock` 会与 isomorphic-git 自己的 walk 撞出 TOCTOU
 * （`ENOENT: lstat '.mtbot-vcs/index.lock'`）。isomorphic-git 已在 2026-09-19
 * 从工作区仓库整体摘除，没有第二个实现去 lstat gitdir，那条约束随之消失。
 */
