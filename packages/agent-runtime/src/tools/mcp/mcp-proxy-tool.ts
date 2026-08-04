/**
 * MCP Proxy Tool — 将 MCP Server 工具注册为 Agent 工具
 *
 * 将 MCP Server 暴露的工具列表转换为 MtBotTool[]，注册到 ToolRegistry。
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { MtBotTool, ToolCategory } from "../../types/tool.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { McpStdioClient, McpToolDefinition } from "./mcp-client.js";

/**
 * 将 JSON Schema 转换为 TypeBox schema（简化版）
 *
 * MCP 工具使用标准 JSON Schema 定义参数，
 * 需要转换为 TypeBox 的 TSchema 以兼容 pi-agent-core。
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown>): TSchema {
  // 简化处理：将原始 JSON Schema 作为 TypeBox Unsafe 类型传递
  // pi-agent-core 会直接使用 JSON Schema 进行验证
  return Type.Unsafe(schema);
}

/**
 * 将单个 MCP 工具定义转换为 MtBotTool
 */
function createMcpProxyTool(
  toolDef: McpToolDefinition,
  client: McpStdioClient,
  serverName: string,
): MtBotTool {
  const parameters = jsonSchemaToTypeBox(toolDef.inputSchema);

  return {
    name: `mcp__${serverName}__${toolDef.name}`,
    label: `${serverName}: ${toolDef.name}`,
    description: toolDef.description ?? `MCP tool: ${toolDef.name}`,
    parameters,
    category: "channel" as ToolCategory, // MCP 工具归类为外部 channel
    isReadOnly: false,
    needsPermission: true,
    isEnabled: () => client.initialized,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> {
      const args = (params ?? {}) as Record<string, unknown>;
      try {
        const result = (await client.callTool(toolDef.name, args)) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };

        const textContent = (result.content ?? [])
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!)
          .join("\n");

        return {
          content: [{ type: "text", text: textContent || "(no output)" }],
          details: {
            mcpServer: serverName,
            mcpTool: toolDef.name,
            isError: result.isError ?? false,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {
            mcpServer: serverName,
            mcpTool: toolDef.name,
            isError: true,
          },
        };
      }
    },
  };
}

/**
 * 从 MCP Server 加载工具并转换为 MtBotTool 数组
 */
export async function loadMcpTools(
  client: McpStdioClient,
  serverName: string,
): Promise<readonly MtBotTool[]> {
  const toolDefs = await client.listTools();
  return toolDefs.map((def) => createMcpProxyTool(def, client, serverName));
}
