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
 *   真 git 子进程  ：约 100ms
 *
 * 主线程被占住 = 渲染进程拿不到响应、日志停写。2026-09-18 实测因此触发
 * Windows 事件 1002「Application Hang」，electron.exe 被系统杀掉（用户侧表现为「客户端卡死」）。
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

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { VCS_SKIP_DIRS } from './vcs-ignore'

const log = {
  info: (...args: unknown[]) => console.log('[WorkspaceVcs:git]', ...args),
  warn: (...args: unknown[]) => console.warn('[WorkspaceVcs:git]', ...args),
}

/** 单次 git 命令超时（正常约 100ms；给足余量，超时即杀，绝不无限等） */
const GIT_TIMEOUT_MS = 120_000

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

/** `git` 是否可用——进程级缓存，只探一次 */
let gitAvailable: boolean | null = null

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

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

/** 已确保写过空配置的 gitdir（每个进程写一次即可） */
const emptyConfigReady = new Map<string, string>()

/**
 * 隔离用户全局 git 配置用的空文件，返回其路径（失败时返回空串）。
 *
 * 不隔离会引入静默漂移：用户全局的 `core.excludesFile` 会把工作区文件挡在快照外，
 * 而 isomorphic-git 不读全局配置。放在 gitdir 内（工作树之外），不会被快照扫到。
 */
function ensureEmptyConfig(gitdir: string): string {
  const cached = emptyConfigReady.get(gitdir)
  if (cached !== undefined) return cached
  const p = path.join(gitdir, 'mtbot-gitconfig-empty')
  let result = ''
  try {
    fs.mkdirSync(gitdir, { recursive: true })
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8')
    result = p
  } catch {
    /* 写不了就不隔离，命令仍可执行 */
  }
  emptyConfigReady.set(gitdir, result)
  return result
}

/**
 * 构造 git 参数前缀。
 *
 * 四个 `-c` 都是**必须**的，不是可选优化：
 * - `core.autocrlf=false`：真 git 若按平台默认做 CRLF 转换，blob hash 会与 isomorphic-git
 *   写下的不同，整个工作树会被看成「全部已修改」——灾难性假阳性。
 *   （实测默认配置下 add 会刷 `LF will be replaced by CRLF` 警告，正是这个来源。）
 * - `commit.gpgsign=false`：用户全局开了签名时，自动快照会去调 gpg（可能弹窗/挂住）。
 * - `index.version=2`：isomorphic-git 只支持 v2，真 git 在 feature.manyFiles 下会写 v4。
 * - `core.safecrlf=false`：配合 autocrlf=false，避免对混合行尾直接报错中断。
 *
 * `core.excludesFile` 是排除防线的落点，命令行 `-c` 优先级最高。
 */
function baseArgs(workspaceDir: string, gitdir: string): string[] {
  return [
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'index.version=2',
    `-c`, `core.excludesFile=${ensureExcludeFile(gitdir)}`,
    `--git-dir=${gitdir}`,
    `--work-tree=${workspaceDir}`,
  ]
}

function gitEnv(gitdir: string): NodeJS.ProcessEnv {
  const cfg = ensureEmptyConfig(gitdir)
  return {
    ...process.env,
    // 提交身份走环境变量，避免读写用户 config
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
    // 系统级 config（Git for Windows 安装器会把 core.autocrlf 写在这里）必须屏蔽
    GIT_CONFIG_NOSYSTEM: '1',
    ...(cfg ? { GIT_CONFIG_GLOBAL: cfg } : {}),
  }
}

/** 异步执行 git，绝不阻塞调用方（这与 isomorphic-git 的本质区别） */
export function runGit(
  workspaceDir: string,
  gitdir: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...baseArgs(workspaceDir, gitdir), ...args], {
      cwd: workspaceDir,
      env: gitEnv(gitdir),
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`git ${args[0]} 超时（${opts.timeoutMs ?? GIT_TIMEOUT_MS}ms）`))
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS)

    child.stdout.on('data', (d) => { stdout += String(d) })
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 探测 `git` 是否可用（只探一次，结果进程级缓存） */
export async function detectGit(workspaceDir: string, gitdir: string): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable
  try {
    const r = await runGit(workspaceDir, gitdir, ['--version'], { timeoutMs: 10_000 })
    gitAvailable = r.code === 0
    log.info(gitAvailable ? `真 git 可用：${r.stdout.trim()}（快路径已启用）` : '真 git 不可用，回退 isomorphic-git')
  } catch {
    gitAvailable = false
    log.warn('真 git 不可用（未安装或不在 PATH），回退 isomorphic-git 全量哈希路径')
  }
  return gitAvailable
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isLockError = (r: GitRunResult) => /index\.lock|Unable to create .*\.lock|File exists/i.test(r.stderr)

