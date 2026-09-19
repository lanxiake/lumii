/**
 * Workspace VCS — 真 git 子进程封装（快路径）
 *
 * ## 为什么要有这个文件
 *
 * 原实现全部走 isomorphic-git（纯 JS）。它的 `git.add('.')` 会**按内容重算全部 blob
 * hash**，而这条路径挂在「每持久化一条助手消息」上（bridge-instance-factory.ts 的
 * onAssistantMessagePersisted）。实测工作区 2.7GB / 12866 文件时：
 *
 *   isomorphic-git：中位 19,933ms，p90 27,594ms，最大 53,550ms   ← 全在主进程主线程上
 *   真 git 子进程  ：约 100ms ~ 2.5 秒（取决于是否强制全量重算）
 *
 * 主线程被占住 = 渲染进程拿不到响应、日志停写。2026-09-18 实测因此触发
 * Windows 事件 1002「Application Hang」，electron.exe 被系统杀掉（用户侧表现为「客户端卡死」）。
 *
 * 子进程调用与配置隔离的底座在 `../git-cli.ts`（cloud-sync 共用同一份，
 * 因为「哪些 -c 是必须的」这种事复制两份必然漂移）。
 *
 * ## 为什么可以只换热路径
 *
 * log / readBlob / diff / rollback 仍留在 isomorphic-git（它们只在用户打开版本面板时跑，
 * 不是每消息一次）。两种实现共用同一个仓库是安全的，已由 scripts/probe-vcs-git-interop.mjs
 * 逐条验证：真 git 认 isomorphic-git 写的 index、isomorphic-git 能读回真 git 的提交、
 * 交错提交 6 轮后双方一致、index 版本为 2（isomorphic-git 只支持 v2）。
 *
 * ## 「等长改写必须被检出」这条保证怎么保住的
 *
 * 原实现放弃 stat 快速路径，是为了保住一条保证：任何内容改写都被检出，包括
 * 「等长 + utimesSync 还原 mtime」这种（云同步导入路径确实会 utimesSync）。
 * 真 git 默认的 stat 缓存**没有**这条保证 —— 它在 vcs-repo.test.ts 的对应用例上实测漏检。
 *
 * 三条路线的实测代价：
 *   stat 缓存路径      82ms     ❌ 漏检
 *   删 index 全量重算  2469ms   ✅ 检出   ← 采用
 *   isomorphic-git     19933ms  ✅ 检出（但**在主线程上**，正是卡死的成因）
 *
 * 全量重算跑在子进程里，所以这条保证现在的代价只是后台 CPU，不再是 UI 冻结。
 * 详见 stageAllCli 的注释。
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
 * 误建成真文件），真 git 对它 fatal（`error: short read while indexing nul`），
 * 而 isomorphic-git 能容忍 —— 不处理就是回归。
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

const AUTHOR = { name: 'Mtbot', email: 'vcs@mtbot.local' } as const

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
function ensureExcludeFile(gitdir: string): string {
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
function runGit(
  workspaceDir: string,
  gitdir: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<GitRunResult> {
  return sharedRunGit({
    workTree: workspaceDir,
    gitDir: gitdir,
    args,
    config: ['-c', `core.excludesFile=${ensureExcludeFile(gitdir)}`],
    timeoutMs: opts.timeoutMs,
    env: opts.env,
  })
}

export { detectGit }

/**
 * 把「本仓库必须保持 isomorphic-git 可读」写死进仓库自身的 config。
 *
 * isomorphic-git 读 pack 是**把整个 pack 读进内存**的（`fs.read` 一个 Buffer），
 * 大包直接读不动（2026-09-18 实测：1.38GB 单包让 log/diff/readBlob 全废）。
 * 本仓库与它共用，所以要挡住两条路：
 *
 *  - `gc.auto=0`：挡住自动 gc（就是它压出了那个 1.38GB 单包）。
 *  - `pack.packSizeLimit=64m`：万一有人手工 `git gc`，产出的也是多个小包 ——
 *    isomorphic-git 的 readObjectPacked 遍历所有 `.idx`，多包对它透明。
 *
 * 调用方每次都带 `-c gc.auto=0`，这里再落一道到仓库自己身上 —— 防止任何不带那些参数
 * 的 git 调用（手工调试、将来的新代码、用户自己敲的 git）把它打回不可读的形态。
 * 失败不抛：真 git 不可用时本就没有这个风险。
 */
/** 已确保写过安全配置的 gitdir（每进程一次即可，避免每个消息都多两次子进程） */
const safeConfigReady = new Set<string>()

