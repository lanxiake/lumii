/**
 * Verification Nudge（主题5 P0-2）
 *
 * 任务清单收尾时若无验证步骤则提醒，抑制"完成不验证就报完成"的劣化。
 * 对照 claude-code-rev TodoWriteTool：3+ 任务全 done 且无 verify 步骤 → 追加提醒。
 *
 * 纯函数，供平台层（bridge-tool-registrar 真实实现）与源码层（task-tools stub）共用，
 * 保证两处行为一致。
 */

export const VERIFICATION_NUDGE_TEXT =
  "⚠️ 所有任务已完成，但清单中没有验证步骤。在报告完成前，请通过运行命令 / spawn verify 子 Agent 独立验证你的改动，确认无误后再向用户报告完成。";

/** 验证步骤关键词（中英）：命中则视为清单包含验证 */
const VERIFICATION_KEYWORD = /verif|验证|test|测试|检验|校验/i;

/** 任务清单收尾项（最小字段子集） */
export interface NudgeTaskLike {
  readonly subject?: string;
  readonly description?: string | null;
  readonly status?: string;
}

/**
 * 判断是否应追加 verification-nudge。
 *
 * 触发条件（全部满足）：
 * 1. 任务数 >= 3（短清单不打扰）
 * 2. 全部 done
 * 3. 清单中没有任何验证步骤（subject/description 不含验证关键词）
 */
export function shouldNudgeVerification(tasks: readonly NudgeTaskLike[]): boolean {
  if (tasks.length < 3) {
    return false;
  }
  const allDone = tasks.every((t) => t.status === "done");
  if (!allDone) {
    return false;
  }
  const hasVerificationStep = tasks.some((t) =>
    VERIFICATION_KEYWORD.test(`${t.subject ?? ""} ${t.description ?? ""}`),
  );
  return !hasVerificationStep;
}
