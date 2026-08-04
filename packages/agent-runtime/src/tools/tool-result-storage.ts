/**
 * Tool Result Storage — 大工具结果落盘（主题3 P1-1）
 *
 * 工具返回的文本结果超过阈值（默认 50K 字符）时，将完整内容写入磁盘，
 * 仅在上下文中保留前若干字符的预览 + 落盘路径，避免单次工具结果撑爆上下文窗口。
 *
 * 落盘位置：<cwd>/.mtbot/tool-results/<tool>-<ts>-<hash>.txt
 *
 * 对照 claude-code-rev：超长工具输出落盘 + 返回引用路径的策略。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** 默认落盘阈值：50K 字符 */
export const DEFAULT_PERSIST_THRESHOLD = 50_000;
/** 默认预览长度：保留前 2K 字符 */
export const DEFAULT_PREVIEW_LENGTH = 2_000;

export interface PersistLargeResultOptions {
  /** 工具名（用于生成文件名） */
  toolName: string;
  /** 落盘根目录（默认 <cwd>/.mtbot/tool-results） */
  baseDir?: string;
  /** 超过此字符数才落盘（默认 50_000） */
  threshold?: number;
  /** 预览保留字符数（默认 2_000） */
  previewLength?: number;
}

export interface PersistLargeResultOutcome {
  /** 是否发生了落盘 */
  persisted: boolean;
  /** 落盘后用于上下文的文本（预览 + 路径提示）；未落盘时为原文 */
  text: string;
  /** 落盘文件绝对路径（未落盘时 undefined） */
  filePath?: string;
}

/**
 * 若文本超过阈值则落盘并返回预览，否则原样返回。
 *
 * @param text - 工具结果文本
 * @param options - 落盘配置
 */
export function persistLargeResult(
  text: string,
  options: PersistLargeResultOptions,
): PersistLargeResultOutcome {
  const threshold = options.threshold ?? DEFAULT_PERSIST_THRESHOLD;
  const previewLength = options.previewLength ?? DEFAULT_PREVIEW_LENGTH;

  if (text.length <= threshold) {
    return { persisted: false, text };
  }

  const baseDir = options.baseDir ?? path.join(process.cwd(), ".mtbot", "tool-results");
  const ts = Date.now();
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 8);
  const safeTool = options.toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${safeTool}-${ts}-${hash}.txt`;
  const filePath = path.join(baseDir, fileName);

  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(filePath, text, "utf8");
  } catch (err) {
    // 落盘失败 → 降级：截断返回（不阻断工具流程）
    const truncated = text.slice(0, threshold);
    return {
      persisted: false,
      text:
        truncated +
        `\n\n[输出过长（${text.length} 字符）且落盘失败：${(err as Error).message}。已截断至 ${threshold} 字符。]`,
    };
  }

  const preview = text.slice(0, previewLength);
  return {
    persisted: true,
    filePath,
    text:
      preview +
      `\n\n[输出过长（共 ${text.length} 字符），已落盘到：${filePath}\n` +
      `以上为前 ${previewLength} 字符预览。需查看完整内容请用 file_read 读取该路径。]`,
  };
}
