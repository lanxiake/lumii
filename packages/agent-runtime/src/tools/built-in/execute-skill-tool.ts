/**
 * execute_skill 工具 — 执行本地已安装技能
 *
 * 用于 executable 类技能（有 run.ts / run.py 等入口文件）的直接调用。
 * stub 实现由平台集成层（bridge）覆盖，注入真实的 SkillRuntime 引用。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../../tools/tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { EXECUTE_SKILL_TOOL_NAME } from "./tool-names.js";

const ExecuteSkillParams = Type.Object({
  id: Type.String({
    description:
      "Skill ID to execute (e.g. 'sherpa-onnx-tts'). Must match the skill's directory name.",
  }),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Parameters to pass to the skill. See the skill's SKILL.md for accepted parameters.",
    }),
  ),
});

type ExecuteSkillInput = Static<typeof ExecuteSkillParams>;

/**
 * execute_skill 工具配置
 *
 * 实际执行逻辑需要 ClientSkillRuntime 引用，
 * 由平台集成层（bridge.registerToolOverrides）提供真实 execute 实现。
 */
export const executeSkillToolConfig: MtBotToolConfig<typeof ExecuteSkillParams> = {
  name: EXECUTE_SKILL_TOOL_NAME,
  label: "Execute Skill",
  description:
    "Execute a locally installed skill that has a runnable entry point (run.ts / run.py). " +
    "Only use this for skills explicitly marked as executable in the system prompt. " +
    "Pass parameters as a JSON object — see the skill's SKILL.md for accepted fields.",
  parameters: ExecuteSkillParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,

  async execute(_toolCallId: string, params: ExecuteSkillInput): Promise<AgentToolResult<unknown>> {
    // stub — 实际执行由平台集成层覆盖
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message:
              `execute_skill is a stub. Platform integration layer should override this. ` +
              `Requested skill: ${params.id}`,
          }),
        },
      ],
      details: undefined,
    };
  },
};
