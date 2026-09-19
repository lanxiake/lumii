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
 * - **`gc.auto=0`**：见下。
 */

/**
 * 为什么必须关掉真 git 的自动 gc（这条是拿事故换来的）。
 *
 * 这两个仓库是**两种实现共用**的：真 git 负责暂存，isomorphic-git 负责
 * log / diff / readBlob / rollback（工作区）与 fetch / merge / commit / push（云同步）。
 *
 * 真 git 在若干命令后会跑 `gc --auto`，把松散对象打包成 packfile。而 isomorphic-git
 * 读 pack 是**整个读进内存**的，大 pack 直接失败：
 *
 *   Could not read packfile at .../objects/pack/pack-<oid>.pack.
 *   The file may be missing, corrupted, or too large to read into memory.
 *
 * 2026-09-18 实测踩中：工作区 .mtbot-vcs 被压成一个 **1.38GB** 的 pack
 * （松散对象 9877 → 56），sync 仓库 662MB，两个仓库的 isomorphic-git 读路径全废。
 * 关掉 auto-gc 后对象只以松散形式增长，两种实现都能读。
 *
 * 代价是对象目录会慢慢变大（本就不小的 1.5GB 量级）。**这是刻意的取舍**：
 * 仓库形状必须迁就能力更弱的那一方。
 */
export const GIT_BASE_CONFIG: readonly string[] = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'index.version=2',
  '-c', 'gc.auto=0',
]

/** `git` 是否可用——进程级缓存，只探一次 */
let gitAvailable: boolean | null = null

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
  /** 仅当 runGit 传了 raw: true 时有值；此时 stdout 为空串 */
  stdoutRaw?: Buffer
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
    // 强制英文输出：git 的错误信息随 locale 变化，而调用方会按字符串匹配错误类型。
    // 例：workspace-vcs 的 isIndexCorruptionError 只认 'bad signature' /
    // 'index file corrupt'，中文 locale 下 git 报「坏的签名」「索引文件损坏」，
    // 自愈机制会静默失效（实测 LANG=zh_CN.UTF-8 复现）。钉死英文后两种 locale 行为一致，
    // 也避免将来往匹配表里逐个语言堆字符串。LC_ALL 优先级高于 LC_MESSAGES/LANG。
    LC_ALL: 'C',
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
 * stderr 里有没有真 git 的致命错误。
 *
 * **为什么不能只看退出码**：实测 `git status --porcelain -z ...` 在 index 损坏时
 * 会往 stderr 写 `fatal: <path>: index file smaller than expected`，然后**以退出码 0
 * 结束**。只看退出码会把一次彻底失败当成成功，拿到半截输出继续解析 ——
 * 这类「退出码 0 但什么也没干成」是这套工具最容易骗过人的地方（拆包脚本那次事故
 * 也是同一个形状）。
 *
 * 匹配 `fatal:` / `error:` 行首：普通诊断（warning / hint）不在此列，不会误判。
 */
export function hasFatalError(stderr: string): boolean {
  return /^(fatal|error):/m.test(stderr)
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
  /** 追加/覆盖的环境变量（覆盖 gitEnvFor 的同名项），如 GIT_INDEX_FILE */
  env?: Record<string, string>
  /**
   * 以字节返回 stdout（默认按 UTF-8 转字符串）。
   *
   * 读 blob（`git show <oid>:<path>`）必须开这个：逐 chunk `String(d)` 再拼接会把
   * 多字节序列在 chunk 边界处截断、二进制内容直接毁掉。二进制文件要原样写回工作树，
   * 所以 `stdoutRaw` 与 `stdout` 在 raw 模式下**只填一个**，别混用。
   */
  raw?: boolean
  /**
   * 写到子进程 stdin 的内容（写入后立即 end）。
   *
   * **不传就等于 stdin 是空的，会立刻关闭** —— 这一点很关键：`git commit -F -`
   * 之类的命令会一直等 stdin 读到 EOF，若只 spawn 不写不关，进程就永远挂着
   * （本模块第一版把 message 走 `-F -` 却没接 stdin，整个测试套直接跑不完）。
   */
  stdin?: string
}): Promise<GitRunResult> {
  const argv = gitArgv(opts)
  return new Promise((resolve, reject) => {
    const child = spawn('git', argv, {
      cwd: opts.workTree,
      env: { ...gitEnvFor(opts.gitDir), ...(opts.env ?? {}) },
      windowsHide: true,
    })
    // 无论有没有内容都要 end()，见上面 stdin 的说明
    child.stdin.on('error', () => { /* 子进程提前退出时 EPIPE，由 close 统一处理 */ })
    child.stdin.end(opts.stdin ?? '')

    let stdout = ''
    let stderr = ''
    const outChunks: Buffer[] = []
    let settled = false
    const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`git ${opts.args[0]} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      if (opts.raw) outChunks.push(d)
      else stdout += String(d)
    })
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
      const result: GitRunResult = { code: code ?? -1, stdout, stderr }
      if (opts.raw) result.stdoutRaw = Buffer.concat(outChunks)
      resolve(result)
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
