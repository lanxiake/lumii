/**
 * Grep Tool — 内容正则搜索（渐进式加载）
 *
 * 默认最多返回 50 条结果，避免大型代码库搜索撑爆上下文。
 * 超出时提示缩小搜索范围或使用 glob 过滤。
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";

/** 单次搜索的默认结果上限 */
const DEFAULT_MAX_RESULTS = 50;
/** 硬上限（防止 Agent 传入超大值） */
const MAX_RESULTS_HARD_LIMIT = 100;

const GrepInput = Type.Object({
  pattern: Type.String({ description: "Regular expression pattern to search for" }),
  path: Type.Optional(
    Type.String({ description: "File or directory to search in (defaults to cwd)" }),
  ),
  glob: Type.Optional(
    Type.String({
      description: 'Glob pattern to filter files (e.g., "*.ts"). Use to narrow search scope.',
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: `Maximum number of results to return. Default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_HARD_LIMIT}. Use glob to narrow scope if too many results.`,
    }),
  ),
});

export const grepToolConfig: MtBotToolConfig<typeof GrepInput> = {
  name: "grep",
  label: "Grep",
  description: `Search file contents using a regular expression. Returns up to ${DEFAULT_MAX_RESULTS} matching lines by default. Use glob to narrow scope for large codebases.`,
  parameters: GrepInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const effectiveMax = Math.min(params.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_HARD_LIMIT);
    // 多取一条用于判断是否还有更多结果
    const results = await context.grep(params.pattern, {
      path: params.path ?? context.getCwd(),
      glob: params.glob,
      maxResults: effectiveMax + 1,
    });
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No matches found" }],
        details: { count: 0 },
      };
    }
    const hasMore = results.length > effectiveMax;
    const displayed = results.slice(0, effectiveMax);
    let output = displayed.map((r) => `${r.file}:${r.line}: ${r.content}`).join("\n");
    if (hasMore) {
      output += `\n\n[截断：仅显示前 ${effectiveMax} 条结果，还有更多匹配。请使用 glob 参数缩小搜索范围（如 glob="src/specific/**/*.ts"）或使用更精确的 pattern。]`;
    }
    return {
      content: [{ type: "text", text: output }],
      details: { count: displayed.length, hasMore },
    };
  },
};
