/**
 * PythonRunner - 通过子进程执行 Python 技能脚本
 *
 * 特性：
 * - 自动检测可用的 Python 解释器 (venv > python3 > python > py -3)
 * - 通过环境变量 SKILL_PARAMS 传递 JSON 参数
 * - 从 stdout 收集 __SKILL_RESULT__: 前缀的 JSON 结果
 * - 强制 UTF-8 输出编码
 * - 超时自动 kill (SIGTERM → 2s → SIGKILL)
 * - AbortSignal 外部取消
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { RunnerOptions, RunnerResult } from './ts-runner'
import { extractResult } from './ts-runner'
import { detectSystemPython, ensureBundledPython } from './python-env'
import { buildScriptEnv } from './runtime-env'

/** 日志 */
const log = {
  info: (...args: unknown[]) => console.log('[PythonRunner]', ...args),
  error: (...args: unknown[]) => console.error('[PythonRunner]', ...args),
  warn: (...args: unknown[]) => console.warn('[PythonRunner]', ...args),
  debug: (...args: unknown[]) => console.log('[PythonRunner:Debug]', ...args),
}

/**
 * Python 技能脚本运行器
 */
export class PythonRunner {
  /**
   * 检测可用的 Python 解释器
   *
   * 优先级：
   * 1. skillDir 下的 .venv/Scripts/python.exe (Win) 或 .venv/bin/python (Unix)
   * 2. 系统 Python 3（python3 → python → py -3，见 python-env.ts）
   * 3. 内置 embeddable 运行时（缺失时自动下载，用户无需自行安装）
   *
   * @param skillDir - 可选的技能目录，用于检测虚拟环境
   * @returns Python 可执行文件路径，彻底不可用时返回 null
   */
  async detectPython(skillDir?: string): Promise<string | null> {
    // 1. 技能自带虚拟环境优先
    if (skillDir) {
      const venvPython = this.detectVenvPython(skillDir)
      if (venvPython) {
        log.info('检测到虚拟环境 Python', { path: venvPython })
        return venvPython
      }
    }

    // 2. 系统 Python（探测结果在 python-env 内部缓存）
    const system = detectSystemPython()
    if (system) {
      log.info('使用系统 Python', { command: system })
      return system
    }

    // 3. 内置运行时；未就绪则现场装（并发调用共用同一次安装）
    try {
      log.info('系统无 Python，回退内置运行时')
      return await ensureBundledPython((msg) => log.info(msg))
    } catch (err) {
      log.error('内置 Python 准备失败', { error: err instanceof Error ? err.message : err })
      return null
    }
  }

  /**
   * 执行 Python 技能脚本
   *
   * 脚本约定：
   * - 通过 os.environ['SKILL_PARAMS'] 读取 JSON 参数
   * - 在 stdout 输出一行 __SKILL_RESULT__:JSON 作为结果
   * - 非零退出码视为失败
   */
  async execute(options: RunnerOptions): Promise<RunnerResult> {
    const startTime = Date.now()
    const { entryPath, params, timeoutMs, abortSignal, cwd, env: extraEnv } = options

    log.info('执行 Python 技能脚本', { entryPath, timeoutMs })

    // 检测 Python 解释器
    const skillDir = cwd ?? path.dirname(entryPath)
    const pythonPath = await this.detectPython(skillDir)

    if (!pythonPath) {
      log.error('未找到 Python 解释器')
      return {
        success: false,
        error: '未找到可用的 Python 3 解释器，且内置运行时下载失败。请检查网络后重试，或自行安装 Python 3。',
        exitCode: null,
        executionTimeMs: Date.now() - startTime,
        stdout: '',
        stderr: '',
      }
    }

    // 构建命令参数
    const args = this.buildArgs(pythonPath, entryPath)

    return new Promise<RunnerResult>((resolve) => {
      let child: ChildProcess
      let stdout = ''
      let stderr = ''
      let killed = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      try {
        child = spawn(args.command, args.args, {
          cwd: skillDir,
          env: buildScriptEnv({
            ...(extraEnv ?? {}),
            SKILL_PARAMS: JSON.stringify(params),
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        log.error('启动 Python 子进程失败', { error: errorMessage })
        return resolve({
          success: false,
          error: `启动 Python 子进程失败: ${errorMessage}`,
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

      // 超时处理：SIGTERM → 2s → SIGKILL
      timeoutId = setTimeout(() => {
        if (!killed) {
          killed = true
          log.warn('Python 脚本执行超时，终止子进程', { entryPath, timeoutMs })
          child.kill('SIGTERM')
          setTimeout(() => {
            if (!child.killed) {
              child.kill('SIGKILL')
            }
          }, 2000)
        }
      }, timeoutMs)

      // 外部取消信号
      if (abortSignal) {
        const onAbort = () => {
          if (!killed) {
            killed = true
            log.info('Python 脚本被外部取消', { entryPath })
            child.kill('SIGTERM')
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

        log.info('Python 脚本执行完成', {
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

        log.error('Python 子进程错误', { error: err.message })
        resolve({
          success: false,
          error: `Python 子进程错误: ${err.message}`,
          exitCode: null,
          executionTimeMs: Date.now() - startTime,
          stdout,
          stderr,
        })
      })
    })
  }

  /**
   * 检测虚拟环境中的 Python
   */
  private detectVenvPython(skillDir: string): string | null {
    const isWin = process.platform === 'win32'
    const venvPython = isWin
      ? path.join(skillDir, '.venv', 'Scripts', 'python.exe')
      : path.join(skillDir, '.venv', 'bin', 'python')

    try {
      fs.accessSync(venvPython, fs.constants.X_OK)
      return venvPython
    } catch {
      return null
    }
  }

  /**
   * 构建 spawn 参数
   */
  private buildArgs(pythonPath: string, entryPath: string): { command: string; args: string[] } {
    if (pythonPath === 'py') {
      return { command: 'py', args: ['-3', entryPath] }
    }
    return { command: pythonPath, args: [entryPath] }
  }
}
