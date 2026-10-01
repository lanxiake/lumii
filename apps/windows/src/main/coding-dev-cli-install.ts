/**
 * 本机 ACP 工具一键安装（仅允许白名单官方命令，禁止渲染进程传入任意脚本）
 *
 * 双平台配方：Windows 走 PowerShell，Linux 走 bash（统一经 platform/shell-command）。
 * Linux 命令与 `coding-dev-cli-detect.ts` 的 `linuxInstallCommand` **同源**，
 * 面板展示 / 「让 AI 安装」提示词 / 实际执行三处不会漂移。
 */

import fs from 'node:fs'
import {
  LOCAL_ACP_TOOL_META,
  detectLocalAcpTool,
  isPrimaryLocalAcpToolId,
  type LocalAcpToolStatus,
  type PrimaryLocalAcpToolId,
} from './coding-dev-cli-detect.js'
import { createLogger } from './logger.js'
import { runShellCommand } from './platform/shell-command.js'
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

/** 单平台安装配方 */
type PlatformInstallRecipe = {
  /** UI 展示的命令 */
  displayCommand: string
  /** 实际执行的内联命令（win=PowerShell，posix=bash，统一走 runShellCommand） */
  command: string
  timeoutMs: number
  hint: string
}

/** 每工具按平台给配方；缺该平台条目 = 该平台暂不支持一键安装（走手动指引） */
type InstallRecipe = {
  win32?: PlatformInstallRecipe
  posix?: PlatformInstallRecipe
}

/**
 * Linux 配方的命令与文案取自 detect 的 META（**唯一事实源**，防两处漂移）。
 * 命令清单与探测结论（2026-10-01）：见 `coding-dev-cli-detect.ts` 的
 * `linuxInstallCommand` 注释与二期实施计划 W3-0。
 */
function posixRecipe(id: PrimaryLocalAcpToolId, timeoutMs: number): PlatformInstallRecipe {
  const meta = LOCAL_ACP_TOOL_META[id]
  return {
    displayCommand: meta.linuxInstallCommand,
    command: meta.linuxInstallCommand,
    timeoutMs,
    hint: meta.linuxInstallHint ?? meta.installHint,
  }
}

/**
 * 各工具官方一键安装命令（来源：各产品文档，2026）
 * - Cursor: https://cursor.com/docs/cli/installation
 * - Claude: https://code.claude.com/docs/en/installation
 * - Codex: https://www.npmjs.com/package/@openai/codex
 * - OpenCode: https://opencode.ai/docs
 */
const INSTALL_RECIPES: Record<PrimaryLocalAcpToolId, InstallRecipe> = {
  cursor: {
    win32: {
      displayCommand: "irm 'https://cursor.com/install?win32=true' | iex",
      command: "irm 'https://cursor.com/install?win32=true' | iex",
      timeoutMs: 10 * 60_000,
      hint: '安装 Cursor Agent CLI（agent），不是 Cursor 编辑器。装到 ~/.local/bin，完成后可能需重启灵栖以刷新 PATH。',
    },
    posix: posixRecipe('cursor', 10 * 60_000),
  },
  claude: {
    win32: {
      displayCommand: 'irm https://claude.ai/install.ps1 | iex',
      command: 'irm https://claude.ai/install.ps1 | iex',
      timeoutMs: 10 * 60_000,
      hint: '官方原生安装脚本，安装到用户目录并支持自动更新。',
    },
    posix: posixRecipe('claude', 8 * 60_000),
  },
  codex: {
    win32: {
      displayCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
      command: 'irm https://chatgpt.com/codex/install.ps1 | iex',
      timeoutMs: 10 * 60_000,
      hint: '官方 Codex 独立安装脚本；若失败可改用 npm install -g @openai/codex。',
    },
    posix: posixRecipe('codex', 8 * 60_000),
  },
  opencode: {
    win32: {
      displayCommand: 'npm install -g opencode-ai',
      command: 'npm install -g opencode-ai',
      timeoutMs: 8 * 60_000,
      hint: '官方 npm 包（内含各平台预编译二进制）。同一命令可用于升级。',
    },
    posix: posixRecipe('opencode', 8 * 60_000),
  },
}

