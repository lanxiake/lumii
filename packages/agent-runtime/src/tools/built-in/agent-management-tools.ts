/**
 * agent_management_tools — Agent 团队管理工具
 *
 * 让主 Agent 能够直接生成、优化和移除自定义 Agent，减少用户手动操作。
 * Stub 实现，Electron bridge 层覆盖 execute 实现真实逻辑。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const notImplemented = (): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: JSON.stringify({ status: "not_implemented" }) }],
  details: undefined,
});

// ── Agent 团队生成 ──

const AgentTeamGenerateParams = Type.Object({
  teamDescription: Type.String({
    description:
      "Describe the team's goal and what kinds of agents are needed (e.g., 'A frontend team with a React specialist and a CSS expert').",
  }),
  agents: Type.Array(
    Type.Object({
      systemAgentId: Type.String({
        description: "System Agent ID to fork (e.g., 'default', 'coder', 'researcher').",
      }),
      name: Type.String({ description: "Display name for this agent in the team." }),
      description: Type.Optional(
        Type.String({ description: "Short description of this agent's role in the team." }),
      ),
    }),
    {
      description:
        "List of agents to create for the team. Each agent is forked from a system agent.",
      minItems: 1,
    },
  ),
});
type AgentTeamGenerateInput = Static<typeof AgentTeamGenerateParams>;

export const agentTeamGenerateToolConfig: MtBotToolConfig<typeof AgentTeamGenerateParams> = {
  name: "agent_team_generate",
  label: "Generate Agent Team",
  description:
    "Generate a team of custom agents by forking system agents. Use this when the user wants to set up a specialized team for a project or workflow.",
  parameters: AgentTeamGenerateParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,
  async execute(_id: string, _p: AgentTeamGenerateInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

// ── Agent 团队优化 ──

const AgentTeamOptimizeParams = Type.Object({
  agentUpdates: Type.Array(
    Type.Object({
      agentId: Type.String({ description: "ID of the custom agent to update." }),
      name: Type.Optional(Type.String({ description: "New display name." })),
      description: Type.Optional(Type.String({ description: "New description." })),
      soulContent: Type.Optional(
        Type.String({ description: "New SOUL.md content (personality, style, constraints)." }),
      ),
    }),
    {
      description: "List of agents to update with their new configurations.",
      minItems: 1,
    },
  ),
  reason: Type.Optional(
    Type.String({ description: "Why these changes improve the team (shown to user)." }),
  ),
});
type AgentTeamOptimizeInput = Static<typeof AgentTeamOptimizeParams>;

export const agentTeamOptimizeToolConfig: MtBotToolConfig<typeof AgentTeamOptimizeParams> = {
  name: "agent_team_optimize",
  label: "Optimize Agent Team",
  description:
    "Update and optimize existing custom agents' names, descriptions, or personality (SOUL). Use this to improve team configuration based on user feedback or new requirements.",
  parameters: AgentTeamOptimizeParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,
  async execute(_id: string, _p: AgentTeamOptimizeInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};

// ── Agent 移除 ──

const AgentRemoveParams = Type.Object({
  agentId: Type.String({ description: "ID of the custom agent to remove." }),
  agentName: Type.Optional(
    Type.String({ description: "Name of the agent (for confirmation display)." }),
  ),
});
type AgentRemoveInput = Static<typeof AgentRemoveParams>;

export const agentRemoveToolConfig: MtBotToolConfig<typeof AgentRemoveParams> = {
  name: "agent_remove",
  label: "Remove Agent",
  description:
    "Delete a custom agent. Only user-created agents can be removed; system agents cannot be deleted.",
  parameters: AgentRemoveParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,
  async execute(_id: string, _p: AgentRemoveInput): Promise<AgentToolResult<unknown>> {
    return notImplemented();
  },
};
