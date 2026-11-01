/**
 * 本地 Shell 执行 — ToolExecutionContext.executeCommand 实现
 *
 * 复用 NodeCommandHandler 中的 spawn 逻辑，
 * 但剥离 Gateway 相关的 InvokeResult 包装，直接返回输出。
 *
 * 主题4 P1：shell 选择委托给 @mtbot/agent-runtime 的 resolveShell（bash everywhere + cmd 降级）。
 */

// 与 shell-runner / ts-runner / python-runner 保持一致：统一用 node: 前缀。
// 四处 forceKillProcess 将被 T3.1 合并到 main/platform/process-kill.ts，
// 导入写法统一可避免合并时漏改。
import { type ChildProcess } from 'node:child_process'
import * as iconv from 'iconv-lite'
import { resolveShell } from '@mtbot/agent-runtime'
import { buildScriptEnv } from '../../runtime-env'
import { destroyChildStdio, killProcessTree, spawnChildInGroup } from '../../platform/process-kill'

/**
 * 强制终止子进程（含进程树）。
 * Windows 上 SIGTERM/SIGKILL 只杀 shell 本身，孙进程（如 bash -c 里再起的 python）
 * 不会被终止，其占用的 stdio 管道 handle 会导致 'close' 事件永远不触发、Promise 永久挂起。
 *
 * 实现已收敛到 `platform/process-kill.ts`（与三个 runner 共用）。
 */
function forceKillProcess(child: ChildProcess): void {
  killProcessTree(child)
}

/** 输出上限（配合 tool-result-persist hook 落盘） */
const OUTPUT_CAP = 1_000_000
/** bash 默认超时 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 超时前多久触发续期询问 */
export const DEFAULT_RENEWAL_LEAD_MS = 60_000
/** 单次续期上限（与 bash timeoutMs 文档上限对齐） */
export const MAX_RENEWAL_EXTEND_MS = 600_000

export type ApproachingTimeoutInfo = {
  command: string
  elapsedMs: number
  remainingMs: number
  timeoutMs: number
}

export type ExecuteLocalCommandOpts = {
  cwd?: string
  timeoutMs?: number
  shell?: string
  signal?: AbortSignal
  /** 距超时还剩 renewalLeadMs 时回调；返回 extendMs>0 则延长 deadline */
  onApproachingTimeout?: (info: ApproachingTimeoutInfo) => Promise<{ extendMs: number }>
  /** 续期询问提前量，默认 60s */
  renewalLeadMs?: number
}

/**
 * 在本机执行一条 shell 命令。
 *
 * - 超时/中止后**立即 settle**（对齐 `platform/shell-command.ts`），不死等 `close`
 * - 可选：超时前 `renewalLeadMs` 触发 `onApproachingTimeout`，按返回的 `extendMs` 重置 deadline
 */
