/**
 * VERDICT 解析器（主题5 P0-1）
 *
 * 解析 builtin:verify 子 Agent 输出末尾的 `VERDICT: PASS|FAIL|PARTIAL` 行，
 * 让主 Agent 能机器消费验证结论（FAIL/PARTIAL 时回头修复后重验），
 * 而非把对抗式验证沦为"提示词建议"。
 *
 * 对照 claude-code-rev：verificationAgent 要求以 VERDICT 收尾，caller 解析决定后续行为。
 */

export type Verdict = "PASS" | "FAIL" | "PARTIAL" | "UNKNOWN";

export interface ParsedVerdict {
  verdict: Verdict;
  /** 命中的原始 VERDICT 行（便于日志/调试） */
  raw: string;
}

/**
 * 从子 Agent 输出中解析 VERDICT。
 *
 * - 正则宽松：大小写不敏感、容忍前后空白
 * - 取最后一处匹配（验证 agent 可能在分析中多次提及，结论以末尾为准）
 * - 无匹配 → UNKNOWN（不阻断，仅提示）
 */
export function parseVerdict(output: string): ParsedVerdict {
  if (!output || typeof output !== "string") {
    return { verdict: "UNKNOWN", raw: "" };
  }

  // 全局匹配 VERDICT: PASS|FAIL|PARTIAL，取最后一处
  const re = /VERDICT:\s*(PASS|FAIL|PARTIAL)\b/gi;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(output)) !== null) {
    last = match;
  }

  if (!last) {
    return { verdict: "UNKNOWN", raw: "" };
  }

  const verdict = last[1]!.toUpperCase() as Verdict;
  return { verdict, raw: last[0] };
}

/**
 * 生成机器可读的前置摘要行，确保主 Agent 必然看到验证结论。
 * FAIL/PARTIAL 时附带行动引导。
 */
export function formatVerdictBanner(verdict: Verdict): string {
  switch (verdict) {
    case "PASS":
      return "[VERIFY RESULT: PASS] 验证通过。";
    case "FAIL":
      return (
        "[VERIFY RESULT: FAIL] 验证失败。请阅读下方验证报告，定位并修复问题后，重新运行验证，" +
        "不要在未通过验证的情况下向用户报告完成。"
      );
    case "PARTIAL":
      return (
        "[VERIFY RESULT: PARTIAL] 验证部分通过。请阅读下方验证报告，处理仍未满足的项后再次验证。"
      );
    default:
      return "[VERIFY RESULT: UNKNOWN] 未能从验证输出中解析出明确结论（缺少 VERDICT 行）。请审阅下方内容并自行判断是否需要补充验证。";
  }
}
