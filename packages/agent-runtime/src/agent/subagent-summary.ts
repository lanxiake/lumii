/**
 * 子 Agent 摘要护栏：超长截断、落盘、保留末尾 VERDICT 行
 */

import path from "node:path";
import { persistLargeResult } from "../tools/tool-result-storage.js";
import { SUBAGENT_DEFAULTS } from "./subagent-broker.js";

export interface GuardSubagentSummaryOptions {
  /** 摘要最大字符数（默认 SUBAGENT_DEFAULTS.maxSummaryChars） */
  maxChars?: number;
  /** 落盘工具名（默认 subagent_summary） */
  toolName?: string;
  /** 工作目录；用于 .mtbot/tool-results 落盘根 */
  cwd?: string;
}

export interface GuardSubagentSummaryResult {
  readonly summary: string;
  readonly spillPath?: string;
}

/**
 * 提取文本中最后一行 VERDICT（若有）
 */
export function extractLastVerdictLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (/^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i.test(line)) {
      return line;
    }
  }
  return undefined;
}

/**
 * 截断子 Agent 输出；超长则 persistLargeResult；保留末尾 VERDICT 行（若有）。
 */
export function guardSubagentSummary(
  text: string,
  opts: GuardSubagentSummaryOptions = {},
): GuardSubagentSummaryResult {
  const maxChars = opts.maxChars ?? SUBAGENT_DEFAULTS.maxSummaryChars;
  if (text.length <= maxChars) {
    return { summary: text };
  }

  const toolName = opts.toolName ?? "subagent_summary";
  const baseDir = opts.cwd
    ? path.join(opts.cwd, ".mtbot", "tool-results")
    : undefined;

  const persisted = persistLargeResult(text, {
    toolName,
    baseDir,
    threshold: maxChars,
    previewLength: Math.min(2_000, maxChars),
  });

  const verdict = extractLastVerdictLine(text);
  let summary: string;
  if (verdict) {
    const budget = Math.max(0, maxChars - verdict.length - 1);
    summary = `${text.slice(0, budget)}\n${verdict}`;
  } else {
    summary = text.slice(0, maxChars);
  }

  if (persisted.persisted && persisted.filePath) {
    const hint = `\n\n[Full output saved to: ${persisted.filePath}]`;
    if (summary.length + hint.length <= maxChars + hint.length) {
      summary = summary + hint;
    }
  }

  console.log(
    `[SubagentSummary] guarded len=${text.length}→${summary.length} spill=${persisted.filePath ?? "-"} verdict=${verdict ? "yes" : "no"}`,
  );

  return { summary, spillPath: persisted.filePath };
}
