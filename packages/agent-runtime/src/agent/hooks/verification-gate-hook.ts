/**
 * Verification Gate Hook（主题5 P0-3）
 *
 * 软门禁：task_complete 调用前，若本会话未观测到任何验证行为
 * （spawn builtin:verify 或运行 test/build/lint 命令），则**首次**返回软提醒（非硬阻断），
 * 之后一律放行——避免误伤无需验证的简单任务。
 *
 * 为什么第 2 次之后不再劝验证（2026-10-09）：劝是**有代价**的。原实现在放行时把计数
 * 归零，于是每凑够两次调用就重新弹一遍"未运行 test/build/lint、也未 spawn verify 子 Agent"，
 * 而这句话在指挥模型干活——实测一次微信代聊（对方只发了一句天气询问）被它劝出
 * **21 次 bash 翻日志 + 1 次 spawn_agent 起了个「核验发送是否落地」的子 Agent**，
 * 28 次 task_complete、4.5 分钟没收敛。所以改成：提醒只发一次；若同一个会话还在反复
 * 收尾（计数继续涨），说明它缺的是**收尾**而不是验证，这时候改口催它停手。
 *
 * 设计：无 filter，对所有工具生效。
 * - afterExecute：观测 spawn_agent(verify) / bash(test/build) → 标记已验证；task_complete
 *   反复调用 → 在真实结果上追加收尾提醒
 * - beforeExecute：仅对 task_complete 做软门禁判定
 *
 * 整体由 ENABLE_TASK_COMPLETE_GATE 包裹（hook 未注册即无门禁），保持 task_complete 工具本身纯净。
 */

import type { ToolHook, HookAgentToolResult } from "../../tools/tool-hooks.js";
import { markVerified, isVerified, recordCompleteAttempt } from "../verification-tracker.js";

/**
 * 同一会话第几次 task_complete 时催一句收尾——**只在这一次数到，不重复**。
 *
 * 3 = 已经放过行还在调（第 1 次提醒、第 2 次放行、第 3 次就是"提醒之后依然没收住"）。
 * 只发一次的理由：它是**信号**不是约束——收不住尾的会话，再喊几遍也一样（实测那轮喊了
 * 14 遍）；而长会话里每次收尾都挂一句，就变成新的噪音了。
 */
const COMPLETE_OVERRUN_NUDGE_AT = 3

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

      if (ctx.toolName === "task_complete") {
        // 第 1 次是软提醒（被短路，走不到这里）；到这里说明**放行了**。
        // 计数涨到第 3 次 → 这个会话提醒过、也放过行了，却还在调 task_complete，
        // 在真实结果上追加一句催收尾（只此一次）。
        const n = ctx.meta.completeAttempts;
        if (n === COMPLETE_OVERRUN_NUDGE_AT) {
          return {
            ...ctx.result,
            content: [
              ...(ctx.result.content ?? []),
              {
                type: "text" as const,
                text:
                  `提示：本会话已第 ${n} 次调用 task_complete。事情确已完成就直接给出结论、` +
                  "停止调用工具收尾；还有没做完的，做完再报。",
              },
            ],
          };
        }
        return;
      }

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

      // 计数只增不减（见 verification-tracker）：第 1 次提醒，之后一律放行。
      // 归零的话每两次调用就重弹一遍验证提醒，正是 2026-10-09 那轮空转的来源。
      const attempts = recordCompleteAttempt(instanceId);
      ctx.meta.completeAttempts = attempts; // 给 afterExecute 判断是否该催收尾
      if (attempts >= 2) {
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