/**
 * 带 index.lock 重试地执行 git。
 *
 * 后台快照与用户触发的回滚/还原会并发访问同一 index；真 git 用 index.lock 互斥，
 * 撞上时报 "Unable to create .../index.lock: File exists"。重试比直接失败合理：
 * 两条路径都是短任务（约 100ms），退避几次即可错开。
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
 * ## 为什么每次都要删掉 index 强制全量重算
 *
 * 真 git 默认走 index 的 stat 缓存：mtime/size 没变就跳过读文件，实测**仅 82ms**。
 * 但它会漏掉「等长 + utimesSync 还原 mtime」的改写，而 vcs-repo.test.ts 有一条
 * 用例正是守这个（云同步导入路径确实会 utimesSync）。删掉 index 后 git 无从比对 stat，
 * 只能逐个读文件重算 hash —— **实测 2469ms**，比 isomorphic-git 的 19933ms 快 8 倍，
 * 而且跑在子进程里，主线程零开销。
 *
 * 即：这条保证现在的代价只是"每秒 2.5 秒的后台 CPU"，不再是"每消息冻 20 秒 UI"。
 * 保住它比省下这 2.5 秒重要得多。
 *
 * ⚠️ 82ms 那条路走过的弯路记在这里，免得后人重走：
 * 试过 `-c core.checkStat=default`（Windows 默认 minimal，只比 mtime+size 不比 ctime，
 * 而写文件必然改 ctime）想让 stat 路径也能检出 —— 探针结果自相矛盾（同一配置两次跑结论相反），
 * 说明那只在"index 写入时刻不晚于文件 mtime"的时序巧合下成立，是 git racy 判定的固有随机性，
 * 不可依赖。唯一的确定性判据是用例本身。
 *
 * index 是可由工作树与 HEAD 完全重建的缓存（同 vcs-repo.ts 的 discardIndex），
 * 中途失败不会丢历史，下次快照重建即可。
 */
export async function stageAllCli(workspaceDir: string, gitdir: string): Promise<void> {
  fs.rmSync(path.join(gitdir, 'index'), { force: true })
  const r = await runWithLockRetry(workspaceDir, gitdir, ['add', '-A'])
  if (r.code !== 0) {
    throw new Error(`git add -A 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
}

/**
 * 是否有已暂存变更（index 相对 HEAD）。
 * `diff --cached --quiet` 约定：退出码 1 = 有差异，0 = 无差异，其它为真错误。
 */
export async function hasStagedChangesCli(workspaceDir: string, gitdir: string): Promise<boolean> {
  const r = await runWithLockRetry(workspaceDir, gitdir, ['diff', '--cached', '--quiet'])
  if (r.code === 0) return false
  if (r.code === 1) return true
  throw new Error(`git diff --cached 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
}

/**
 * 提交已暂存内容，返回新 commit 的完整 oid。
 *
 * `--no-verify` 是**行为保持**而非优化：isomorphic-git 从不执行 hook，
 * 而真 git 默认会跑 .mtbot-vcs/hooks 下的 pre-commit / commit-msg。
 */
export async function commitCli(
  workspaceDir: string,
  gitdir: string,
  message: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<string> {
  const args = ['commit', '--no-verify', '-m', message]
  if (opts.allowEmpty) args.push('--allow-empty')
  const r = await runWithLockRetry(workspaceDir, gitdir, args)
  if (r.code !== 0) {
    throw new Error(`git commit 退出码 ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
  }
  const rev = await runGit(workspaceDir, gitdir, ['rev-parse', 'HEAD'])
  if (rev.code !== 0) {
    throw new Error(`git rev-parse 退出码 ${rev.code}: ${rev.stderr.trim().slice(0, 300)}`)
  }
  return rev.stdout.trim()
}
