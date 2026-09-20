/**
 * ShellRunner - 通过子进程执行 Shell/Batch/PowerShell 技能脚本
 *
 * 特性：
 * - 根据文件扩展名 + 平台自动选择 shell 解释器
 * - 通过环境变量 SKILL_PARAMS 传递 JSON 参数
 * - 从 stdout 收集 __SKILL_RESULT__: 前缀的 JSON 结果
 * - 超时自动 kill (SIGTERM → 2s → SIGKILL)
 * - AbortSignal 外部取消
 *
 * 支持的扩展名：
 * - .sh / .bash → bash
 * - .ps1 → powershell (Win)
 * - .bat / .cmd → cmd.exe /c (Win)
 */

import { type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { RunnerOptions, RunnerResult } from './ts-runner'
import { extractResult } from './ts-runner'
import { createLogger } from './logger'
import { killProcessTree, spawnChildInGroup } from './platform/process-kill'
import { buildSafeChildEnv } from './platform/shell-env'

/** 日志 */
const log = createLogger('ShellRunner')

/** 支持的 shell 脚本扩展名 */
const SUPPORTED_EXTENSIONS = new Set(['.sh', '.bash', '.ps1', '.bat', '.cmd'])

/**
 * pwsh（PowerShell Core）在 Linux 上的常见安装位置。
 *
 * **不能只查 PATH**：Electron 从 GUI 启动时未必继承登录 shell 的完整 PATH，
 * 「装了但没进 PATH」是最常见的情况——与 T3.5 处理 CLI 探测时是同一个结论。
 * （官方 apt 包会同时建 `/usr/bin/pwsh` 软链，所以这里列 `/usr/bin` 通常就够。）
 */
function pwshWellKnownPaths(): string[] {
  return [
    '/usr/bin/pwsh',
    '/usr/local/bin/pwsh',
    '/snap/bin/pwsh',
    path.join(os.homedir(), '.local', 'bin', 'pwsh'),
  ]
}

/**
 * 找本机的 pwsh 可执行文件；找不到返回 `null`。
 *
 * @param exists 判断路径是否存在，供测试注入；默认 `fs.existsSync`
 */
export function findPwshExecutable(exists: (p: string) => boolean = fs.existsSync): string | null {
  const fromPath = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'pwsh'))
  for (const candidate of [...pwshWellKnownPaths(), ...fromPath]) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Shell/Batch/PowerShell 技能脚本运行器
 */
export class ShellRunner {
  /**
   * 根据文件扩展名和平台解析 shell 命令
   *
   * @param entryPath - 入口脚本的绝对路径
   * @param deps.exists - 仅供测试注入「路径是否存在」；默认 `fs.existsSync`
   * @returns spawn 参数，不支持的扩展名返回 null
   */
  resolveShell(
    entryPath: string,
    deps: { exists?: (p: string) => boolean } = {},
  ): { command: string; args: string[] } | null {
    const ext = path.extname(entryPath).toLowerCase()
    const isWin = process.platform === 'win32'

    log.debug('解析 shell 命令', { entryPath, ext, isWin })

    switch (ext) {
      case '.ps1':
        if (isWin) {
          return {
            command: 'powershell.exe',
            args: ['-ExecutionPolicy', 'Bypass', '-File', entryPath],
          }
        }
        // Unix 上也可以用 pwsh（如果装了）。**必须先确认它真的在**：
        // 无条件返回 `{ command: 'pwsh' }` 的话，没装时失败发生在 spawn 阶段，
        // 用户看到的是一句底层的 ENOENT，不知道该去装什么；同时
        // `describeUnsupported()` 里那句「请先安装 pwsh」**永远不会被执行到**（曾经如此）。
        // 探测放在解析期，才能把「缺什么」翻译成用户能照做的报错。
        if (!findPwshExecutable(deps.exists)) {
          log.warn('未找到 pwsh（PowerShell Core），无法执行 .ps1 技能', { entryPath })
          return null
        }
        return { command: 'pwsh', args: ['-File', entryPath] }

      case '.bat':
      case '.cmd':
        if (isWin) {
          // chcp 65001 强制 UTF-8 输出，避免 GBK 乱码
          return { command: 'cmd.exe', args: ['/c', `chcp 65001 >nul 2>&1 & "${entryPath}"`] }
        }
        log.warn('.bat/.cmd 脚本是 Windows 专属，当前平台不支持', { entryPath })
        return null

      case '.sh':
      case '.bash':
        return { command: 'bash', args: [entryPath] }

      default:
        log.warn('不支持的脚本扩展名', { ext })
        return null
    }
  }

