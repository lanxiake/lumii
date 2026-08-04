/**
 * Tool Result Persist Hook — 大工具结果落盘（主题3 P1-1）
 *
 * 在 afterExecute 阶段检查工具结果文本长度，超阈值时落盘并将上下文文本替换为预览 + 路径。
 *
 * 放行策略：
 * - 错误结果不落盘（错误信息通常较短且需完整可见）
 * - 仅处理文本内容（TextContent），图片等非文本内容原样保留
 */

import type { ToolHook } from "../tool-hooks.js";
import {
  persistLargeResult,
  DEFAULT_PERSIST_THRESHOLD,
  DEFAULT_PREVIEW_LENGTH,
} from "../tool-result-storage.js";

export interface ToolResultPersistHookOptions {
  /** 落盘根目录（默认 <cwd>/.mtbot/tool-results） */
  baseDir?: string;
  /** 超过此字符数才落盘（默认 50_000） */
  threshold?: number;
  /** 预览保留字符数（默认 2_000） */
  previewLength?: number;
}

export function createToolResultPersistHook(
  options: ToolResultPersistHookOptions = {},
): ToolHook {
  const threshold = options.threshold ?? DEFAULT_PERSIST_THRESHOLD;
  const previewLength = options.previewLength ?? DEFAULT_PREVIEW_LENGTH;

  return {
    name: "tool-result-persist",
    critical: false,

    afterExecute(ctx) {
      // 错误结果不落盘
      if (ctx.isError) {
        return;
      }

      const result = ctx.result;
      const content = result.content;
      if (!Array.isArray(content) || content.length === 0) {
        return;
      }

      // 仅处理首个文本块（绝大多数工具结果为单一文本块）
      const firstText = content.find(
        (c): c is { type: "text"; text: string } =>
          (c as { type?: string }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      );
      if (!firstText || firstText.text.length <= threshold) {
        return;
      }

      const outcome = persistLargeResult(firstText.text, {
        toolName: ctx.toolName,
        baseDir: options.baseDir,
        threshold,
        previewLength,
      });

      if (!outcome.persisted && outcome.text === firstText.text) {
        return; // 未发生改写
      }

      // 替换文本块内容（保留其余非文本块）
      const newContent = content.map((c) =>
        c === firstText ? { ...firstText, text: outcome.text } : c,
      );

      return {
        ...result,
        content: newContent,
      };
    },
  };
}