/** 取当前平台的安装配方；null = 该平台不支持一键安装 */
function pickInstallRecipe(id: PrimaryLocalAcpToolId): PlatformInstallRecipe | null {
  const recipe = INSTALL_RECIPES[id]
  return (process.platform === 'win32' ? recipe.win32 : recipe.posix) ?? null
}

/** 卸载配方（已按当前平台解析好命令） */
type UninstallRecipe = {
  /** UI 展示 / 确认弹窗里给用户看的命令 */
  displayCommand: string
  /** 实际执行的内联命令（当前平台 shell）；空串表示无法自动卸载 */
  command: string
  /** 该卸载方式是否有官方文档依据（false = 从安装脚本推断，UI 需提示） */
  documented: boolean
  hint: string
}

/** npm 全局包卸载配方（两平台同一命令） */
function npmUninstall(pkg: string, extraHint = ''): UninstallRecipe {
  return {
    displayCommand: `npm uninstall -g ${pkg}`,
    command: `npm uninstall -g ${pkg}`,
    documented: true,
    hint: `移除 npm 全局包 ${pkg}。${extraHint}`.trim(),
  }
}

/** 无法自动卸载时的占位配方（展示手动步骤） */
function manualUninstall(displayCommand: string, hint: string): UninstallRecipe {
  return { displayCommand, command: '', documented: false, hint }
}

/**
 * 解析出的路径是否来自 npm 全局安装。
 *
 * npm 全局命令在 bin 目录里是**符号链接**（目标是 `…/lib/node_modules/…`），
 * 探测返回的是符号链接本身（`<prefix>/bin/claude`），路径里看不到 node_modules；
 * 因此同时看 realpath 目标，否则 npm 安装会被误判成原生安装、给出错误的卸载命令。
 */
function isNpmGlobalPath(resolvedPath: string | undefined): boolean {
  if (!resolvedPath) return false
  const candidates = [resolvedPath]
  try {
    candidates.push(fs.realpathSync(resolvedPath))
  } catch {
    /* 路径可能已失效；仅按原路径判断 */
  }
  return candidates.some((p) => {
    const lower = p.toLowerCase()
    return lower.includes('node_modules') || /[\\/]npm[\\/]/.test(lower)
  })
}

