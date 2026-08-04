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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import type { RunnerOptions, RunnerResult } from './ts-runner'
import { extractResult } from './ts-runner'
import { createLogger } from './logger'

/** 日志 */
const log = createLogger('ShellRunner')

/** 支持的 shell 脚本扩展名 */
const SUPPORTED_EXTENSIONS = new Set(['.sh', '.bash', '.ps1', '.bat', '.cmd'])

/**
 * Shell/Batch/PowerShell 技能脚本运行器
 */
export class ShellRunner {
  /**
   * 根据文件扩展名和平台解析 shell 命令
   *
   * @param entryPath - 入口脚本的绝对路径
   * @returns spawn 参数，不支持的扩展名返回 null
   */
  resolveShell(entryPath: string): { command: string; args: string[] } | null {
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
        // Unix 上也可以用 pwsh（如果安装了）
        return { command: 'pwsh', args: ['-File', entryPath] }

      case '.bat':
      case '.cmd':
        if (isWin) {
          // chcp 65001 强制 UTF-8 输出，避免 GBK 乱码
          return { command: 'cmd.exe', args: ['/c', `chcp 65001 >nul 2>&1 & "${entryPath}"`] }
        }
        log.warn('.bat/.cmd 脚本不支持在非 Windows 平台运行')
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
      const ext = path.extname(entryPath).toLowerCase()
      return {
        success: false,
        error: `不支持的脚本类型: ${ext}`,
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
        // 只传递必要的环境变量，避免暴露敏感信息（API密钥、数据库凭证等）
        const safeEnv: Record<string, string> = {
          PATH: process.env.PATH || '',
          HOME: process.env.HOME || process.env.USERPROFILE || '',
          TEMP: process.env.TEMP || process.env.TMP || '',
          SKILL_PARAMS: JSON.stringify(params),
        }

        // Windows 特定环境变量
        if (process.platform === 'win32') {
          if (process.env.USERPROFILE)           safeEnv.USERPROFILE           = process.env.USERPROFILE
          if (process.env.SYSTEMROOT)            safeEnv.SYSTEMROOT            = process.env.SYSTEMROOT
          if (process.env.WINDIR)                safeEnv.WINDIR                = process.env.WINDIR
          if (process.env.APPDATA)               safeEnv.APPDATA               = process.env.APPDATA
          if (process.env.LOCALAPPDATA)          safeEnv.LOCALAPPDATA          = process.env.LOCALAPPDATA
          if (process.env.COMSPEC)               safeEnv.COMSPEC               = process.env.COMSPEC
          if (process.env.PATHEXT)               safeEnv.PATHEXT               = process.env.PATHEXT
          if (process.env.HOMEDRIVE)             safeEnv.HOMEDRIVE             = process.env.HOMEDRIVE
          if (process.env.HOMEPATH)              safeEnv.HOMEPATH              = process.env.HOMEPATH
          const pf   = process.env['ProgramFiles']
          const pf86 = process.env['ProgramFiles(x86)']
          if (pf)   safeEnv['ProgramFiles']       = pf
          if (pf86) safeEnv['ProgramFiles(x86)'] = pf86
        }

        // 合并调用方传入的自定义环境变量（保护 SKILL_PARAMS 不被覆盖）
        if (extraEnv) {
          for (const [k, v] of Object.entries(extraEnv)) {
            if (k !== 'SKILL_PARAMS') safeEnv[k] = v
          }
        }

        child = spawn(shellCmd.command, shellCmd.args, {
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
   * Windows 上 SIGTERM 对 cmd.exe/powershell 子进程树无效，
   * 需要使用 taskkill /T /F 来终止整个进程树。
   * Unix 上使用 SIGTERM → 2s → SIGKILL 的标准流程。
   */
  private forceKillProcess(child: ChildProcess): void {
    const pid = child.pid
    if (!pid) {
      child.kill('SIGKILL')
      return
    }

    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true })
        log.debug('Windows 进程树已终止', { pid })
      } catch {
        // taskkill 失败时 fallback 到普通 kill
        child.kill('SIGKILL')
      }
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL')
        }
      }, 2000)
    }
  }
}
