/**
 * 本机开发类 AI 工具（ACP）元数据与 CLI 探测
 *
 * 常用子集：cursor / claude / codex / opencode
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  detectToolVersion,
  fetchNpmLatestVersion,
  fetchPypiLatestVersion,
} from './coding-dev-cli-version.js'

const execFileAsync = promisify(execFile)

/** 面板主推的本机工具（与斜杠命令可切换的后端一一对应） */
export const PRIMARY_LOCAL_ACP_TOOLS = [
  'cursor',
  'claude',
  'codex',
  'opencode',
] as const

export type PrimaryLocalAcpToolId = (typeof PRIMARY_LOCAL_ACP_TOOLS)[number]

export interface LocalAcpToolMeta {
  id: PrimaryLocalAcpToolId
  label: string
  description: string
  /** where 探测候选命令（按优先级） */
  commands: string[]
  homepageUrl: string
  installUrl: string
  /** 官方一键安装命令（Windows PowerShell，供 UI 展示） */
  installCommand: string
  /** 安装说明 */
  installHint: string
  /** npm 包名，用于查询最新版本（registry.npmjs.org）；不设置则跳过最新版本查询（如 cursor-agent 无公开查询接口） */
  npmPackageName?: string
  /** PyPI 包名，用于查询最新版本；与 npmPackageName 互斥（Python 系工具） */
  pypiPackageName?: string
  /**
   * CLI 自带的升级命令（如 Cursor 的 `agent update`）。
   * 这类工具查不到 registry 最新版号，只能让 CLI 自己去比对更新，
   * 因此 UI 不显示「升级到 x.y.z」而是显示「检查更新」。
   */
  selfUpdateCommand?: string
}

export interface LocalAcpToolStatus extends LocalAcpToolMeta {
  installed: boolean
  /** 解析到的可执行路径（已安装时） */
  resolvedPath?: string
  /** 实际命中的命令名 */
  resolvedCommand?: string
  /** 当前已安装版本号（跑 --version 解析，探测失败为 undefined） */
  currentVersion?: string
  /** npm registry 上的最新版本号（仅 npmPackageName 存在时查询） */
  latestVersion?: string
  /** 认证状态：ok=已登录，required=需登录，unknown=未知 */
  authStatus?: 'ok' | 'required' | 'unknown'
}

/** 工具元数据（官网 / GitHub / 安装页） */
export const LOCAL_ACP_TOOL_META: Record<PrimaryLocalAcpToolId, LocalAcpToolMeta> = {
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent CLI',
    // 注意：IDE 自带的 cursor.cmd 不是 Agent CLI，勿当作已安装
    // 官方文档的命令名是 agent，cursor-agent 是旧名，保留兜底
    description: '独立安装的 agent（非 Cursor 编辑器本身）',
    commands: ['agent', 'cursor-agent'],
    homepageUrl: 'https://cursor.com/docs/cli/overview',
    installUrl: 'https://cursor.com/cn/docs/cli/installation',
    installCommand: "irm 'https://cursor.com/install?win32=true' | iex",
    installHint: '安装的是 Agent CLI，不是 Cursor 编辑器；安装到 ~/.local/bin',
    // 无 npm/PyPI 包可查最新版；官方提供自更新命令
    selfUpdateCommand: 'agent update',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    commands: ['claude'],
    homepageUrl: 'https://code.claude.com/docs/en/installation',
    installUrl: 'https://code.claude.com/docs/en/installation',
    installCommand: 'irm https://claude.ai/install.ps1 | iex',
    installHint: '官方原生安装脚本（推荐）',
    npmPackageName: '@anthropic-ai/claude-code',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex CLI',
    commands: ['codex'],
    homepageUrl: 'https://openai.com/codex',
    installUrl: 'https://developers.openai.com/codex/cli',
    installCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    installHint: '官方独立安装脚本',
    npmPackageName: '@openai/codex',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode 开源编码助手',
    commands: ['opencode'],
    homepageUrl: 'https://opencode.ai',
    installUrl: 'https://opencode.ai/docs',
    installCommand: 'npm install -g opencode-ai',
    installHint: '官方 npm 包（内含各平台预编译二进制）',
    npmPackageName: 'opencode-ai',
  },
}

