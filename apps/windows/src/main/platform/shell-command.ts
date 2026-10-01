/**
 * 平台 shell 命令执行原语（内联命令）。
 *
 * `ShellRunner` 只接受**脚本文件路径**（`RunnerOptions.entryPath`），跑不了
 * `curl … | bash` 这类内联管道命令；各安装流程需要「一行白名单命令」的执行口。
 * 本模块补这一层：Windows 走 `powershell.exe`（与既有 `runPowershell` 逐字同参），
 * POSIX 走 `bash -c`；统一进程组 spawn + 进程树 kill + 超时（复用
 * `platform/process-kill` 的收敛实现，POSIX 上 detached 进程组才杀得干净）。
 *
 * 命令来自代码内白名单常量，**不接收渲染进程传入的任意脚本**。
 */

import os from 'node:os'
import { killProcessTree, spawnChildInGroup } from './process-kill'

export interface ShellCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/** 输出保留上限（超出后掐头留尾，够排查即可） */
const OUTPUT_TAIL_CHARS = 200_000
const OUTPUT_KEEP_CHARS = 150_000

/**
 * 执行一条内联 shell 命令（安装 / 卸载脚本用）。
 *
 * @param command Windows 下是 PowerShell 脚本，POSIX 下是 `bash -c` 的脚本
 * @param timeoutMs 超时后杀**进程树**并返回 exitCode=null（stderr 带「执行超时」）
 */
export function runShellCommand(command: string, timeoutMs: number): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawnChildInGroup(
      isWin ? 'powershell.exe' : 'bash',
      isWin ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] : ['-c', command],
      {
        windowsHide: true,
        env: { ...process.env },
        cwd: os.homedir(),
      },
    )

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      killProcessTree(child)
      if (settled) return
      settled = true
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n执行超时（>${Math.round(timeoutMs / 60000)} 分钟）`.trim(),
      })
    }, timeoutMs)

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8')
      if (stdout.length > OUTPUT_TAIL_CHARS) stdout = stdout.slice(-OUTPUT_KEEP_CHARS)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
      if (stderr.length > OUTPUT_TAIL_CHARS) stderr = stderr.slice(-OUTPUT_KEEP_CHARS)
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ exitCode: 1, stdout, stderr: err.message })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ exitCode: code, stdout, stderr })
    })
  })
}
