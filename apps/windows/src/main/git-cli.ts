/**
 * 真 git 子进程调用（共享底座）
 *
 * 抽出来是因为两个模块都需要它，而且都需要**同一套微妙的配置隔离** ——
 * 复制两份必然漂移，而漂移的后果是静默的（见下方 baseConfig 的说明）。
 *
 *  - `workspace-vcs`：工作区自动快照的暂存 + 提交
 *  - `cloud-sync`：sync 仓库的暂存
 *
 * 两者的共同点是「isomorphic-git 按内容全量重算 blob hash」这一步太贵且跑在主线程上：
 * 实测工作区 2.7GB / 12866 文件中位 19.9 秒、sync 仓库 1.3GB 可达 600 秒，
 * 而同样的事交给真 git 子进程只要百毫秒级，且完全不占主线程
 * （2026-09-18 客户端卡死即由此而来，见 vcs-git-cli.ts 文件头）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const log = {
  info: (...args: unknown[]) => console.log('[git-cli]', ...args),
  warn: (...args: unknown[]) => console.warn('[git-cli]', ...args),
}

/** 单次 git 命令的默认超时；超时即杀，绝不无限等 */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000

/**
 * 两个仓库都必须带上的 `-c`，**每一条都是必须的**：
 *
 * - `core.autocrlf=false`：真 git 若按平台默认做 CRLF 转换，blob hash 会与
 *   isomorphic-git 写下的不同，整个工作树会被看成「全部已修改」——灾难性假阳性。
 *   （默认配置下 add 会刷 `LF will be replaced by CRLF` 警告，正是这个来源。）
 * - `commit.gpgsign=false`：用户全局开了签名时，自动提交会去调 gpg（可能弹窗/挂住）。
 * - `index.version=2`：isomorphic-git 只支持 v2，真 git 在 feature.manyFiles 下会写 v4。
 * - `core.safecrlf=false`：配合 autocrlf=false，避免对混合行尾直接报错中断。
 */
export const GIT_BASE_CONFIG: readonly string[] = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'index.version=2',
]

/** `git` 是否可用——进程级缓存，只探一次 */
let gitAvailable: boolean | null = null

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/** 已确保写过空配置的 gitdir（每个进程写一次即可） */
const emptyConfigReady = new Map<string, string>()

/**
 * 隔离用户全局 git 配置用的空文件，返回其路径（失败时返回空串）。
 *
 * 不隔离会引入静默漂移：用户全局的 `core.excludesFile` 会把文件挡在提交之外，
 * 而 isomorphic-git 不读全局配置。放在 gitdir 内（工作树之外），不会被扫到。
 */
function ensureEmptyConfig(gitDir: string): string {
  const cached = emptyConfigReady.get(gitDir)
  if (cached !== undefined) return cached
  const p = path.join(gitDir, 'mtbot-gitconfig-empty')
  let result = ''
  try {
    fs.mkdirSync(gitDir, { recursive: true })
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8')
    result = p
  } catch {
    /* 写不了就不隔离，命令仍可执行 */
  }
  emptyConfigReady.set(gitDir, result)
  return result
}

/** 构造 git 环境变量（提交身份走环境变量，避免读写用户 config） */
export function gitEnvFor(gitDir: string, author = { name: 'Mtbot', email: 'vcs@mtbot.local' }): NodeJS.ProcessEnv {
  const cfg = ensureEmptyConfig(gitDir)
  return {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    // 系统级 config（Git for Windows 安装器会把 core.autocrlf 写在这里）必须屏蔽
    GIT_CONFIG_NOSYSTEM: '1',
    ...(cfg ? { GIT_CONFIG_GLOBAL: cfg } : {}),
  }
}

/** 组装完整参数（供执行与日志共用，避免两处拼得不一样） */
export function gitArgv(opts: {
  workTree: string
  gitDir: string
  args: readonly string[]
  config?: readonly string[]
}): string[] {
  return [
    ...GIT_BASE_CONFIG,
    ...(opts.config ?? []),
    `--git-dir=${opts.gitDir}`,
    `--work-tree=${opts.workTree}`,
    ...opts.args,
  ]
}

/**
 * 异步执行 git，绝不阻塞调用方（这与 isomorphic-git 的本质区别）。
 *
 * `cwd` 必须落在工作树内：`--git-dir`/`--work-tree` 不能替代它 ——
 * 否则 `add -A` 的隐式 pathspec 匹配不到任何东西，会**静默返回 0 而什么都没做**
 * （本模块第一版测量脚本就踩过这个坑，测出来的耗时全是假的）。
 */
export function runGit(opts: {
  workTree: string
  gitDir: string
  args: readonly string[]
  config?: readonly string[]
  timeoutMs?: number
}): Promise<GitRunResult> {
  const argv = gitArgv(opts)
  return new Promise((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd: opts.workTree,
      env: gitEnvFor(opts.gitDir),
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`git ${opts.args[0]} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

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

/**
 * 探测 `git` 是否可用（只探一次，结果进程级缓存）。
 * 不可用时调用方应回退 isomorphic-git 全量哈希路径（慢但零系统依赖）。
 *
 * 刻意不走 runGit：探测与任何仓库无关，带上 `--git-dir`/`--work-tree` 会顺带
 * 在磁盘上造出配置目录，只为了问一句版本号。
 */
export async function detectGit(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable
  gitAvailable = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn('git', ['--version'], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.on('error', () => done(false))
      child.on('close', (code) => {
        if (code === 0) log.info(`真 git 可用：${out.trim()}（快路径已启用）`)
        else log.warn('真 git 不可用，回退 isomorphic-git 全量哈希路径')
        done(code === 0)
      })
      setTimeout(() => { child.kill(); done(false) }, 10_000)
    } catch {
      done(false)
    }
  })
  return gitAvailable
}