/** Windows 可直接/经 shell 启动的扩展名优先级（越高越好） */
const WIN_SPAWNABLE_EXT_SCORE: Record<string, number> = {
  '.exe': 100,
  '.cmd': 90,
  '.bat': 80,
  '.ps1': 50,
  '.com': 70,
}

/**
 * 判断路径是否适合在 Windows 上作为 spawn 目标
 * 无扩展名的 VS Code/Cursor 自带 shim 是 bash 脚本，spawn 会 ENOENT
 */
function scoreWindowsCliPath(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase()
  if (WIN_SPAWNABLE_EXT_SCORE[ext] != null) return WIN_SPAWNABLE_EXT_SCORE[ext]
  // 无扩展名：若同目录存在 .cmd/.exe 则丢弃；否则低分兜底
  if (!ext) {
    for (const e of ['.cmd', '.exe', '.bat']) {
      if (fs.existsSync(filePath + e)) return -1
    }
    try {
      const head = fs.readFileSync(filePath, { encoding: 'utf8' }).slice(0, 80)
      if (head.startsWith('#!') || head.includes('#!/')) return -1
    } catch {
      /* ignore */
    }
    return 10
  }
  return 0
}

/**
 * 从 where 输出中选出 Windows 可启动的最佳路径
 *
 * 保持 candidates 原有顺序（where.exe 按 PATH 先后返回）不重排：
 * PATH 里排前面的才是用户实际在用的那个。分数只用来剔除不可 spawn 的
 * shim（bash 脚本等），否则一台机器上任何同名的 .exe（哪怕是完全无关的
 * 桌面应用）都会盖过真正的 CLI，spawn 时把那个无关程序的窗口弹出来。
 */
export function pickBestWindowsCliPath(candidates: string[]): string | undefined {
  for (const p of candidates) {
    if (p && scoreWindowsCliPath(p) > 0 && fs.existsSync(p)) return p
  }

  // 无扩展名命中但同目录有 .cmd：补全扩展名
  for (const p of candidates) {
    if (!p || path.extname(p)) continue
    for (const e of ['.cmd', '.exe', '.bat']) {
      const withExt = p + e
      if (fs.existsSync(withExt)) return withExt
    }
  }
  return undefined
}

/**
 * Cursor Agent 的常见安装目录（Electron 进程可能读不到刚写入的 User PATH）
 *
 * 官方安装脚本装到 ~/.local/bin（文档：cursor.com/cn/docs/cli/installation）；
 * %LOCALAPPDATA%\cursor-agent 是早期版本的位置，保留兜底。
 */
function windowsCursorAgentWellKnownPaths(command: string): string[] {
  const roots = [path.join(os.homedir(), '.local', 'bin')]
  const local = process.env.LOCALAPPDATA
  if (local) roots.push(path.join(local, 'cursor-agent'))
  const names =
    command === 'agent'
      ? ['agent.exe', 'agent.cmd', 'cursor-agent.exe', 'cursor-agent.cmd']
      : ['cursor-agent.exe', 'cursor-agent.cmd', 'agent.exe', 'agent.cmd']
  return roots.flatMap((root) => names.map((n) => path.join(root, n)))
}

/**
 * 在 PATH 中解析命令（Windows 用 where，优先 .exe/.cmd，跳过 bash shim）
 */
async function resolveCommandPath(command: string): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const wellKnown =
        command === 'cursor-agent' || command === 'agent'
          ? windowsCursorAgentWellKnownPaths(command).filter((p) => fs.existsSync(p))
          : []
      let whereCandidates: string[] = []
      try {
        const { stdout } = await execFileAsync('where.exe', [command], {
          windowsHide: true,
          timeout: 8_000,
          maxBuffer: 1024 * 256,
        })
        whereCandidates = stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      } catch {
        /* where 未找到时继续查 well-known */
      }
      return pickBestWindowsCliPath([...wellKnown, ...whereCandidates])
    }
    const { stdout } = await execFileAsync('which', [command], {
      timeout: 8_000,
      maxBuffer: 1024 * 256,
    })
    const p = stdout.trim().split(/\r?\n/)[0]
    return p || undefined
  } catch {
    return undefined
  }
}

