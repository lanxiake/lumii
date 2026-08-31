/**
 * 本机 ACP 工具一键安装（仅允许白名单官方命令，禁止渲染进程传入任意脚本）
 */

import { spawn } from 'node:child_process'
import os from 'node:os'
import {
  detectLocalAcpTool,
  isPrimaryLocalAcpToolId,
  type LocalAcpToolStatus,
  type PrimaryLocalAcpToolId,
} from './coding-dev-cli-detect.js'
import { createLogger } from './logger.js'
import { refreshCommonCliPathsInProcessEnv } from './cli-user-path'

const log = createLogger('CodingDevCliInstall')

/** 安装结果 */
export type AcpInstallResult = {
  ok: boolean
  toolId: PrimaryLocalAcpToolId
  exitCode: number | null
  stdout: string
  stderr: string
  /** 安装后重新探测的状态 */
  status: LocalAcpToolStatus
  /** 给用户看的摘要 */
  message: string
}

/** 卸载结果 */
export type AcpUninstallResult = {
  ok: boolean
  toolId: PrimaryLocalAcpToolId
  exitCode: number | null
  stdout: string
  stderr: string
  /** 卸载后重新探测的状态 */
  status: LocalAcpToolStatus
  /** 给用户看的摘要 */
  message: string
  /** 实际执行（或建议手动执行）的命令 */
  command?: string
  /** 该卸载方式是否有官方文档依据 */
  documented?: boolean
}

/** 卸载预览（供 UI 确认弹窗展示，不执行任何命令） */
export type AcpUninstallPreview = {
  toolId: PrimaryLocalAcpToolId
  label: string
  installed: boolean
  /** 展示给用户的命令；空串表示需手动移除 */
  displayCommand: string
  /** 是否能自动执行 */
  automatic: boolean
  documented: boolean
  hint: string
}

/** 官方安装配方（Windows PowerShell） */
type InstallRecipe = {
  /** UI 展示的命令 */
  displayCommand: string
  /** 传给 powershell -Command 的脚本 */
  powershellCommand: string
  timeoutMs: number
  hint: string
}

/**
 * 各工具官方一键安装命令（来源：各产品文档，2026）
 * - Cursor: https://cursor.com/docs/cli/installation
 * - Claude: https://code.claude.com/docs/en/installation
 * - Codex: https://www.npmjs.com/package/@openai/codex
 * - Copilot: https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli
 */
const WIN_INSTALL_RECIPES: Record<PrimaryLocalAcpToolId, InstallRecipe> = {
  cursor: {
    displayCommand: "irm 'https://cursor.com/install?win32=true' | iex",
    powershellCommand: "irm 'https://cursor.com/install?win32=true' | iex",
    timeoutMs: 10 * 60_000,
    hint: '安装 Cursor Agent CLI（agent），不是 Cursor 编辑器。装到 ~/.local/bin，完成后可能需重启灵栖以刷新 PATH。',
  },
  claude: {
    displayCommand: 'irm https://claude.ai/install.ps1 | iex',
    powershellCommand: 'irm https://claude.ai/install.ps1 | iex',
    timeoutMs: 10 * 60_000,
    hint: '官方原生安装脚本，安装到用户目录并支持自动更新。',
  },
  codex: {
    displayCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    powershellCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    timeoutMs: 10 * 60_000,
    hint: '官方 Codex 独立安装脚本；若失败可改用 npm install -g @openai/codex。',
  },
  opencode: {
    displayCommand: 'npm install -g opencode-ai',
    powershellCommand: 'npm install -g opencode-ai',
    timeoutMs: 8 * 60_000,
    hint: '官方 npm 包（内含各平台预编译二进制）。同一命令可用于升级。',
  },
}

/** 卸载配方 */
type UninstallRecipe = {
  /** UI 展示 / 确认弹窗里给用户看的命令 */
  displayCommand: string
  /** 传给 powershell -Command 的脚本；空串表示无法自动卸载 */
  powershellCommand: string
  /** 该卸载方式是否有官方文档依据（false = 从安装脚本推断，UI 需提示） */
  documented: boolean
  hint: string
}

