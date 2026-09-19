/**
 * 安全策略的平台抽象（设计 §5.4）。
 *
 * 收敛前的 `security-utils.ts:38-68` 把两套平台规则混在一个常量里：
 * `allowedCommands` 全是 Windows 命令（powershell / cmd / tasklist / wmic），
 * 而 `forbiddenPatterns` 又混着 `/etc`、`/var` 这类 POSIX 路径。结果两边都不完整：
 *
 * - **Linux 上命令白名单形同废纸**：`bash`、`sh`、`ls`、`pkill` 一个都不在里面，
 *   `isCommandAllowed('ls')` 返回 false，而 `powershell` 反而"合法"（虽然根本不存在）。
 * - **`/^\/var/i` 过宽**：`/var/tmp` 是 POSIX 的临时目录之一，可能属于 `os.tmpdir()`，
 *   被它拦掉会让正常的临时文件操作失败。设计 §5.4 要求收窄到 `/var/lib`、`/var/spool`。
 * - **长度上限硬编码 260**：那是 Windows 的 `MAX_PATH`；POSIX 的 `PATH_MAX` 通常是 4096。
 *   但**Windows 侧不改**——那是越权防护，直接放宽会引入安全回归。
 *
 * **允许根优先于禁止模式**：设计 §5.4 明确要求。现状是先查 `forbiddenPatterns`
 * 再查 `allowedBasePaths`，于是"家目录下某个名字碰巧匹配黑名单"的路径会被误拦
 * （如 `~/secrets/notes.txt` 撞上 `/secrets/i`）。允许根是明确的白名单意图，
 * 应当压过黑名单的模糊匹配。
 */

export interface SecurityPolicy {
  /** 允许访问的基础目录 */
  allowedBasePaths: string[]
  /** 禁止访问的路径模式 */
  forbiddenPatterns: RegExp[]
  /** 允许执行的命令白名单 */
  allowedCommands: string[]
  /** 路径长度上限（字符数） */
  maxPathLength: number
  /** 路径深度上限 */
  maxPathDepth: number
}

import * as os from 'node:os'

/**
 * **凭证类**禁止模式——即使落在允许根内也必须拦。
 *
 * T3.4 实测发现的坑：设计 §5.4 要求「允许根优先于禁止模式」（为了不误伤
 * `~/secrets/notes.txt` 这类正常文件），但那条规则会**顺手放行**
 * `~/.ssh/id_rsa`——它同样在家目录内。凭证是「不可放行」的一类，
 * 与「名字碰巧撞黑名单」是两回事，必须单独拎出来、优先于允许根判断。
 */
export const CREDENTIAL_FORBIDDEN: RegExp[] = [
  /(?:^|[\\/])\.ssh(?:[\\/]|$)/i, // SSH 私钥
  /(?:^|[\\/])\.gnupg(?:[\\/]|$)/i, // GPG 私钥
  /(?:^|[\\/])\.aws(?:[\\/]|$)/i, // AWS 凭证
  /(?:^|[\\/])\.azure(?:[\\/]|$)/i, // Azure 凭证
  /(?:^|[\\/])\.kube(?:[\\/]|$)/i, // k8s 凭证
  /(?:^|[\\/])\.docker(?:[\\/]|$)/i, // Docker registry 凭证
  /(?:^|[\\/])credentials(?:[\\/.]|$)/i,
  /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/i, // .env / .env.local 等
]

/**
 * 两平台共有的禁止模式（`..` 限定为路径组件，避免误伤 `a..b.txt`）。
 */
const SHARED_FORBIDDEN: RegExp[] = [
  /(?:^|[\\/])\.\.(?:[\\/]|$)/, // 路径遍历（仅匹配路径组件）
  ...CREDENTIAL_FORBIDDEN,
  /secrets/i,
]

/**
 * POSIX 的禁止模式。
 *
 * 比 Windows 侧更细：`/usr`、`/boot`、`/proc`、`/sys`、`/dev`、`/root` 都补上——
 * 这些是系统与内核的领地，误写会直接影响机器可用性。
 * `/var` 收窄到 `/var/lib`（服务状态）与 `/var/spool`（队列），**不含 `/var/tmp`**。
 */