export async function pinIsoSafeConfig(workspaceDir: string, gitdir: string): Promise<void> {
  if (safeConfigReady.has(gitdir)) return
  const pairs: Array<[string, string]> = [
    ['gc.auto', '0'],
    ['pack.packSizeLimit', '64m'],
  ]
  let allOk = true
  for (const [key, value] of pairs) {
    try {
      const r = await runGit(workspaceDir, gitdir, ['config', '--local', key, value])
      if (r.code !== 0) {
        allOk = false
        log.warn(`[pinIsoSafeConfig] 写入 ${key} 失败（退出码 ${r.code}）：${r.stderr.trim().slice(0, 160)}`)
      }
    } catch (err) {
      allOk = false
      log.warn(`[pinIsoSafeConfig] 写入 ${key} 异常（真 git 不可用时可忽略）:`, err)
    }
  }
  // 只在全部成功时记账：失败就不记忆，下次再试（仓库处于不安全形态时不该静默放过）
  if (allOk) safeConfigReady.add(gitdir)
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
  opts: { env?: Record<string, string> } = {},
): Promise<GitRunResult> {
  let last: GitRunResult | undefined
  for (let i = 0; i < LOCK_RETRY; i++) {
    const r = await runGit(workspaceDir, gitdir, args, opts)
    if (r.code === 0 || !isLockError(r)) return r
    last = r
    if (i < LOCK_RETRY - 1) await sleep(LOCK_RETRY_DELAY_MS * (i + 1))
  }
  return last!
}

/**
 * 暂存工作区全部变更（新增 / 修改 / **删除**）。
 *
 * ## 为什么要强制全量重算
 *
 * 原实现放弃 stat 快速路径，是为了保住一条保证：任何内容改写都被检出，包括
 * 「等长 + utimesSync 还原 mtime」这种（云同步导入路径确实会 utimesSync）。
 * 真 git 默认走 index 的 stat 缓存，在这种改写上实测**漏检**
 * （vcs-repo.test.ts 有对应用例；探针见 scripts/probe-vcs-force-rehash.mjs
 *  的对照组 C）。所以每次都要逼 git 逐个读文件重算 hash。
 *
 * ## 为什么用「临时 index + 原子改名」而不是 `rm index`
 *
 * 两者都能强制全量重算（实测均约 40ms），但 `rm index` 会制造一个
 * **读者可见的空窗**：isomorphic-git 的 statusMatrix（版本面板的 statusDiff）
 * 此刻读不到 index，直接报 internal error —— 2026-09-18 日志里的
 * `[VCS-IPC] statusDiff 失败` 就是这么来的。原实现没这问题，因为 isomorphic-git
 * 是「临时文件 + 改名」原子写 index，读者永远看不到中间态；`rm` 破坏了那条原子性。
 *
 * 把 index 写到 `GIT_INDEX_FILE` 指向的临时路径，git 同样无从比对 stat、只能全量重算；
 * 完成后**原子改名**盖到真 index 上。读者全程看到旧 index，切换是一瞬间。
 * （scripts/probe-vcs-temp-index.mjs 逐条验证：等长改写仍检出、增删改语义不变、
 *  提交后工作树干净。）
 *
 * ⚠️ 另一个候选 `git add -A --renormalize` 已否决：它有 `-u` 语义，
 * 有删除时会 `fatal: unable to stat '<已删文件>'`。
 */
export async function stageAllCli(workspaceDir: string, gitdir: string): Promise<void> {
  const realIndex = path.join(gitdir, 'index')
  const tmpIndex = path.join(gitdir, 'index.mtbot-tmp')
  fs.rmSync(tmpIndex, { force: true })
  try {
    const r = await runWithLockRetry(workspaceDir, gitdir, ['add', '-A'], {
      env: { GIT_INDEX_FILE: tmpIndex },
    })
    if (r.code !== 0) {
      throw new Error(`git add -A 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
    }
    // 原子切换：Windows 上 renameSync 走 MOVEFILE_REPLACE_EXISTING，可直接盖掉已存在的 index
    fs.renameSync(tmpIndex, realIndex)
  } catch (err) {
    fs.rmSync(tmpIndex, { force: true })
    throw err
  }
}

/**
 * 是否有已暂存变更（index 相对 HEAD）。
 *
 * `diff --cached --quiet` 约定：退出码 1 = 有差异，0 = 无差异，其它为真错误。
 * 只读，不写 index —— 所以不会产生 `index.lock`（那会与 isomorphic-git 的遍历撞 TOCTOU）。
 */
export async function hasStagedChangesCli(workspaceDir: string, gitdir: string): Promise<boolean> {
  const r = await runWithLockRetry(workspaceDir, gitdir, ['diff', '--cached', '--quiet'])
  if (r.code === 0) return false
  if (r.code === 1) return true
  throw new Error(`git diff --cached 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
}

/*
 * 这里**刻意没有** commitCli。
 *
 * 提交仍由 isomorphic-git 完成（vcs-repo.ts 的 stageAndCommit 有说明）：真 git 的
 * `commit` 会在 gitdir 里创建 `index.lock`，而 isomorphic-git 自己的 statusMatrix /
 * walk 会去 lstat 这个路径，两者并发时撞出 TOCTOU：
 *   ENOENT: no such file or directory, lstat '.mtbot-vcs/index.lock'
 * （目录读到了这个文件，lstat 时它已被改名为 index）。
 * 曾经为了「一致」把提交也交给真 git，结果就是这么挂的 —— 别再加回来。
 */
