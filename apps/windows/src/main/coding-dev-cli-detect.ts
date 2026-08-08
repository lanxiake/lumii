/**
 * 本机开发类 AI 工具（ACP）元数据与 CLI 探测
 *
 * 常用子集：cursor / claude / codex / copilot
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { detectToolVersion, fetchNpmLatestVersion } from './coding-dev-cli-version.js'

const execFileAsync = promisify(execFile)

/** 面板主推的本机工具 */
export const PRIMARY_LOCAL_ACP_TOOLS = ['cursor', 'claude', 'codex', 'copilot', 'gemini', 'opencode'] as const

export type PrimaryLocalAcpToolId = (typeof PRIMARY_LOCAL_ACP_TOOLS)[number]

export interface LocalAcpToolMeta {
  id: PrimaryLocalAcpToolId
  label: string
  description: string
  /** where 探测候选命令（按优先级） */
  commands: string[]
  homepageUrl: string
  githubUrl?: string
  installUrl: string
  /** 官方一键安装命令（Windows PowerShell，供 UI 展示） */
  installCommand: string
  /** 安装说明 */
  installHint: string
  /** npm 包名，用于查询最新版本（registry.npmjs.org）；不设置则跳过最新版本查询（如 cursor-agent 无公开查询接口） */
  npmPackageName?: string
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
}

/** 工具元数据（官网 / GitHub / 安装页） */
export const LOCAL_ACP_TOOL_META: Record<PrimaryLocalAcpToolId, LocalAcpToolMeta> = {
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent CLI',
    // 注意：IDE 自带的 cursor.cmd 不是 Agent CLI，勿当作已安装
    description: '独立安装的 agent / cursor-agent（非 Cursor 编辑器本身）',
    commands: ['cursor-agent', 'agent'],
    homepageUrl: 'https://cursor.com/docs/cli/overview',
    githubUrl: 'https://github.com/getcursor/cursor',
    installUrl: 'https://cursor.com/docs/cli/installation',
    installCommand: "irm 'https://cursor.com/install?win32=true' | iex",
    installHint: '安装的是 Agent CLI，不是 Cursor 编辑器',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    commands: ['claude'],
    homepageUrl: 'https://code.claude.com/docs/en/installation',
    githubUrl: 'https://github.com/anthropics/claude-code',
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
    githubUrl: 'https://github.com/openai/codex',
    installUrl: 'https://github.com/openai/codex#installation',
    installCommand: 'irm https://chatgpt.com/codex/install.ps1 | iex',
    installHint: '官方独立安装脚本',
    npmPackageName: '@openai/codex',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    description: '独立 Copilot CLI（npm：@github/copilot）',
    commands: ['copilot', 'gh'],
    homepageUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
    githubUrl: 'https://github.com/github/copilot-cli',
    installUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
    installCommand: 'npm install -g @github/copilot',
    installHint: '需 Node.js 22+；也可 winget install GitHub.Copilot',
    npmPackageName: '@github/copilot',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'Google Gemini CLI',
    commands: ['gemini'],
    homepageUrl: 'https://github.com/google-gemini/gemini-cli',
    githubUrl: 'https://github.com/google-gemini/gemini-cli',
    installUrl: 'https://github.com/google-gemini/gemini-cli#installation',
    installCommand: 'npm install -g @google/gemini-cli',
    installHint: '需 Node.js 20+；官方 npm 包',
    npmPackageName: '@google/gemini-cli',
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    description: 'OpenCode 开源编码助手',
    commands: ['opencode'],
    homepageUrl: 'https://opencode.ai',
    githubUrl: 'https://github.com/sst/opencode',
    installUrl: 'https://opencode.ai/docs',
    installCommand: '请参考官网安装步骤',
    installHint: '安装方式因平台而异，请查看官网文档',
    // npm 包名未核实，不编造，暂不查询最新版本
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
 */
function pickBestWindowsCliPath(candidates: string[]): string | undefined {
  const scored = candidates
    .map((p) => ({ p, score: scoreWindowsCliPath(p) }))
    .filter((x) => x.score > 0 && fs.existsSync(x.p))
    .sort((a, b) => b.score - a.score)
  if (scored[0]) return scored[0].p

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
 * Windows 上 Cursor Agent 的常见安装目录（Electron 进程可能读不到刚写入的 User PATH）
 */
function windowsCursorAgentWellKnownPaths(command: string): string[] {
  const local = process.env.LOCALAPPDATA
  if (!local) return []
  const root = path.join(local, 'cursor-agent')
  const names =
    command === 'agent'
      ? ['agent.exe', 'agent.cmd', 'cursor-agent.exe', 'cursor-agent.cmd']
      : ['cursor-agent.exe', 'cursor-agent.cmd', 'agent.exe', 'agent.cmd']
  return names.map((n) => path.join(root, n))
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
 * 已安装时补充版本信息：当前版本探测 + npm 最新版本查询（并行，互不阻塞）
 */
async function withVersionInfo(
  meta: LocalAcpToolMeta,
  resolvedPath: string,
  resolvedCommand: string,
): Promise<LocalAcpToolStatus> {
  const [currentVersion, latestVersion] = await Promise.all([
    detectToolVersion(resolvedPath),
    meta.npmPackageName ? fetchNpmLatestVersion(meta.npmPackageName) : Promise.resolve(undefined),
  ])
  return {
    ...meta,
    installed: true,
    resolvedPath,
    resolvedCommand,
    ...(currentVersion ? { currentVersion } : {}),
    ...(latestVersion ? { latestVersion } : {}),
  }
}

/**
 * 探测单个工具是否已安装
 */
export async function detectLocalAcpTool(id: PrimaryLocalAcpToolId): Promise<LocalAcpToolStatus> {
  const meta = LOCAL_ACP_TOOL_META[id]
  for (const cmd of meta.commands) {
    const resolved = await resolveCommandPath(cmd)
    if (!resolved) continue
    // copilot：仅 gh 不算装好，需能跑 gh copilot
    if (id === 'copilot' && path.basename(resolved).toLowerCase().startsWith('gh')) {
      try {
        await execFileAsync(resolved, ['copilot', '--help'], {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 1024 * 512,
        })
        return await withVersionInfo(meta, resolved, 'gh copilot')
      } catch {
        continue
      }
    }
    return await withVersionInfo(meta, resolved, cmd)
  }
  return { ...meta, installed: false }
}

/**
 * 探测全部主推工具
 */
export async function detectAllLocalAcpTools(): Promise<LocalAcpToolStatus[]> {
  const list: LocalAcpToolStatus[] = []
  for (const id of PRIMARY_LOCAL_ACP_TOOLS) {
    list.push(await detectLocalAcpTool(id))
  }
  return list
}

/**
 * backendId 是否属于本机主推工具
 */
export function isPrimaryLocalAcpToolId(id: string): id is PrimaryLocalAcpToolId {
  return (PRIMARY_LOCAL_ACP_TOOLS as readonly string[]).includes(id)
}