const POSIX_FORBIDDEN: RegExp[] = [
  ...SHARED_FORBIDDEN,
  /^\/etc(?:\/|$)/i,
  /^\/var\/lib(?:\/|$)/i,
  /^\/var\/spool(?:\/|$)/i,
  /^\/usr(?:\/|$)/i,
  /^\/boot(?:\/|$)/i,
  /^\/proc(?:\/|$)/i,
  /^\/sys(?:\/|$)/i,
  /^\/dev(?:\/|$)/i,
  /^\/root(?:\/|$)/i,
  /^\/lost\+found(?:\/|$)/i,
]

/** Windows 的禁止模式（与收敛前逐条一致，不减不增） */
const WINDOWS_FORBIDDEN: RegExp[] = [
  ...SHARED_FORBIDDEN,
  /^C:\\Windows/i,
  /^C:\\Program Files/i,
  /^C:\\ProgramData/i,
  /System32/i,
]

/**
 * POSIX 命令白名单。
 *
 * 只放行**只读查询**与**进程管理**两类——`executeCommand` 的调用方是技能探测
 * （查进程、看磁盘、结束卡死的进程），不需要任意执行能力。
 * 刻意**不放** `rm`、`curl`、`chmod`、`sudo` 这类会改状态或拉外部内容的命令：
 * 技能有自己的执行通道（`executeLocalCommand`），那条路不经这里。
 */
const POSIX_COMMANDS = ['bash', 'sh', 'ps', 'kill', 'pkill', 'df', 'free', 'du', 'ls', 'cat', 'pgrep']

/** Windows 命令白名单（与收敛前逐条一致，避免改变既有行为） */
const WINDOWS_COMMANDS = ['powershell', 'cmd', 'tasklist', 'taskkill', 'systeminfo', 'wmic']

function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * 取当前平台的完整策略。
 *
 * 返回值是**新对象**，调用方可以自由改（`SecurityUtils` 会与用户传入的 config 合并）。
 * 每次调用都重新读 `process.platform`，不在模块顶层缓存——那样会让单测无法切平台。
 */
export function getSecurityPolicy(): SecurityPolicy {
  // 两平台的临时目录写法不同：POSIX 是 /tmp，Windows 上 os.tmpdir() 会给
  // C:\Users\...\AppData\Local\Temp。都交给 os.tmpdir() 而不是硬编码。
  const allowedBasePaths = [os.homedir(), os.tmpdir()]

  return isWindows()
    ? {
        allowedBasePaths,
        forbiddenPatterns: WINDOWS_FORBIDDEN,
        allowedCommands: WINDOWS_COMMANDS,
        // Windows 的 MAX_PATH：**保持 260 不变**，放宽会引入安全回归
        maxPathLength: 260,
        maxPathDepth: 20,
      }
    : {
        allowedBasePaths,
        forbiddenPatterns: POSIX_FORBIDDEN,
        allowedCommands: POSIX_COMMANDS,
        // POSIX 的 PATH_MAX 通常为 4096；用 1024 留出余量，仍能挡住异常超长路径
        maxPathLength: 1024,
        maxPathDepth: 64,
      }
}

/**
 * 路径是否落在允许根之内。
 *
 * 单独导出是为了让「允许根优先于禁止模式」这条规则可测——调用方在查黑名单**之前**
 * 先用它短路。
 */
export function isUnderAllowedBase(
  normalizedPath: string,
  allowedBasePaths: readonly string[],
): boolean {
  return allowedBasePaths.some((base) => {
    if (!base) return false
    // 统一分隔符后比前缀，避免 Windows 上 \ 与 / 混用导致的漏判
    const normBase = base.replace(/[\\/]+$/, '').replace(/\\/g, '/')
    const normPath = normalizedPath.replace(/\\/g, '/')
    return normPath === normBase || normPath.startsWith(`${normBase}/`)
  })
}
