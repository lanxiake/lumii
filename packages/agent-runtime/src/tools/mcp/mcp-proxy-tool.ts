/**
 * MCP Proxy Tool — 将 MCP Server 工具注册为 Agent 工具
 *
 * 将 MCP Server 暴露的工具列表转换为 MtBotTool[]，注册到 ToolRegistry。
 */

import { Type, type TSchema } from "@sinclair/typebox";
import type { MtBotTool, MtBotToolResult, ToolCategory } from "../../types/tool.js";
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
    ): Promise<MtBotToolResult<unknown>> {
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
          // MCP 协议自带 isError 时提到顶层——它才是 ToolRunner/模型认得的失败信号。
          // details 里**不再**冗余一份：顶层 isError 会被 tool-registry 转成 throw，
          // 随后 pi-agent-core 清空 details，那份副本在失败路径上永远读不到。
          isError: result.isError ?? false,
          details: {
            mcpServer: serverName,
            mcpTool: toolDef.name,
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
          // 此处刻意不 rethrow：MCP 传输层异常（server 崩溃/超时）对模型而言
          // 与工具自报失败等价，转成 isError 即可，无需让 pi-agent-core 再包一层。
          isError: true,
          details: {
            mcpServer: serverName,
            mcpTool: toolDef.name,
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
