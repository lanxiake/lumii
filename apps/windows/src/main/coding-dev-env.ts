/**
 * 开发类 AI 工具（ACP）在 Windows 客户端侧的工作区解析与环境变量注入。
 * 独立版仅连接本机 CLI，不再依赖 Gateway 侧环境变量说明。
 */
import { join } from 'path'
import type { AgentDevBinding, AppConfig } from './config/types.js'
import { resolveActiveProjectPath } from './coding-dev-projects.js'
import { getDevContext } from './coding-dev-dev-context.js'
import type { CodingDevBackendId } from './coding-dev-backends-stub/contracts.js'

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
 * 从各 MTBOT_*_ACP_CWD 写入当前进程环境，供本机 CLI 子进程继承。
 */
export function applyCodingDevAcpEnvToProcess(workspacePath: string): void {
  const normalized = workspacePath.replace(/\\/g, '/')
  for (const key of CODING_DEV_ACP_CWD_ENV_KEYS) {
    process.env[key] = normalized
  }
}

/** 开发相关配置切片（codingDev* 字段）；解析器只依赖这两个字段，避免耦合完整 AppConfig */
export type CodingDevConfigSlice = Pick<AppConfig, 'codingDevProjects' | 'codingDevAgentBindings'>

/**
 * 本机开发配置访问（由 index.ts 注入）。
 * 渠道命令 / 命令处理器等以统一方式读取 codingDev* 配置；未注入时返回空切片。
 */
let _devConfigGetter: (() => CodingDevConfigSlice) | null = null

export function setCodingDevConfigGetter(getter: () => CodingDevConfigSlice): void {
  _devConfigGetter = getter
}

export function getCodingDevConfig(): CodingDevConfigSlice {
  return _devConfigGetter?.() ?? {}
}

/**
 * 解析会话绑定 Agent 的开发绑定（Agent → CLI + 工作目录）。
 * 未配置或未启用返回 undefined。
 */
export function resolveAgentDevBinding(
  appConfig: CodingDevConfigSlice,
  agentId: string | undefined,
): AgentDevBinding | undefined {
  if (!agentId) return undefined
  return appConfig.codingDevAgentBindings?.find((b) => b.agentId === agentId && b.enabled)
}

/**
 * 按项目名解析 realPath（会话级 /project 选择用）。
 * 项目不存在或未注册时返回 undefined（调用方回退）。
 */
export function resolveProjectPathByName(
  appConfig: CodingDevConfigSlice,
  name: string | undefined,
): string | undefined {
  const trimmed = name?.trim()
  if (!trimmed) return undefined
  return appConfig.codingDevProjects?.find((p) => p.name === trimmed)?.realPath
}

/** 会话的最终开发上下文（供路由与模式 chip 共用） */
export type ResolvedDevContext = {
  backendId: CodingDevBackendId
  projectName?: string
  projectPath?: string
  /** 命中来源：会话显式 > Agent 绑定 > 全局默认 */
  source: 'session' | 'binding' | 'global'
}

/**
 * 解析会话的最终开发上下文：会话显式（dev-context）> Agent 绑定 > 全局默认（调用方传入）。
 * 桌面与渠道共用（渠道无 Agent 绑定层，agentId 传 undefined）。
 */
export function resolveDevContext(params: {
  appConfig: CodingDevConfigSlice
  accountId: string
  sessionKey: string
  agentId?: string
  fallbackBackendId: CodingDevBackendId
}): ResolvedDevContext {
  const devCtx = getDevContext(params.accountId, params.sessionKey)
  const binding = resolveAgentDevBinding(params.appConfig, params.agentId)
  const backendId = devCtx?.backendId ?? binding?.backendId ?? params.fallbackBackendId
  const projectName = devCtx?.projectName
  const projectPath = resolveProjectPathByName(params.appConfig, projectName) ?? binding?.workspace
  const source: ResolvedDevContext['source'] = devCtx ? 'session' : binding ? 'binding' : 'global'
  return {
    backendId,
    ...(projectName ? { projectName } : {}),
    ...(projectPath ? { projectPath } : {}),
    source,
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
