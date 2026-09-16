/**
 * asset_checkup — 资产体检的机械检查项
 *
 * stub 实现，由平台集成层（bridge-maintenance-tools.ts）覆盖 execute。
 *
 * 它存在的意义是**分工**：机械可判的项（预算、完全重复、序列化残迹、长期未用……）
 * 交给代码做，确定、零 token、每轮一致；模型只负责判断类项（矛盾、层级错放、措辞归并）
 * 与把结果讲清楚。没有这个工具时，巡检全靠提示词自觉，每次查哪几项、查到什么程度
 * 都由模型现场决定。
 *
 * 只读：返回清单，不做任何修改。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const AssetCheckupParams = Type.Object({
  scope: Type.Union([Type.Literal("memory")], {
    description: "体检范围。当前支持 memory（偏好层 + 工作记忆的机械检查项）",
  }),
});

type AssetCheckupInput = Static<typeof AssetCheckupParams>;

export const assetCheckupToolConfig: MtBotToolConfig<typeof AssetCheckupParams> = {
  name: "asset_checkup",
  label: "Asset Checkup",
  description:
    "Run the mechanical part of a check-up: injection budget, exact duplicates, JSON-serialization " +
    "residue, instruction-style leftovers, stale and tiny entries. Deterministic and free — call it " +
    "FIRST, then spend your own judgement on what code cannot decide (contradictions, misplacement, " +
    "wording merges). Read-only: it reports candidates, it does not modify anything.",
  parameters: AssetCheckupParams,
  category: "agent",
  isReadOnly: true,
  needsPermission: false,
  async execute(_toolCallId: string, _params: AssetCheckupInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message: "asset_checkup requires platform integration layer.",
          }),
        },
      ],
      details: undefined,
    };
  },
};
