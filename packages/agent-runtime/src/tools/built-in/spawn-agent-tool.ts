/**
 * spawn_agent 工具 — 启动子 Agent
 *
 * 支持 sync（阻塞等待完成）和 async（后台运行）两种模式。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../../tools/tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const SpawnAgentParams = Type.Object({
  name: Type.String({ description: "Human-readable name for the sub-agent" }),
  prompt: Type.String({
    description:
      "Initial prompt for the sub-agent. Must be self-contained — " +
      "the sub-agent cannot see the parent conversation.",
  }),
  agentType: Type.Optional(
    Type.String({
      description: 'Agent type/role that determines available tools (e.g., "worker", "researcher")',
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("sync"), Type.Literal("async")], {
      description:
        "sync (default): block until sub-agent completes and return its output. " +
        "async: run in background, returns immediately with instanceId. " +
        "Use sync unless the user explicitly asks for long-running background work, " +
        "otherwise the parent agent has no way to integrate the sub-agent's result.",
      default: "sync",
    }),
  ),
  description: Type.Optional(Type.String({ description: "Description shown in UI" })),
  model: Type.Optional(Type.String({ description: "Model override for the sub-agent" })),
  allowedTools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Tool whitelist for the sub-agent. Supports parameterized syntax like "bash(git:*)" ' +
        "to restrict tool parameters. If omitted, inherits from agent definition.",
    }),
  ),
});

type SpawnAgentInput = Static<typeof SpawnAgentParams>;

/**
 * spawn_agent 工具配置
 *
 * 实际执行逻辑需要 AgentRuntime 引用，
 * 这里提供工具定义 stub，由平台集成层（bridge）提供 execute 实现。
 */
export const spawnAgentToolConfig: MtBotToolConfig<typeof SpawnAgentParams> = {
  name: "spawn_agent",
  label: "Spawn Agent",
  description:
    "Launch a new sub-agent to perform a task. Use sync mode for quick queries, async mode for long-running tasks.",
  parameters: SpawnAgentParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,

  async execute(_toolCallId: string, params: SpawnAgentInput): Promise<AgentToolResult<unknown>> {
    // stub 实现 — 实际执行由平台集成层覆盖
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message:
              `spawn_agent is a stub. Platform integration layer should override this. ` +
              `Requested: name=${params.name}, mode=${params.mode ?? "async"}`,
          }),
        },
      ],
      details: undefined,
    };
  },
};
