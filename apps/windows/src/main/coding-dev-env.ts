/**
 * 开发类 AI 工具（ACP）在 Windows 客户端侧的工作区解析与环境变量注入。
 * 独立版仅连接本机 CLI，不再依赖 Gateway 侧环境变量说明。
 */
import { join } from 'path'
import type { AppConfig } from './config/types.js'
import { resolveActiveProjectPath } from './coding-dev-projects.js'

/** 与各本机 CLI 的 cwd 环境变量一致 */
export const CODING_DEV_ACP_CWD_ENV_KEYS = [
  'MTBOT_CODEX_ACP_CWD',
  'MTBOT_CLAUDE_ACP_CWD',
  'MTBOT_QODER_ACP_CWD',
  'MTBOT_QWEN_ACP_CWD',
  'MTBOT_KIMI_ACP_CWD',
  'MTBOT_OPENCODE_ACP_CWD',
  'MTBOT_COPILOT_ACP_CWD',
  'MTBOT_AUGGIE_ACP_CWD',
  'MTBOT_CURSOR_ACP_CWD',
] as const

export type CodingDevEnvInfo = {
  /** 解析后的 ACP 工作目录（绝对路径） */
  resolvedWorkspace: string
  /** 是否使用独立目录（否则与主工作区相同） */
  usesDedicatedWorkspace: boolean
  /** @deprecated 独立版不再展示 Gateway PowerShell 块，保留字段兼容旧 preload */
  powershellGatewayEnvBlock: string
  /** 斜杠切换提示 */
  weixinSlashHint: string
}

/**
 * 解析当前会话应使用的 ACP 工作目录：专用目录优先，否则主工作区，否则默认路径。
 */
export function resolveCodingDevAcpWorkspacePath(params: {
  appConfig: AppConfig
  defaultWorkspaceFallback: string
}): string {
  const active = resolveActiveProjectPath(
    params.appConfig.codingDevProjects,
    params.appConfig.codingDevActiveProject,
  )
  if (active) return active
  const dedicated = params.appConfig.codingDevAcpWorkspace?.trim()
  if (dedicated) return dedicated
  const main = params.appConfig.workspaceDirectory?.trim()
  if (main) return main
  return params.defaultWorkspaceFallback
}

/**
 * 将各 MTBOT_*_ACP_CWD 写入当前进程环境，供本机 CLI 子进程继承。
 */
export function applyCodingDevAcpEnvToProcess(workspacePath: string): void {
  const normalized = workspacePath.replace(/\\/g, '/')
  for (const key of CODING_DEV_ACP_CWD_ENV_KEYS) {
    process.env[key] = normalized
  }
}

/**
 * 构建供渲染进程展示的环境信息（本机模式）。
 */
export function buildCodingDevEnvInfo(params: {
  appConfig: AppConfig
  defaultWorkspaceFallback: string
}): CodingDevEnvInfo {
  const resolvedWorkspace = resolveCodingDevAcpWorkspacePath({
    appConfig: params.appConfig,
    defaultWorkspaceFallback: params.defaultWorkspaceFallback,
  })
  const usesDedicatedWorkspace = Boolean(
    resolveActiveProjectPath(
      params.appConfig.codingDevProjects,
      params.appConfig.codingDevActiveProject,
    ) || params.appConfig.codingDevAcpWorkspace?.trim(),
  )
  return {
    resolvedWorkspace,
    usesDedicatedWorkspace,
    powershellGatewayEnvBlock: '',
    weixinSlashHint:
      '对话中可用 /cursor、/claude、/codex、/copilot 切换本机工具，/lumii 切回主代理。',
  }
}

/**
 * 默认工作区路径
 */
export function defaultWorkspaceFallback(mtbotDataDir: string): string {
  return join(mtbotDataDir, 'workspace')
}
