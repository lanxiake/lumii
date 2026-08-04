/**
 * 本地 Shell 执行 — ToolExecutionContext.executeCommand 实现
 *
 * 复用 NodeCommandHandler 中的 spawn 逻辑，
 * 但剥离 Gateway 相关的 InvokeResult 包装，直接返回输出。
 *
 * 主题4 P1：shell 选择委托给 @mtbot/agent-runtime 的 resolveShell（bash everywhere + cmd 降级）。
 */

import { spawn } from 'child_process'
import * as iconv from 'iconv-lite'
import { resolveShell } from '@mtbot/agent-runtime'

// 主题3 P1-1：输出上限提升到 1MB（配合 tool-result-persist hook 落盘）。
// 超出时截断并追加告警，避免单条命令输出撑爆上下文。
const OUTPUT_CAP = 1_000_000
const DEFAULT_TIMEOUT_MS = 120_000

export async function executeLocalCommand(
  command: string,
  opts?: {
    cwd?: string
    timeoutMs?: number
    shell?: string
    signal?: AbortSignal
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts?.cwd ?? process.cwd()
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // 主题4 P1：委托 resolveShell 决定 shell 路径/参数/编码（bash 优先，失败降级 cmd）。
  const resolved = resolveShell({ command, explicitShell: opts?.shell })
  const shellPath = resolved.shellPath
  const shellArgs = resolved.args
  const usingCmdFallback = resolved.encoding === 'cp936'
  const signal = opts?.signal

  return new Promise((resolve) => {
    // 用户已提前中断：不启动子进程，直接返回
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: '[Command aborted by user]', exitCode: 130 })
      return
    }

    const child = spawn(shellPath, shellArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let outputTruncated = false
    let killedByTimeout = false
    let abortedByUser = false

    child.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes <= OUTPUT_CAP) {
        stdoutChunks.push(chunk)
      } else {
        outputTruncated = true
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes <= OUTPUT_CAP) {
        stderrChunks.push(chunk)
      } else {
        outputTruncated = true
      }
    })

    // SIGTERM 优雅终止，2s 后强制 SIGKILL（超时与用户中断共用）
    const killChild = (): void => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000)
    }

    const timer = setTimeout(() => {
      killedByTimeout = true
      killChild()
    }, timeoutMs)

    const onAbort = (): void => {
      abortedByUser = true
      killChild()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const decodeBuffer = (chunks: Buffer[]): string => {
        const raw = Buffer.concat(chunks)
        // 仅 cmd.exe fallback 走 cp936（cmd 默认 GBK 输出）；
        // Git Bash / 显式 shell / 非 Windows 一律按 UTF-8 解码。
        if (usingCmdFallback) {
          try {
            return iconv.decode(raw, 'cp936')
          } catch {
            return raw.toString('utf-8')
          }
        }
        return raw.toString('utf-8')
      }

      const stdout = decodeBuffer(stdoutChunks)
      const stderr = decodeBuffer(stderrChunks)

      const truncationNote = outputTruncated
        ? `\n[输出超过 ${OUTPUT_CAP} 字节上限已截断（实际 ${totalBytes} 字节）。如需完整输出，请将命令结果重定向到文件后用 file_read 分页读取。]`
        : ''

      if (abortedByUser) {
        resolve({
          stdout,
          stderr: stderr + truncationNote + '\n[Command aborted by user]',
          exitCode: code ?? 130,
        })
      } else if (killedByTimeout) {
        resolve({
          stdout,
          stderr: stderr + truncationNote + '\n[Command timed out]',
          exitCode: code ?? 124,
        })
      } else {
        resolve({ stdout, stderr: stderr + truncationNote, exitCode: code ?? 0 })
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({
        stdout: '',
        stderr: `Failed to spawn command: ${err.message}`,
        exitCode: 1,
      })
    })
  })
}