/** 路径是否在官方脚本的安装范围（~/.local 下），自动卸载只删这里 */
function isUserLocalPath(resolvedPath: string | undefined): boolean {
  return Boolean(resolvedPath && /\/\.local\//.test(resolvedPath.replace(/\\/g, '/')))
}

/**
 * 依据实际安装位置与当前平台解析卸载配方
 *
 * 部分工具同时有官方脚本安装与 npm 安装两条路径，卸载方式不同，
 * 因此按探测到的 resolvedPath 判断，而不是写死一个常量；脚本安装的
 * 路径形态两平台不同（Windows 在 %USERPROFILE%\.local，POSIX 在 $HOME/.local），
 * 命令也随平台分派。
 */
function resolveUninstallRecipe(status: LocalAcpToolStatus): UninstallRecipe {
  const win = process.platform === 'win32'
  const npmPath = isNpmGlobalPath(status.resolvedPath)
  switch (status.id) {
    case 'claude':
      if (npmPath) return npmUninstall('@anthropic-ai/claude-code')
      if (!win) {
        if (!isUserLocalPath(status.resolvedPath)) {
          return manualUninstall(
            `（手动）删除 ${status.resolvedPath ?? 'claude 可执行文件'} 并清理 PATH`,
            '检测到非官方脚本安装路径，无法安全自动卸载，请按原安装方式手动移除。',
          )
        }
        return {
          displayCommand: 'rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude',
          command: 'rm -f "$HOME/.local/bin/claude" && rm -rf "$HOME/.local/share/claude"',
          documented: true,
          hint: '按官方文档移除原生安装文件；~/.claude 用户配置与登录状态保留，需要彻底清理请手动删除。',
        }
      }
      // 官方文档给出的原生安装卸载路径（不动 ~/.claude 用户配置）
      return {
        displayCommand:
          'Remove-Item "$env:USERPROFILE\\.local\\bin\\claude.exe"; Remove-Item "$env:USERPROFILE\\.local\\share\\claude" -Recurse',
        command:
          'Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\claude.exe" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\share\\claude" -Recurse -Force -ErrorAction SilentlyContinue',
        documented: true,
        hint: '按官方文档移除原生安装文件；~/.claude 用户配置与登录状态保留，需要彻底清理请手动删除。',
      }
    case 'codex':
      if (npmPath) return npmUninstall('@openai/codex')
      if (!win) {
        if (!isUserLocalPath(status.resolvedPath)) {
          return manualUninstall(
            `（手动）删除 ${status.resolvedPath ?? 'codex 可执行文件'} 并清理 PATH`,
            '检测到非官方脚本安装路径（如 brew），无法安全自动卸载，请按原安装方式手动移除。',
          )
        }
        return {
          displayCommand: 'rm -f ~/.local/bin/codex && rm -rf ~/.local/share/codex',
          command: 'rm -f "$HOME/.local/bin/codex" && rm -rf "$HOME/.local/share/codex"',
          documented: false,
          hint: 'Codex 官方未提供卸载命令，此路径取自官方安装脚本的默认安装目录推断；~/.codex 配置保留。PATH 中的残留条目需手动清理。',
        }
      }
      return {
        displayCommand: 'Remove-Item "$env:LOCALAPPDATA\\Programs\\OpenAI\\Codex" -Recurse',
        command:
          'Remove-Item -LiteralPath "$env:LOCALAPPDATA\\Programs\\OpenAI\\Codex" -Recurse -Force -ErrorAction SilentlyContinue',
        documented: false,
        hint: 'Codex 官方未提供卸载命令，此路径取自官方安装脚本的默认安装目录；~/.codex 配置保留。PATH 中的残留条目需手动清理。',
      }
    case 'cursor':
      if (status.resolvedPath && /qoder/i.test(status.resolvedPath)) {
        return manualUninstall(
          `(手动) 删除 ${status.resolvedPath} 并清理 PATH`,
          '检测到非 Cursor 官方安装路径，无法安全自动卸载，请按原安装方式手动移除。',
        )
      }
      if (!win) {
        if (!isUserLocalPath(status.resolvedPath)) {
          return manualUninstall(
            `（手动）删除 ${status.resolvedPath ?? 'agent 可执行文件'} 并清理 PATH`,
            '检测到非官方脚本安装路径，无法安全自动卸载，请按原安装方式手动移除。',
          )
        }
        // 官方脚本产物：~/.local/bin/{agent,cursor-agent} 符号链接 + ~/.local/share/cursor-agent
        return {
          displayCommand:
            'rm -f ~/.local/bin/agent ~/.local/bin/cursor-agent && rm -rf ~/.local/share/cursor-agent',
          command:
            'rm -f "$HOME/.local/bin/agent" "$HOME/.local/bin/cursor-agent" && rm -rf "$HOME/.local/share/cursor-agent"',
          documented: false,
          hint: 'Cursor 官方未提供卸载命令，此路径取自官方安装脚本（~/.local/bin 符号链接与 ~/.local/share/cursor-agent）。PATH 中的残留条目需手动清理。',
        }
      }
      // 官方装到 ~/.local/bin（旧版在 %LOCALAPPDATA%\cursor-agent），两处都清
      return {
        displayCommand:
          'Remove-Item "$env:USERPROFILE\\.local\\bin\\agent.exe"; Remove-Item "$env:LOCALAPPDATA\\cursor-agent" -Recurse',
        command:
          'Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\agent.exe" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath "$env:USERPROFILE\\.local\\bin\\cursor-agent.exe" -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath "$env:LOCALAPPDATA\\cursor-agent" -Recurse -Force -ErrorAction SilentlyContinue',
        documented: false,
        hint: 'Cursor 官方未提供卸载命令，此路径取自官方安装脚本的安装目录（~/.local/bin）。PATH 中的残留条目需手动清理。',
      }
    case 'opencode':
      if (npmPath) return npmUninstall('opencode-ai')
      return manualUninstall(
        `（手动）删除 ${status.resolvedPath ?? 'OpenCode 可执行文件'} 并清理 PATH`,
        '本机 OpenCode 不是 npm 全局安装（可能是安装脚本 / 独立安装包），无法自动卸载，需按当初的安装方式手动移除。',
      )
  }
}

/** 进行中的安装，防止重复点击 */
const inflight = new Map<PrimaryLocalAcpToolId, Promise<AcpInstallResult>>()

/** 进行中的卸载，防止重复点击 */
const uninstallInflight = new Map<PrimaryLocalAcpToolId, Promise<AcpUninstallResult>>()

/**
 * 一键安装指定 ACP 工具（白名单命令；Windows 与 Linux 各有配方）
 */
export async function installLocalAcpTool(toolIdRaw: string): Promise<AcpInstallResult> {
  const toolId = String(toolIdRaw ?? '').trim().toLowerCase()
  if (!isPrimaryLocalAcpToolId(toolId)) {
    throw new Error(`不支持安装未知工具：${toolIdRaw}`)
  }
  const recipe = pickInstallRecipe(toolId)
  if (!recipe) {
    const status = await detectLocalAcpTool(toolId)
    return {
      ok: false,
      toolId,
      exitCode: 1,
      stdout: '',
      stderr: '',
      status,
      message: `当前平台暂不支持一键安装，请打开文档手动安装：${status.installUrl}`,
    }
  }

  const existing = inflight.get(toolId)
  if (existing) return existing

  const job = (async (): Promise<AcpInstallResult> => {
    const before = await detectLocalAcpTool(toolId)
    // 已装且 CLI 自带升级命令（如 Cursor 的 agent update）：走自更新，
    // 重跑安装脚本对这类工具是错的（官方明确用 update 子命令）。
    const selfUpdate = before.installed && before.selfUpdateCommand
      ? { command: before.selfUpdateCommand, path: before.resolvedPath }
      : null
    const command = selfUpdate
      ? process.platform === 'win32'
        ? `& '${selfUpdate.path}' update`
        : `'${selfUpdate.path}' update`
      : recipe.command
    const displayCommand = selfUpdate ? selfUpdate.command : recipe.displayCommand
    log.info(selfUpdate ? '开始自更新' : '开始一键安装', { toolId, command: displayCommand })

    const { exitCode, stdout, stderr } = await runShellCommand(command, recipe.timeoutMs)
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
      const shellName = process.platform === 'win32' ? 'PowerShell' : '终端'
      message = `安装失败（退出码 ${exitCode ?? '超时'}）。可复制命令到${shellName}手动执行：${displayCommand}${tail ? `\n\n${tail}` : ''}`
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
 * 一键卸载指定 ACP 工具（白名单卸载命令，按平台分派）
 *
 * 仅对有可用卸载命令的工具执行自动卸载；其余（Cursor/Codex 的非标准路径等）
 * 返回手动移除步骤。
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
  if (!recipe.command) {
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
    const { exitCode, stdout, stderr } = await runShellCommand(recipe.command, 5 * 60_000)
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
    automatic: Boolean(recipe.command),
    documented: recipe.documented,
    hint: recipe.hint,
  }
}
