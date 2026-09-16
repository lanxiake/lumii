/**
 * MCP 服务查询 — 供 AI 团队页在「角色编辑/详情」里勾选与展示 MCP 服务
 *
 * 只读；配置读写仍在 McpServersPanel 的 useMcpServers。
 */
import type { McpStatusPayload, McpServerStatusResult } from '@shared/agent-runtime-commands'

/** AI 团队页用到的 MCP 服务视图 */
export interface McpServerOption {
  name: string
  /** 该 server 暴露的工具全名（mcp__<server>__<tool>） */
  tools: string[]
  connected: boolean
}

/** 列出已启用的 MCP 服务（未启用的不参与勾选，其工具本就不在候选集里） */
export async function listEnabledMcpServers(): Promise<McpServerOption[]> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return []
  try {
    const payload = (await api.sendCommand({ type: 'mcp:status' })) as McpStatusPayload
    const servers: readonly McpServerStatusResult[] = payload?.servers ?? []
    return servers
      .filter((s) => s.enabled !== false)
      .map((s) => ({ name: s.name, tools: [...(s.tools ?? [])], connected: s.connected }))
  } catch {
    // MCP 查询失败不阻塞页面主功能，勾选区按空列表降级
    return []
  }
}