/** npm 全局包卸载配方 */
function npmUninstall(pkg: string, extraHint = ''): UninstallRecipe {
  return {
    displayCommand: `npm uninstall -g ${pkg}`,
    powershellCommand: `npm uninstall -g ${pkg}`,
    documented: true,
    hint: `移除 npm 全局包 ${pkg}。${extraHint}`.trim(),
  }
}

/** 解析出的路径是否来自 npm 全局安装 */
function isNpmGlobalPath(resolvedPath: string | undefined): boolean {
  if (!resolvedPath) return false
  const lower = resolvedPath.toLowerCase()
  return lower.includes('node_modules') || /[\\/]npm[\\/]/.test(lower)
}

/**
 * 依据实际安装位置解析卸载配方
 *
 * 部分工具同时有官方脚本安装与 npm 安装两条路径，卸载方式不同，
 * 因此按探测到的 resolvedPath 判断，而不是写死一个常量。
 */
function resolveUninstallRecipe(status: LocalAcpToolStatus): UninstallRecipe {
  const npmPath = isNpmGlobalPath(status.resolvedPath)
  switch (status.id) {
    case 'claude':
      if (npmPath) return npmUninstall('@anthropic-ai/claude-code')
      // 官方文档给出的原生安装卸载路径（不动 ~/.claude 用户配置）
      return {
        displayCommand:
          'Remove-Item "$env:USERPROFILE\\.local\\bin\\claude.exe"; Remove-Item "$env:USERPROFILE\\.local\\share\\claude" -Recurse',
        powershellCommand:
          'Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\claude.exe" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\share\\claude" -Recurse -Force -ErrorAction SilentlyContinue',
        documented: true,
        hint: '按官方文档移除原生安装文件；~/.claude 用户配置与登录状态保留，需要彻底清理请手动删除。',
      }
    case 'codex':
      if (npmPath) return npmUninstall('@openai/codex')
      return {
        displayCommand: 'Remove-Item "$env:LOCALAPPDATA\\Programs\\OpenAI\\Codex" -Recurse',
        powershellCommand:
          'Remove-Item -LiteralPath "$env:LOCALAPPDATA\\Programs\\OpenAI\\Codex" -Recurse -Force -ErrorAction SilentlyContinue',
        documented: false,
        hint: 'Codex 官方未提供卸载命令，此路径取自官方安装脚本的默认安装目录；~/.codex 配置保留。PATH 中的残留条目需手动清理。',
      }
    case 'cursor':
      if (status.resolvedPath && /qoder/i.test(status.resolvedPath)) {
        return {
          displayCommand: `(手动) 删除 ${status.resolvedPath} 并清理 PATH`,
          powershellCommand: '',
          documented: false,
          hint: '检测到非 Cursor 官方安装路径，无法安全自动卸载，请按原安装方式手动移除。',
        }
      }
      // 官方装到 ~/.local/bin（旧版在 %LOCALAPPDATA%\cursor-agent），两处都清
      return {
        displayCommand:
          'Remove-Item "$env:USERPROFILE\\.local\\bin\\agent.exe"; Remove-Item "$env:LOCALAPPDATA\\cursor-agent" -Recurse',
        powershellCommand:
          'Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\agent.exe" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\cursor-agent.exe" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath "$env:LOCALAPPDATA\\cursor-agent" -Recurse -Force -ErrorAction SilentlyContinue',
        documented: false,
        hint: 'Cursor 官方未提供卸载命令，此路径取自官方安装脚本的安装目录（~/.local/bin）。PATH 中的残留条目需手动清理。',
      }
    case 'opencode':
      if (npmPath) return npmUninstall('opencode-ai')
      return {
        displayCommand: `（手动）删除 ${status.resolvedPath ?? 'OpenCode 可执行文件'} 并清理 PATH`,
        powershellCommand: '',
        documented: false,
        hint: '本机 OpenCode 不是 npm 全局安装（可能是 choco / scoop / 安装脚本 / 独立安装包），无法自动卸载，需按当初的安装方式手动移除。',
      }
  }
}

