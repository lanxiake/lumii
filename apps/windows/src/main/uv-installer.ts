/**
 * uv / uvx 自动安装
 *
 * flight-price-compare 等内置 MCP 通过 uvx 启动，首次连接前检测并执行官方安装脚本。
 */

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { resolveCommand } from '@mtbot/agent-runtime'
import { refreshCommonCliPathsInProcessEnv } from './cli-user-path'
import { createLogger } from './logger'

const log = createLogger('UvInstaller')

/** 官方 Windows 安装脚本（https://docs.astral.sh/uv/getting-started/installation/） */
const UV_INSTALL_PS1 = 'irm https://astral.sh/uv/install.ps1 | iex'

const INSTALL_TIMEOUT_MS = 5 * 60_000

/** ensureUvxInstalled 的返回结果 */
export type UvEnsureResult = {
  readonly ok: boolean
  /** 本次调用是否刚完成安装（false 表示本来就有） */
  readonly installed: boolean
  readonly message: string
}

let inflight: Promise<UvEnsureResult> | null = null

/** 仅供单测重置模块内状态 */
export function __resetUvInstallerStateForTests(): void {
  inflight = null
  spawnCommand = spawn
}

/** 可注入的 spawn（单测用） */
let spawnCommand: typeof spawn = spawn

/**
 * 仅供单测注入 spawn 实现
 */
export function __setUvSpawnForTests(fn: typeof spawn | null): void {
  spawnCommand = fn ?? spawn
}

/**
 * 判断命令是否已解析为可执行文件路径
 */
function isResolvedExecutable(command: string): boolean {
  return path.isAbsolute(command) || command.includes('/') || command.includes('\\')
}

/**
 * 检测本机是否已有 uvx（刷新 PATH 后再查）
 */
export function isUvxAvailable(): boolean {
  refreshCommonCliPathsInProcessEnv()
  const { command } = resolveCommand('uvx')
  return isResolvedExecutable(command)
}

/**
 * 在 PowerShell 中执行安装脚本
 */
function runPowershell(
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCommand(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
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
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      if (settled) return
      settled = true
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n安装超时（${timeoutMs}ms）`.trim() })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (stdout.length > 8000) stdout = stdout.slice(-8000)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('close', (exitCode) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ exitCode, stdout, stderr })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ exitCode: null, stdout, stderr: err.message })
    })
  })
}

/**
 * 确保 uvx 可用：已安装则直接成功，否则执行官方安装脚本
 */
export async function ensureUvxInstalled(): Promise<UvEnsureResult> {
  refreshCommonCliPathsInProcessEnv()
  if (isUvxAvailable()) {
    return { ok: true, installed: false, message: 'uvx 已可用' }
  }

  if (inflight) return inflight

  inflight = (async (): Promise<UvEnsureResult> => {
    if (process.platform !== 'win32') {
      return {
        ok: false,
        installed: false,
        message: '当前仅 Windows 客户端支持自动安装 uv，请手动安装：https://docs.astral.sh/uv/',
      }
    }

    log.info('未检测到 uvx，开始执行官方安装脚本...')
    const { exitCode, stdout, stderr } = await runPowershell(UV_INSTALL_PS1, INSTALL_TIMEOUT_MS)
    refreshCommonCliPathsInProcessEnv()

    if (isUvxAvailable()) {
      log.info('uv 安装成功')
      return { ok: true, installed: true, message: 'uv 已自动安装' }
    }

    const detail = (stderr || stdout).trim().slice(0, 300)
    return {
      ok: false,
      installed: false,
      message: detail
        ? `uv 自动安装失败（exit=${exitCode}）：${detail}`
        : `uv 自动安装后仍找不到 uvx（exit=${exitCode}），请重启灵栖或手动安装：https://docs.astral.sh/uv/`,
    }
  })().finally(() => {
    inflight = null
  })

  return inflight
}