export async function executeLocalCommand(
  command: string,
  opts?: ExecuteLocalCommandOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts?.cwd ?? process.cwd()
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const renewalLeadMs = opts?.renewalLeadMs ?? DEFAULT_RENEWAL_LEAD_MS
  const onApproachingTimeout = opts?.onApproachingTimeout
  const resolved = resolveShell({ command, explicitShell: opts?.shell })
  const shellPath = resolved.shellPath
  const shellArgs = resolved.args
  const usingCmdFallback = resolved.encoding === 'cp936'
  const signal = opts?.signal

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: '[Command aborted by user]', exitCode: 130 })
      return
    }

    const child = spawnChildInGroup(shellPath, shellArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildScriptEnv(),
      windowsHide: true,
    })

    const startedAt = Date.now()
    let deadlineAt = startedAt + timeoutMs
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let warnTimer: ReturnType<typeof setTimeout> | null = null

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let outputTruncated = false
    let killedByTimeout = false
    let abortedByUser = false
    let settled = false

    /** 解码已收集的 stdout/stderr 块 */
    const decodeBuffer = (chunks: Buffer[]): string => {
      const raw = Buffer.concat(chunks)
      if (usingCmdFallback) {
        try {
          return iconv.decode(raw, 'cp936')
        } catch {
          return raw.toString('utf-8')
        }
      }
      return raw.toString('utf-8')
    }

    /** 清理所有定时器 */
    const clearTimers = (): void => {
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
      if (warnTimer) {
        clearTimeout(warnTimer)
        warnTimer = null
      }
    }

    /** 只 settle 一次；超时/abort/close/error 共用 */
    const settle = (exitCode: number, stderrExtra = ''): void => {
      if (settled) return
      settled = true
      clearTimers()
      signal?.removeEventListener('abort', onAbort)

      const truncationNote = outputTruncated
        ? `\n[输出超过 ${OUTPUT_CAP} 字节上限已截断（实际 ${totalBytes} 字节）。如需完整输出，请将命令结果重定向到文件后用 file_read 分页读取。]`
        : ''
      const stdout = decodeBuffer(stdoutChunks)
      const stderr = decodeBuffer(stderrChunks) + truncationNote + stderrExtra
      resolve({ stdout, stderr, exitCode })
    }

    /** 杀进程树并掐断 stdio；不等 close */
    const killChild = (): void => {
      forceKillProcess(child)
      destroyChildStdio(child)
    }

    /** 按当前 deadline 安排超时杀进程 */
    const scheduleKill = (): void => {
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
      const delay = Math.max(0, deadlineAt - Date.now())
      killTimer = setTimeout(() => {
        killedByTimeout = true
        killChild()
        settle(124, '\n[Command timed out]')
      }, delay)
    }

    /**
     * 在 deadline 前 renewalLeadMs 触发续期回调；可多次续期。
     * 询问期间命令不停；若返回 extendMs>0，从此刻重置 deadline。
     */
    const scheduleWarn = (): void => {
      if (warnTimer) {
        clearTimeout(warnTimer)
        warnTimer = null
      }
      if (!onApproachingTimeout || renewalLeadMs <= 0) return
      // 本段剩余必须大于 lead，才有「提前 1 分钟」的窗口（避免一启动就弹）
      if (deadlineAt - Date.now() <= renewalLeadMs) return

      const delay = deadlineAt - renewalLeadMs - Date.now()
      if (delay < 0) return

      warnTimer = setTimeout(() => {
        void (async () => {
          if (settled || signal?.aborted) return
          const remainingMs = Math.max(0, deadlineAt - Date.now())
          if (remainingMs <= 0) return

          let extendMs = 0
          try {
            const answer = await Promise.race([
              onApproachingTimeout({
                command,
                elapsedMs: Date.now() - startedAt,
                remainingMs,
                timeoutMs,
              }),
              new Promise<{ extendMs: number }>((r) =>
                setTimeout(() => r({ extendMs: 0 }), remainingMs),
              ),
            ])
            extendMs = Math.min(
              MAX_RENEWAL_EXTEND_MS,
              Math.max(0, Math.floor(answer?.extendMs ?? 0)),
            )
          } catch {
            extendMs = 0
          }

          if (settled) return

          if (extendMs > 0) {
            deadlineAt = Date.now() + extendMs
            scheduleKill()
            scheduleWarn()
          }
          // extendMs===0：保留原 deadline 上的 killTimer
        })()
      }, delay)
    }

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

    const onAbort = (): void => {
      abortedByUser = true
      killChild()
      settle(130, '\n[Command aborted by user]')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('close', (code) => {
      if (abortedByUser) {
        settle(code ?? 130)
      } else if (killedByTimeout) {
        settle(code ?? 124)
      } else {
        settle(code ?? 0)
      }
    })

    child.on('error', (err) => {
      settle(1, `\nFailed to spawn command: ${err.message}`)
    })

    scheduleKill()
    scheduleWarn()
  })
}