  /**
   * 把「解析不出 shell」翻译成用户能照着做的报错。
   *
   * 收敛前一律报「不支持的脚本类型: .bat」——在 Linux 上这是**误导**：脚本类型
   * 没问题，是平台不匹配。用户看到这句话不知道该换脚本还是换系统。
   *
   * 两条平台专属分支的前提是 `resolveShell()` 在对应情况下返回 `null`：
   * `.bat/.cmd` 一直如此；`.ps1` **原先不是**（无条件返回 `pwsh`），
   * 所以那句话从未被执行到——现在 `resolveShell()` 会先探测 pwsh 是否存在。
   */
  private describeUnsupported(entryPath: string): string {
    const ext = path.extname(entryPath).toLowerCase()
    if ((ext === '.bat' || ext === '.cmd') && process.platform !== 'win32') {
      return `该技能提供的是 Windows 批处理脚本（${ext}），当前平台无法执行。请改用 .sh 版本，或联系技能作者补充跨平台入口。`
    }
    if (ext === '.ps1' && process.platform !== 'win32') {
      return `该技能提供的是 PowerShell 脚本（.ps1），当前平台需要先安装 pwsh（PowerShell Core）才能执行。`
    }
    return `不支持的脚本类型: ${ext || '(无扩展名)'}`
  }

  /**
   * 执行 Shell 技能脚本
   *
   * 脚本约定：
   * - 通过环境变量 SKILL_PARAMS 读取 JSON 参数
   * - 在 stdout 输出一行 __SKILL_RESULT__:JSON 作为结果
   * - 非零退出码视为失败
   */
  async execute(options: RunnerOptions): Promise<RunnerResult> {
    const startTime = Date.now()
    const { entryPath, params, timeoutMs, abortSignal, cwd, env: extraEnv } = options

    log.info('执行 Shell 技能脚本', { entryPath, timeoutMs })

    // 解析 shell 命令
    const shellCmd = this.resolveShell(entryPath)

    if (!shellCmd) {
      return {
        success: false,
        error: this.describeUnsupported(entryPath),
        exitCode: null,
        executionTimeMs: Date.now() - startTime,
        stdout: '',
        stderr: '',
      }
    }

    const workDir = cwd ?? path.dirname(entryPath)

    return new Promise<RunnerResult>((resolve) => {
      let child: ChildProcess
      let stdout = ''
      let stderr = ''
      let killed = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      try {
        // 白名单构造环境：技能脚本是不可信代码，主进程环境里有 API key / 凭证，
        // 所以默认拒绝、只放行脚本正常工作必需的键。平台差异（Windows 的
        // SYSTEMROOT/PATHEXT、POSIX 的 LANG/DISPLAY/XDG_*）在 shell-env.ts 里统一处理。
        const safeEnv = buildSafeChildEnv(params, extraEnv)

        child = spawnChildInGroup(shellCmd.command, shellCmd.args, {
          cwd: workDir,
          env: safeEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error('启动 Shell 子进程失败', { error: errorMessage })
        return resolve({
          success: false,
          error: `启动 Shell 子进程失败: ${errorMessage}`,
          exitCode: null,
          executionTimeMs: Date.now() - startTime,
          stdout: '',
          stderr: '',
        })
      }

      // 收集 stdout
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })

      // 收集 stderr
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      // 超时处理：直接强制终止进程树
      timeoutId = setTimeout(() => {
        if (!killed) {
          killed = true
          log.warn('Shell 脚本执行超时，终止子进程', { entryPath, timeoutMs })
          this.forceKillProcess(child)
        }
      }, timeoutMs)

      // 外部取消信号
      if (abortSignal) {
        const onAbort = () => {
          if (!killed) {
            killed = true
            log.info('Shell 脚本被外部取消', { entryPath })
            this.forceKillProcess(child)
          }
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }

      // 进程退出
      child.on('close', (exitCode) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }

        const executionTimeMs = Date.now() - startTime

        log.info('Shell 脚本执行完成', {
          entryPath,
          exitCode,
          executionTimeMs,
          killed,
        })

        if (killed) {
          return resolve({
            success: false,
            error: '执行被终止（超时或取消）',
            exitCode,
            executionTimeMs,
            stdout,
            stderr,
          })
        }

        if (exitCode !== 0) {
          return resolve({
            success: false,
            error: stderr.trim() || `进程退出码: ${exitCode}`,
            exitCode,
            executionTimeMs,
            stdout,
            stderr,
          })
        }

        // 从 stdout 中提取结果（复用 TSRunner 的 extractResult）
        const result = extractResult(stdout)

        resolve({
          success: true,
          result,
          exitCode,
          executionTimeMs,
          stdout,
          stderr,
        })
      })

      // 进程错误
      child.on('error', (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
        }

        log.error('Shell 子进程错误', { error: err.message })
        resolve({
          success: false,
          error: `Shell 子进程错误: ${err.message}`,
          exitCode: null,
          executionTimeMs: Date.now() - startTime,
          stdout,
          stderr,
        })
      })
    })
  }

  /**
   * 强制终止子进程（含进程树）
   *
   * 实现已收敛到 `platform/process-kill.ts`——Windows 的 `taskkill /T /F` 与
   * POSIX 的 `SIGTERM → 2s → SIGKILL` 语义由那里统一保证。
   */
  private forceKillProcess(child: ChildProcess): void {
    killProcessTree(child)
  }
}
