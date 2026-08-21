/**
 * Tools 和 MCP 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { getToolUsage } from '../../tool-usage-store'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

// ============================================================
// Tools 命令处理器
// ============================================================

export async function handleToolsList(bridge: AgentRuntimeBridge): Promise<unknown> {
  // 附带累计调用次数，让 UI 能标出高频/从未使用的工具
  const usage = await getToolUsage()
  return bridge.listTools().map((tool) => {
    const stat = usage[tool.name]
    return {
      ...tool,
      usageCount: stat?.count ?? 0,
      ...(stat?.lastUsedAt ? { lastUsedAt: stat.lastUsedAt } : {}),
    }
  })
}

export function handleToolsToggle(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tools:toggle' }>,
): { success: boolean } {
  const success = bridge.toggleTool(command.toolName, command.enabled)
  log.info(
    `[tools:toggle] toolName=${command.toolName} enabled=${command.enabled} success=${success}`,
  )
  return { success }
}

// ============================================================
// MCP 命令处理器
// ============================================================

export function handleMcpStatus(bridge: AgentRuntimeBridge): unknown {
  const configError = bridge.getMcpConfigError()
  return {
    servers: bridge.getMcpStatus(),
    ...(configError ? { configError } : {}),
  }
}

export async function handleMcpUpsert(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:upsert' }>,
): Promise<{ success: boolean; error?: string }> {
  return toMcpResult(() => bridge.upsertMcpServer(command.entry, command.originalName))
}

export async function handleMcpImport(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:import' }>,
): Promise<{ success: boolean; error?: string }> {
  return toMcpResult(() => bridge.importMcpServers(command.entries))
}

export async function handleMcpRemove(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:remove' }>,
): Promise<{ success: boolean; error?: string }> {
  return toMcpResult(() => bridge.removeMcpServer(command.name))
}

export async function handleMcpSetEnabled(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:setEnabled' }>,
): Promise<{ success: boolean; error?: string }> {
  return toMcpResult(() => bridge.setMcpServerEnabled(command.name, command.enabled))
}

export async function handleMcpReconnect(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:reconnect' }>,
): Promise<{ success: boolean; error?: string }> {
  return toMcpResult(() => bridge.reconnectMcpServer(command.name))
}

export function handleMcpReadConfigFile(bridge: AgentRuntimeBridge): unknown {
  return bridge.readMcpConfigFile()
}

export async function handleMcpWriteConfigFile(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:writeConfigFile' }>,
): Promise<{ success: boolean; error?: string }> {
  return toMcpResult(() => bridge.writeMcpConfigFile(command.content))
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 把 MCP 写操作包成 { success, error }
 *
 * 配置无效、名称冲突、命令启动失败都是用户可修的日常错误，
 * 不该抛到 IPC 边界外变成 renderer 的未捕获 rejection。
 */
async function toMcpResult(
  action: () => Promise<void>,
): Promise<{ success: boolean; error?: string }> {
  try {
    await action()
    return { success: true }
  } catch (err) {
    const error = (err as Error).message
    log.error('[mcp] 操作失败:', error)
    return { success: false, error }
  }
}
