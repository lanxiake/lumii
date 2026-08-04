/**
 * mcp-source — 将 MCP 工具定义暴露为 CapabilityDescriptor[]
 *
 * MCP 工具归类为 "network" 权限（通过 stdio 调外部进程）。
 * 对 cloud_channel 默认不设高风险，但保留 network 权限供 origin 过滤决策。
 */

import type { McpToolDefinition } from "../../tools/mcp/mcp-client.js";
import type { CapabilityDescriptor } from "../types.js";

export function mcpToolsToCapabilities(
  tools: readonly McpToolDefinition[],
  serverName: string,
): CapabilityDescriptor[] {
  return tools.map((tool) => ({
    id: `mcp__${serverName}__${tool.name}`,
    source: "mcp" as const,
    name: `${serverName}: ${tool.name}`,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    permissions: ["read", "network"] as const,
    isHighRisk: false,
  }));
}
