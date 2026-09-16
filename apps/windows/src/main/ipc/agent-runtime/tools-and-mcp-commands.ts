/**
 * Tools 和 MCP 命令处理器
 *
 * 提取自 agent-runtime-ipc.ts
 */

import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { getToolUsage, getToolUsageByAgent, UNKNOWN_AGENT_ID } from '../../tool-usage-store'
import { BUILT_IN_AGENTS } from '@mtbot/agent-runtime'
import { buildToolUsageExportPayload } from './tool-usage-export'

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

/**
 * 逐 Agent 的工具用量。
 *
 * 这份数据的用途不是「看看数字」——是回答「某个工具到底有没有人用」，
 * 而那是逐 Agent 收敛工具面的唯一依据。之前只有全局累计计数，
 * 于是「维护用没用过 wiki_read」这类问题只能靠猜。
 *
 * @param days >0 时只统计最近 N 天。**两种口径刻意不互相兜底**：
 *   累计表里混着 V44 之前无法归因的存量，拿它当「最近 N 天」用，
 *   就是 B1 那个坑（把历史存量当当前状态）的复发。
 *
 * 在主进程就把名字解析好、排好序：渲染层只负责画。
 */
export async function handleToolsUsageByAgent(days = 0): Promise<unknown> {
  const byAgent = await getToolUsageByAgent({ days })
  const nameById = new Map(BUILT_IN_AGENTS.map((a) => [a.id, a.name]))

  return Object.entries(byAgent)
    .map(([id, tools]) => {
      const rows = Object.entries(tools)
        .map(([name, s]) => ({
          name,
          count: s.count,
          errorCount: s.errorCount,
          lastUsedAt: s.lastUsedAt,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      return {
        id,
        // 内建 Agent 取显示名；自定义 Agent 与未归因桶回落 id —— 不编名字
        name:
          id === UNKNOWN_AGENT_ID
            ? '未归因（V44 之前的存量）'
            : (nameById.get(id) ?? id),
        totalCalls: rows.reduce((sum, r) => sum + r.count, 0),
        tools: rows,
      }
    })
    .sort((a, b) => b.totalCalls - a.totalCalls)
}

/**
 * 导出工具使用记录（按 Agent 明细 + 全局合计），供离线分析与工具面优化。
 */
export async function handleToolsUsageExport(): Promise<{ json: string }> {
  const [byAgent, totals] = await Promise.all([
    handleToolsUsageByAgent() as Promise<
      ReadonlyArray<{
        id: string
        name: string
        totalCalls: number
        tools: ReadonlyArray<{
          name: string
          count: number
          errorCount: number
          lastUsedAt: number
        }>
      }>
    >,
    getToolUsage(),
  ])
  const payload = buildToolUsageExportPayload({
    exportedAt: Date.now(),
    byAgent,
    totals,
  })
  return { json: JSON.stringify(payload, null, 2) }
}

// ============================================================
// MCP 命令处理器
// ============================================================

export function handleMcpStatus(bridge: AgentRuntimeBridge): unknown {
  const configError = bridge.getMcpConfigError()
  // 每个 server 的估算 token：让用户看见「这个 server 值多少上下文」，
  // 这是判断该关谁的唯一依据（实测有 server 单独占掉 150K/200K 窗口）。
  const costByServer = new Map(bridge.getMcpServerTokenCosts().map((c) => [c.name, c]))
  return {
    servers: bridge.getMcpStatus().map((s) => ({
      ...s,
      estimatedTokens: costByServer.get(s.name)?.tokens ?? 0,
    })),
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

export function handleMcpSetSessionEnabled(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:setSessionEnabled' }>,
): { disabledServers: readonly string[] } {
  return {
    disabledServers: bridge.setSessionMcpServerEnabled(
      command.sessionKey,
      command.name,
      command.enabled,
    ),
  }
}

export function handleMcpSessionDisabled(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'mcp:sessionDisabled' }>,
): { disabledServers: readonly string[] } {
  return { disabledServers: bridge.getSessionDisabledMcpServers(command.sessionKey) }
}

export function handleSkillSetSessionEnabled(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'skill:setSessionEnabled' }>,
): { disabledSkills: readonly string[] } {
  return {
    disabledSkills: bridge.setSessionSkillEnabled(
      command.sessionKey,
      command.skillId,
      command.enabled,
    ),
  }
}

export function handleSkillSessionDisabled(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'skill:sessionDisabled' }>,
): { disabledSkills: readonly string[] } {
  return { disabledSkills: bridge.getSessionDisabledSkills(command.sessionKey) }
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
