/**
 * 本机 ACP 工具一键安装（仅允许白名单官方命令，禁止渲染进程传入任意脚本）
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectLocalAcpTool,
  isPrimaryLocalAcpToolId,
  type LocalAcpToolStatus,
  type PrimaryLocalAcpToolId,
} from './coding-dev-cli-detect.js'
import { createLogger } from './logger.js'

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
    hint: '安装 Cursor Agent CLI（agent），不是 Cursor 编辑器。完成后可能需重启灵栖以刷新 PATH。',
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
  copilot: {
    displayCommand: 'npm install -g @github/copilot',
    powershellCommand: 'npm install -g @github/copilot',
    timeoutMs: 8 * 60_000,
    hint: '需已安装 Node.js 22+。也可使用 winget install GitHub.Copilot。',
  },
}

/** 进行中的安装，防止重复点击 */
const inflight = new Map<PrimaryLocalAcpToolId, Promise<AcpInstallResult>>()

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

/**
 * 把常见 CLI 目录并入当前进程 PATH（安装脚本写入 User PATH 后，Electron 不会自动刷新）
 */
export function refreshCommonCliPathsInProcessEnv(): void {
  const extras: string[] = []
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA
  extras.push(path.join(home, '.local', 'bin'))
  if (local) extras.push(path.join(local, 'cursor-agent'))
  try {
    // npm 全局 bin（若存在）
    const npmPrefix = process.env.npm_config_prefix
    if (npmPrefix) extras.push(npmPrefix)
    const appDataRoaming = process.env.APPDATA
    if (appDataRoaming) {
      extras.push(path.join(appDataRoaming, 'npm'))
    }
  } catch {
    /* ignore */
  }

  const current = process.env.PATH ?? ''
  const parts = current.split(path.delimiter).filter(Boolean)
  const seen = new Set(parts.map((p) => p.toLowerCase()))
  for (const dir of extras) {
    if (!dir || !fs.existsSync(dir)) continue
    const key = dir.toLowerCase()
    if (seen.has(key)) continue
    parts.unshift(dir)
    seen.add(key)
  }
  process.env.PATH = parts.join(path.delimiter)
}

/**
 * 在 PowerShell 中执行白名单安装脚本
 */
function runPowershellInstall(
  recipe: InstallRecipe,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', recipe.powershellCommand],
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
        stderr: `${stderr}\n安装超时（>${Math.round(recipe.timeoutMs / 60000)} 分钟）`.trim(),
      })
    }, recipe.timeoutMs)

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
  if (process.platform !== 'win32') {
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
    const recipe = WIN_INSTALL_RECIPES[toolId]
    log.info('开始一键安装', { toolId, command: recipe.displayCommand })

    const { exitCode, stdout, stderr } = await runPowershellInstall(recipe)
    refreshCommonCliPathsInProcessEnv()
    const status = await detectLocalAcpTool(toolId)

    const ok = exitCode === 0 || status.installed
    const tail = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-800)
    let message: string
    if (status.installed) {
      message = `${status.label} 已可用${status.resolvedPath ? `：${status.resolvedPath}` : ''}。${recipe.hint}`
    } else if (exitCode === 0) {
      message = `安装命令已结束，但尚未检测到 CLI。请重启灵栖后再点「重新检测」。${recipe.hint}${tail ? `\n\n${tail}` : ''}`
    } else {
      message = `安装失败（退出码 ${exitCode ?? '超时'}）。可复制命令到 PowerShell 手动执行：${recipe.displayCommand}${tail ? `\n\n${tail}` : ''}`
    }

    log.info('一键安装结束', { toolId, exitCode, installed: status.installed })
    return { ok, toolId, exitCode, stdout, stderr, status, message }
  })()

  inflight.set(toolId, job)
  try {
    return await job
  } finally {
    inflight.delete(toolId)
  }
}
