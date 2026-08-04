/**
 * Verification Gate Hook（主题5 P0-3）
 *
 * 软门禁：task_complete 调用前，若本会话未观测到任何验证行为
 * （spawn builtin:verify 或运行 test/build/lint 命令），则首次返回软提醒（非硬阻断），
 * 第二次调用放行——避免误伤无需验证的简单任务。
 *
 * 设计：无 filter，对所有工具生效。
 * - afterExecute：观测 spawn_agent(verify) / bash(test/build) → 标记已验证
 * - beforeExecute：仅对 task_complete 做软门禁判定
 *
 * 整体由 ENABLE_TASK_COMPLETE_GATE 包裹（hook 未注册即无门禁），保持 task_complete 工具本身纯净。
 */

import type { ToolHook, HookAgentToolResult } from "../../tools/tool-hooks.js";
import {
  markVerified,
  isVerified,
  recordCompleteAttempt,
  resetCompleteAttempts,
} from "../verification-tracker.js";

/** 判定 bash 命令是否属于"验证类"（跑测试/构建/类型检查/lint） */
const VERIFY_COMMAND_RE =
  /\b(test|vitest|jest|pytest|build|tsc|typecheck|lint|eslint|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i;

/** 从工具结果中提取纯文本（用于检测 VERIFY RESULT 横幅） */
function extractResultText(result: HookAgentToolResult): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "object" && b !== null && (b as { type?: string }).type === "text") {
        return String((b as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("\n");
}

export function createVerificationGateHook(): ToolHook {
  return {
    name: "verification-gate",
    critical: false,

    afterExecute(ctx) {
      if (ctx.isError) return;
      const instanceId = ctx.context.instanceId ?? "default";

      if (ctx.toolName === "spawn_agent") {
        const agentType = ctx.params.agentType as string | undefined;
        const text = extractResultText(ctx.result);
        if (agentType === "builtin:verify" || text.includes("[VERIFY RESULT:")) {
          markVerified(instanceId);
        }
      } else if (ctx.toolName === "bash") {
        const command = String(ctx.params.command ?? "");
        if (VERIFY_COMMAND_RE.test(command)) {
          markVerified(instanceId);
        }
      }
    },

    beforeExecute(ctx) {
      if (ctx.toolName !== "task_complete") return;
      const instanceId = ctx.context.instanceId ?? "default";

      // 已验证 → 直接放行
      if (isVerified(instanceId)) {
        return;
      }

      const attempts = recordCompleteAttempt(instanceId);
      if (attempts >= 2) {
        // 第二次调用 → 放行（软门禁不硬拦），重置计数
        resetCompleteAttempts(instanceId);
        return;
      }

      // 首次未验证调用 → 软提醒短路（非 error），引导验证后再次调用
      return {
        content: [
          {
            type: "text" as const,
            text:
              "提示：本次未检测到验证步骤（未运行 test/build/lint，也未 spawn verify 子 Agent）。" +
              "非平凡改动应在报告完成前独立验证。若确认无需验证，请再次调用 task_complete 即可放行。",
          },
        ],
        details: { gate: "task_complete_verification", attempt: attempts },
      };
    },
  };
}
