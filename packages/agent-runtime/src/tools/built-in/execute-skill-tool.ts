/**
 * execute_skill — 执行本地可执行技能（executable skill）
 *
 * ## 为什么这个文件此前不存在（2026-09-18 批次 3）
 *
 * 这个名字**早就在系统里了**：`tool-names.ts` 有常量、`tooling-section.ts` 有摘要与分组、
 * `skills-section.ts` 有两处"MUST be invoked via `execute_skill` tool"、
 * `skill-tools.ts` 的 hint 说"ALWAYS call execute_skill with skillnet"，
 * 连渲染层的 `tool-labels.ts` 都备好了中文名——**唯独没有注册**。
 *
 * 宿主的执行入口也一直是通的：`ToolExecutionContext.executeSkill` 由
 * `bridge.ts:1013` 注入，`main/index.ts:815` 有完整实现（调 `skillRuntime.executeSkill`，
 * 带超时与错误处理），注释还写着"由 execute_skill 工具调用"。
 *
 * 所以它是**已实现未接线**：能力在，工具不在。两个守卫都没抓到它——
 * `tool-name-references.test.ts` 只扫 `built-in/` 目录，而引用它的
 * `skills-section.ts` / `skill-tools.ts` 的描述文本不在那个扫描域里；
 * `tooling-section.test.ts` 则把它列进 `PRE_REGISTERED_NAMES`（"已定义常量但尚未注册"），
 * **等于把问题合法化了**。
 *
 * ## 危害为什么没爆
 *
 * `skills-section.ts` 那段只在**存在 executable 技能时**输出，本机没有——
 * 所以模型看不到。但 `skill_search` 零结果时的 hint 是无条件输出的
 * （2026-09-14 日志里出现过一次"ALWAYS call execute_skill with skillnet"），
 * 模型没上钩是运气，不是设计。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { MtBotToolResult } from "../../types/tool.js";
import { EXECUTE_SKILL_TOOL_NAME } from "./tool-names.js";

const ExecuteSkillInput = Type.Object({
  id: Type.String({
    description:
      "Skill id (its directory name) — the `[executable]` entries listed in the system prompt. " +
      "Not the display name; ids are lowercase with dashes (e.g. issue-manager).",
  }),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Arguments passed to the skill's entry point (run.ts / run.py). " +
        "Shape depends on the skill — read its SKILL.md via skill_invoke first if unsure.",
    }),
  ),
});

/**
 * 工具配置的 execute 显式标注返回类型——这样 `MtBotToolResult` 的契约
 * 才会被 TS 检查（批次 1 实测：不标注时多余属性检查不生效）。
 */
export const executeSkillToolConfig: MtBotToolConfig<typeof ExecuteSkillInput> = {
  name: EXECUTE_SKILL_TOOL_NAME,
  label: "Execute Skill",
  description:
    "Run an executable skill's entry point. Only for skills marked `[executable]` in the system prompt — " +
    "ordinary skills are documentation and go through `skill_invoke` instead. " +
    "Pass an id from that `[executable]` list: other ids (even ones visible in the skills list, e.g. `skillnet`) " +
    "are not executable and will fail here. " +
    "The skill runs locally, so it needs user confirmation.",
  parameters: ExecuteSkillInput,
  category: "agent",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context): Promise<MtBotToolResult<unknown>> => {
    if (!context.executeSkill) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "execute_skill 需要宿主注入 SkillRuntime（context.executeSkill 未提供）",
              skillId: params.id,
            }),
          },
        ],
        details: undefined,
        isError: true,
      };
    }

    try {
      const r = await context.executeSkill(params.id, params.params ?? {});
      if (!r.success) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: r.error ?? "技能执行失败",
                skillId: params.id,
                hint: "用 skill_search 确认 id 是否正确；若是首次执行，可先用 skill_invoke 读它的 SKILL.md。",
              }),
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              skillId: params.id,
              result: r.result,
              executionTimeMs: r.executionTimeMs,
            }),
          },
        ],
        details: { skillId: params.id, executionTimeMs: r.executionTimeMs },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message, skillId: params.id }),
          },
        ],
        details: undefined,
        isError: true,
      };
    }
  },
};
