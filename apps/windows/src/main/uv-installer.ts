/**
 * uv / uvx 自动安装
 *
 * flight-price-compare 等内置 MCP 通过 uvx 启动，首次连接前检测并执行官方安装脚本。
 * Windows 用官方 PowerShell 脚本；Linux 用官方 shell 脚本（装到 ~/.local/bin，无需 root），
 * 脚本失败且应用 venv 已就绪时用 venv 的 pip 兜底（PyPI 通道，绕开 GitHub Releases）。
 */

import path from 'node:path'
import { resolveCommand } from '@mtbot/agent-runtime'
import { refreshCommonCliPathsInProcessEnv } from './cli-user-path'
import { createLogger } from './logger'
import { runShellCommand } from './platform/shell-command'
import { getPythonVenvExe, isPythonVenvReady } from './python-venv'

const log = createLogger('UvInstaller')

/** 官方 Windows 安装脚本（https://docs.astral.sh/uv/getting-started/installation/） */
const UV_INSTALL_PS1 = 'irm https://astral.sh/uv/install.ps1 | iex'

/** 官方 Linux/macOS 安装脚本 */
const UV_INSTALL_SH = 'curl -LsSf https://astral.sh/uv/install.sh | sh'

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
 * 确保 uvx 可用：已安装则直接成功，否则执行官方安装脚本
 */
export async function ensureUvxInstalled(): Promise<UvEnsureResult> {
  refreshCommonCliPathsInProcessEnv()
  if (isUvxAvailable()) {
    return { ok: true, installed: false, message: 'uvx 已可用' }
  }

  if (inflight) return inflight

  inflight = (async (): Promise<UvEnsureResult> => {
    const isWin = process.platform === 'win32'
    log.info(`未检测到 uvx，开始执行官方安装脚本（${isWin ? 'Windows' : 'Linux'}）...`)
    const { exitCode, stdout, stderr } = await runShellCommand(
      isWin ? UV_INSTALL_PS1 : UV_INSTALL_SH,
      INSTALL_TIMEOUT_MS,
    )
    refreshCommonCliPathsInProcessEnv()

    if (isUvxAvailable()) {
      log.info('uv 安装成功')
      return { ok: true, installed: true, message: 'uv 已自动安装' }
    }

    // 官方脚本失败的常见原因：脚本本体可达，但二进制在 GitHub Releases（国内网络不通）。
    // 兜底走应用 venv 的 pip（PyPI 通道）；只在 venv 已就绪时用，不在安装路径上现建 venv。
    if (!isWin && isPythonVenvReady()) {
      log.info('官方脚本未成功，改用应用 venv 的 pip 安装 uv...')
      const pip = await runShellCommand(
        `"${getPythonVenvExe()}" -m pip install uv --no-warn-script-location`,
        3 * 60_000,
      )
      refreshCommonCliPathsInProcessEnv()
      if (isUvxAvailable()) {
        log.info('uv 安装成功（venv pip 兜底）')
        return { ok: true, installed: true, message: 'uv 已自动安装（应用 venv 的 pip）' }
      }
      const pipDetail = (pip.stderr || pip.stdout).trim().slice(0, 300)
      const scriptDetail = (stderr || stdout).trim().slice(0, 200)
      const detail = pipDetail || scriptDetail
      return {
        ok: false,
        installed: false,
        message: detail
          ? `uv 自动安装失败（官方脚本 exit=${exitCode}；pip exit=${pip.exitCode}）：${detail}`
          : `uv 自动安装后仍找不到 uvx（官方脚本 exit=${exitCode}），请重启灵栖或手动安装：https://docs.astral.sh/uv/`,
      }
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