/** 进行中的安装，防止重复点击 */
const inflight = new Map<PrimaryLocalAcpToolId, Promise<AcpInstallResult>>()

/** 进行中的卸载，防止重复点击 */
const uninstallInflight = new Map<PrimaryLocalAcpToolId, Promise<AcpUninstallResult>>()

/**
 * 获取某工具的安装命令文案（供 UI 展示）
 */
export function getAcpInstallDisplay(toolId: PrimaryLocalAcpToolId): {
  displayCommand: string
  hint: string
} {
  const r = WIN_INSTALL_RECIPES[toolId]
  return { displayCommand: r.displayCommand, hint: r.hint }
}

export { refreshCommonCliPathsInProcessEnv } from './cli-user-path'

/**
 * 在 PowerShell 中执行白名单脚本（安装 / 卸载共用）
 */
function runPowershell(
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
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
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n执行超时（>${Math.round(timeoutMs / 60000)} 分钟）`.trim(),
      })
    }, timeoutMs)

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf8')
      if (stdout.length > 200_000) stdout = stdout.slice(-150_000)
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf8')
      if (stderr.length > 200_000) stderr = stderr.slice(-150_000)
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

/**
 * 一键安装指定 ACP 工具（仅 Windows；命令白名单）
 */
export async function installLocalAcpTool(toolIdRaw: string): Promise<AcpInstallResult> {
  const toolId = String(toolIdRaw ?? '').trim().toLowerCase()
  if (!isPrimaryLocalAcpToolId(toolId)) {
    throw new Error(`不支持安装未知工具：${toolIdRaw}`)
  }
  // opencode 无统一安装命令，不走 PowerShell 执行，直接引导官网文档
  if (process.platform !== 'win32' || !WIN_INSTALL_RECIPES[toolId].powershellCommand) {
    const status = await detectLocalAcpTool(toolId)
    return {
      ok: false,
      toolId,
      exitCode: 1,
      stdout: '',
      stderr: '',
      status,
      message: `当前暂不支持一键安装，请打开文档手动安装：${status.installUrl}`,
    }
  }

  const existing = inflight.get(toolId)
  if (existing) return existing

  const job = (async (): Promise<AcpInstallResult> => {
    const recipe = WIN_INSTALL_RECIPES[toolId]
    const before = await detectLocalAcpTool(toolId)
    // 已装且 CLI 自带升级命令（如 Cursor 的 agent update）：走自更新，
    // 重跑安装脚本对这类工具是错的（官方明确用 update 子命令）。
    const selfUpdate = before.installed && before.selfUpdateCommand
      ? { command: before.selfUpdateCommand, path: before.resolvedPath }
      : null
    const command = selfUpdate
      ? `& '${selfUpdate.path}' update`
      : recipe.powershellCommand
    const displayCommand = selfUpdate ? selfUpdate.command : recipe.displayCommand
    log.info(selfUpdate ? '开始自更新' : '开始一键安装', { toolId, command: displayCommand })

    const { exitCode, stdout, stderr } = await runPowershell(command, recipe.timeoutMs)
    refreshCommonCliPathsInProcessEnv()
    const status = await detectLocalAcpTool(toolId)

    const ok = exitCode === 0 || status.installed
    const tail = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-800)
    let message: string
    if (selfUpdate) {
      const versionInfo = status.currentVersion
        ? before.currentVersion && before.currentVersion !== status.currentVersion
          ? `已从 ${before.currentVersion} 更新到 ${status.currentVersion}。`
          : `当前版本 ${status.currentVersion}（已是最新或无需更新）。`
        : ''
      message = exitCode === 0
        ? `${status.label} 检查更新完成。${versionInfo}${tail ? `\n\n${tail}` : ''}`
        : `检查更新失败（退出码 ${exitCode ?? '超时'}）。可手动执行：${displayCommand}${tail ? `\n\n${tail}` : ''}`
    } else if (status.installed) {
      message = `${status.label} 已可用${status.resolvedPath ? `：${status.resolvedPath}` : ''}。${recipe.hint}`
    } else if (exitCode === 0) {
      message = `安装命令已结束，但尚未检测到 CLI。请重启灵栖后再点「重新检测」。${recipe.hint}${tail ? `\n\n${tail}` : ''}`
    } else {
      message = `安装失败（退出码 ${exitCode ?? '超时'}）。可复制命令到 PowerShell 手动执行：${displayCommand}${tail ? `\n\n${tail}` : ''}`
    }

    log.info(selfUpdate ? '自更新结束' : '一键安装结束', { toolId, exitCode, installed: status.installed })
    return { ok, toolId, exitCode, stdout, stderr, status, message }
  })()

  inflight.set(toolId, job)
  try {
    return await job
  } finally {
    inflight.delete(toolId)
  }
}

/**
 * 一键卸载指定 ACP 工具（仅 Windows；白名单卸载命令）
 *
 * 仅对有官方文档卸载方法的工具执行自动卸载；无文档的工具（Cursor/Codex）返回手动移除步骤。
 */
export async function uninstallLocalAcpTool(toolIdRaw: string): Promise<AcpUninstallResult> {
  const toolId = String(toolIdRaw ?? '').trim().toLowerCase()
  if (!isPrimaryLocalAcpToolId(toolId)) {
    throw new Error(`不支持卸载未知工具：${toolIdRaw}`)
  }

  const status = await detectLocalAcpTool(toolId)

  // 未安装，无需卸载
  if (!status.installed) {
    return {
      ok: true,
      toolId,
      exitCode: 0,
      stdout: '',
      stderr: '',
      status,
      message: `${status.label} 未检测到安装，无需卸载。`,
    }
  }

  const recipe = resolveUninstallRecipe(status)

  // 无法自动卸载：返回手动步骤
  if (!recipe.powershellCommand || process.platform !== 'win32') {
    return {
      ok: false,
      toolId,
      exitCode: 1,
      stdout: '',
      stderr: '',
      status,
      message: `暂不支持一键卸载：${recipe.hint}`,
      command: recipe.displayCommand,
      documented: recipe.documented,
    }
  }

  const existing = uninstallInflight.get(toolId)
  if (existing) return existing

  const job = (async (): Promise<AcpUninstallResult> => {
    log.info('开始卸载', { toolId, command: recipe.displayCommand })
    const { exitCode, stdout, stderr } = await runPowershell(recipe.powershellCommand, 5 * 60_000)
    refreshCommonCliPathsInProcessEnv()
    const after = await detectLocalAcpTool(toolId)

    const ok = !after.installed
    const tail = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-800)
    const message = ok
      ? `${after.label} 已卸载。${recipe.hint}`
      : `卸载命令已执行（退出码 ${exitCode ?? '超时'}），但仍检测到 CLI${after.resolvedPath ? `：${after.resolvedPath}` : ''}。可能有其他安装方式的残留，需手动移除。${tail ? `\n\n${tail}` : ''}`

    log.info('卸载结束', { toolId, exitCode, stillInstalled: after.installed })
    return {
      ok,
      toolId,
      exitCode,
      stdout,
      stderr,
      status: after,
      message,
      command: recipe.displayCommand,
      documented: recipe.documented,
    }
  })()

  uninstallInflight.set(toolId, job)
  try {
    return await job
  } finally {
    uninstallInflight.delete(toolId)
  }
}

/**
 * 卸载预览：告诉 UI 将要执行什么命令、是否有官方文档依据（用于确认弹窗）
 */
export async function previewUninstallLocalAcpTool(toolIdRaw: string): Promise<AcpUninstallPreview> {
  const toolId = String(toolIdRaw ?? '').trim().toLowerCase()
  if (!isPrimaryLocalAcpToolId(toolId)) {
    throw new Error(`不支持卸载未知工具：${toolIdRaw}`)
  }
  const status = await detectLocalAcpTool(toolId)
  const recipe = resolveUninstallRecipe(status)
  return {
    toolId,
    label: status.label,
    installed: status.installed,
    displayCommand: recipe.displayCommand,
    automatic: Boolean(recipe.powershellCommand) && process.platform === 'win32',
    documented: recipe.documented,
    hint: recipe.hint,
  }
}
