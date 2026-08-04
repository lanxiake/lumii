/**
 * 本机开发类 AI 工具（ACP）元数据与 CLI 探测
 *
 * 常用子集：cursor / claude / codex / copilot
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** 面板主推的 4 个本机工具 */
export const PRIMARY_LOCAL_ACP_TOOLS = ['cursor', 'claude', 'codex', 'copilot'] as const

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
}

export interface LocalAcpToolStatus extends LocalAcpToolMeta {
  installed: boolean
  /** 解析到的可执行路径（已安装时） */
  resolvedPath?: string
  /** 实际命中的命令名 */
  resolvedCommand?: string
}

/** 工具元数据（官网 / GitHub / 安装页） */
export const LOCAL_ACP_TOOL_META: Record<PrimaryLocalAcpToolId, LocalAcpToolMeta> = {
  cursor: {
    id: 'cursor',
    label: 'Cursor CLI',
    description: 'Cursor Agent 命令行，本机代码编辑与任务执行',
    commands: ['cursor-agent', 'agent', 'cursor'],
    homepageUrl: 'https://cursor.com',
    githubUrl: 'https://github.com/getcursor/cursor',
    installUrl: 'https://cursor.com/downloads',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    commands: ['claude'],
    homepageUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    githubUrl: 'https://github.com/anthropics/claude-code',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex CLI',
    commands: ['codex'],
    homepageUrl: 'https://openai.com/codex',
    githubUrl: 'https://github.com/openai/codex',
    installUrl: 'https://github.com/openai/codex#installation',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    description: 'GitHub Copilot CLI（需 gh 与 copilot 扩展）',
    commands: ['gh', 'copilot'],
    homepageUrl: 'https://github.com/features/copilot',
    githubUrl: 'https://github.com/github/gh-copilot',
    installUrl: 'https://docs.github.com/en/copilot/how-tos/set-up/install-copilot',
  },
}

/**
 * 在 PATH 中解析命令（Windows 用 where）
 */
async function resolveCommandPath(command: string): Promise<string | undefined> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('where.exe', [command], {
        windowsHide: true,
        timeout: 8_000,
        maxBuffer: 1024 * 256,
      })
      const first = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0)
      if (first && fs.existsSync(first)) return first
      return first || undefined
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
        return { ...meta, installed: true, resolvedPath: resolved, resolvedCommand: 'gh copilot' }
      } catch {
        continue
      }
    }
    return { ...meta, installed: true, resolvedPath: resolved, resolvedCommand: cmd }
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