/**
 * 是否需要经 cmd shell 启动（.cmd / .bat）
 */
export function needsWindowsShell(commandPath: string): boolean {
  if (process.platform !== 'win32') return false
  const ext = path.extname(commandPath).toLowerCase()
  return ext === '.cmd' || ext === '.bat'
}

/**
 * 检测工具认证状态（cursor 用 agent status）
 */
async function detectAuthStatus(
  id: PrimaryLocalAcpToolId,
  resolvedPath: string,
): Promise<'ok' | 'required' | 'unknown'> {
  if (id !== 'cursor') return 'unknown' // 暂时只支持 cursor
  try {
    const useShell = needsWindowsShell(resolvedPath)
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const { spawn } = require('node:child_process')
      const child = spawn(resolvedPath, ['status'], {
        windowsHide: true,
        shell: useShell,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        child.kill()
        reject(new Error('timeout'))
      }, 5_000)
      child.stdout?.on('data', (buf: Buffer) => {
        stdout += buf.toString('utf8')
      })
      child.stderr?.on('data', (buf: Buffer) => {
        stderr += buf.toString('utf8')
      })
      child.on('error', (err: Error) => {
        clearTimeout(timeout)
        reject(err)
      })
      child.on('close', () => {
        clearTimeout(timeout)
        resolve({ stdout, stderr })
      })
    })
    const output = (result.stdout + result.stderr).toLowerCase()
    // "not logged in" 表示需要登录
    if (output.includes('not logged in') || output.includes('not authenticated')) {
      return 'required'
    }
    // 有 "logged in" 或 "authenticated" 表示已登录
    if (output.includes('logged in') || output.includes('authenticated')) {
      return 'ok'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 已安装时补充版本信息：当前版本探测 + npm/PyPI 最新版本查询（并行，互不阻塞）
 */
async function withVersionInfo(
  meta: LocalAcpToolMeta,
  resolvedPath: string,
  resolvedCommand: string,
): Promise<LocalAcpToolStatus> {
  const [currentVersion, latestVersion, authStatus] = await Promise.all([
    detectToolVersion(resolvedPath),
    meta.npmPackageName
      ? fetchNpmLatestVersion(meta.npmPackageName)
      : meta.pypiPackageName
        ? fetchPypiLatestVersion(meta.pypiPackageName)
        : Promise.resolve(undefined),
    detectAuthStatus(meta.id, resolvedPath),
  ])
  return {
    ...meta,
    installed: true,
    resolvedPath,
    resolvedCommand,
    ...(currentVersion ? { currentVersion } : {}),
    ...(latestVersion ? { latestVersion } : {}),
    ...(authStatus !== 'unknown' ? { authStatus } : {}),
  }
}

/**
 * 仅返回工具元数据清单（名称、链接、安装命令），无版本/状态探测。
 * 适用于初始渲染，避免批量探测阻塞 UI。
 */
export function listLocalAcpToolsMetadata(): LocalAcpToolMeta[] {
  return PRIMARY_LOCAL_ACP_TOOLS.map((id) => LOCAL_ACP_TOOL_META[id])
}

/**
 * 探测单个工具是否已安装，并补充版本信息（当前 + 最新）
 */
export async function detectLocalAcpTool(id: PrimaryLocalAcpToolId): Promise<LocalAcpToolStatus> {
  const meta = LOCAL_ACP_TOOL_META[id]
  for (const cmd of meta.commands) {
    const resolved = await resolveCommandPath(cmd)
    if (!resolved) continue
    return await withVersionInfo(meta, resolved, cmd)
  }
  return { ...meta, installed: false }
}

/**
 * backendId 是否属于本机主推工具
 */
export function isPrimaryLocalAcpToolId(id: string): id is PrimaryLocalAcpToolId {
  return (PRIMARY_LOCAL_ACP_TOOLS as readonly string[]).includes(id)
}
