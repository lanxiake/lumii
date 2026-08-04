/**
 * File Edit Tool — 字符串替换编辑文件
 *
 * 支持 3 级模糊匹配策略,解决弱模型 old_string 缩进/空白对不齐的高频失败:
 * 1. 精确匹配(exact)
 * 2. 行首尾空白宽容(line_trimmed)
 * 3. 行内空白归一(whitespace_normalized)
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { resolveAgentFilePath } from "../resolve-file-path.js";

/** 模糊匹配策略结果 */
interface FuzzyMatchResult {
  /** 是否找到匹配 */
  found: boolean;
  /** 匹配使用的策略名 */
  strategy?: string;
  /** 替换后的完整内容 */
  replaced?: string;
  /** 匹配次数(用于唯一性检查) */
  count?: number;
}

/**
 * 3 级模糊匹配与替换
 *
 * 按代价从低到高依次尝试策略,命中即停止。
 * replaceAll=true 时替换所有匹配,false 时只替换第一个(且要求唯一)。
 */
function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): FuzzyMatchResult {
  // 策略 1: 精确匹配
  if (content.includes(oldString)) {
    const count = content.split(oldString).length - 1;
    if (!replaceAll && count > 1) {
      return { found: true, count, strategy: "exact" };
    }
    const replaced = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);
    return { found: true, strategy: "exact", replaced, count };
  }

  // 策略 2: 行首尾空白宽容(每行 trim 后比对)
  const lineTrimmed = tryLineTrimmedMatch(content, oldString, newString, replaceAll);
  if (lineTrimmed.found) return lineTrimmed;

  // 策略 3: 行内空白归一(连续空白/tab 折叠为单空格)
  const whitespaceNormalized = tryWhitespaceNormalizedMatch(
    content,
    oldString,
    newString,
    replaceAll,
  );
  if (whitespaceNormalized.found) return whitespaceNormalized;

  return { found: false };
}

/**
 * 策略 2: 行首尾空白宽容
 *
 * old/new/content 三者都按行 trim,比对时忽略首尾空白。
 * 匹配后用原 content 的缩进重建替换段。
 */
function tryLineTrimmedMatch(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): FuzzyMatchResult {
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const oldTrimmed = oldLines.map((l) => l.trim());
  const matches: Array<{ startIdx: number; endIdx: number; indent: string }> = [];

  // 滑动窗口查找
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const windowTrimmed = contentLines.slice(i, i + oldLines.length).map((l) => l.trim());
    if (windowTrimmed.every((line, j) => line === oldTrimmed[j])) {
      // 提取首行缩进(用于重建 newString)
      const firstLine = contentLines[i]!;
      const indent = firstLine.slice(0, firstLine.length - firstLine.trimStart().length);
      matches.push({ startIdx: i, endIdx: i + oldLines.length - 1, indent });
      if (!replaceAll) break;
    }
  }

  if (matches.length === 0) {
    return { found: false };
  }

  if (!replaceAll && matches.length > 1) {
    return { found: true, count: matches.length, strategy: "line_trimmed" };
  }

  // 执行替换(倒序,避免索引偏移)
  const result = [...contentLines];
  for (let i = matches.length - 1; i >= 0; i--) {
    const { startIdx, indent } = matches[i]!;
    const indentedNew = newLines.map((line, j) => (j === 0 ? indent + line.trim() : indent + line.trim()));
    result.splice(startIdx, oldLines.length, ...indentedNew);
  }

  return {
    found: true,
    strategy: "line_trimmed",
    replaced: result.join("\n"),
    count: matches.length,
  };
}

/**
 * 策略 3: 行内空白归一
 *
 * 将连续空白/tab 折叠为单空格后比对。
 * 匹配后用原 content 的缩进重建。
 */
function tryWhitespaceNormalizedMatch(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): FuzzyMatchResult {
  const normalizeWs = (s: string): string => s.replace(/[ \t]+/g, " ");

  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const oldNormalized = oldLines.map((l) => normalizeWs(l.trim()));
  const matches: Array<{ startIdx: number; endIdx: number; indent: string }> = [];

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const windowNormalized = contentLines
      .slice(i, i + oldLines.length)
      .map((l) => normalizeWs(l.trim()));
    if (windowNormalized.every((line, j) => line === oldNormalized[j])) {
      const firstLine = contentLines[i]!;
      const indent = firstLine.slice(0, firstLine.length - firstLine.trimStart().length);
      matches.push({ startIdx: i, endIdx: i + oldLines.length - 1, indent });
      if (!replaceAll) break;
    }
  }

  if (matches.length === 0) {
    return { found: false };
  }

  if (!replaceAll && matches.length > 1) {
    return { found: true, count: matches.length, strategy: "whitespace_normalized" };
  }

  const result = [...contentLines];
  for (let i = matches.length - 1; i >= 0; i--) {
    const { startIdx, indent } = matches[i]!;
    const indentedNew = newLines.map((line, j) =>
      j === 0 ? indent + normalizeWs(line.trim()) : indent + normalizeWs(line.trim()),
    );
    result.splice(startIdx, oldLines.length, ...indentedNew);
  }

  return {
    found: true,
    strategy: "whitespace_normalized",
    replaced: result.join("\n"),
    count: matches.length,
  };
}

const FileEditInput = Type.Object({
  filePath: Type.String({
    description:
      "Path to the file to edit. Relative paths (e.g. outputs/foo.md) resolve against workspace root.",
  }),
  oldString: Type.String({ description: "The exact string to find and replace" }),
  newString: Type.String({ description: "The replacement string" }),
  replaceAll: Type.Optional(
    Type.Boolean({ description: "Replace all occurrences (default: false)", default: false }),
  ),
});

export const fileEditToolConfig: MtBotToolConfig<typeof FileEditInput> = {
  name: "file_edit",
  label: "Edit File",
  description:
    "Perform exact string replacement in a file. The old_string must be unique unless replace_all is true. " +
    "Supports fuzzy whitespace/indentation matching if exact match fails.",
  parameters: FileEditInput,
  category: "filesystem",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context) => {
    const filePath = resolveAgentFilePath(params.filePath, context.getCwd());
    const content = await context.readFile(filePath);
    const { oldString, newString, replaceAll = false } = params;

    const result = fuzzyFindAndReplace(content, oldString, newString, replaceAll);

    if (!result.found) {
      return {
        content: [
          {
            type: "text",
            text:
              `Error: old_string not found in ${filePath} (tried exact, line_trimmed, whitespace_normalized).\n` +
              `Make sure the string appears verbatim (including line breaks). Re-read the file and verify the exact content before retrying.`,
          },
        ],
        details: { success: false, filePath },
      };
    }

    // 唯一性检查：未设 replaceAll 但找到多处匹配
    if (!replaceAll && result.count !== undefined && result.count > 1) {
      return {
        content: [
          {
            type: "text",
            text:
              `Error: old_string is not unique in ${filePath} ` +
              `(found ${result.count} occurrences via ${result.strategy ?? "unknown"} match). ` +
              `Use replaceAll: true or provide more surrounding context to make it unique.`,
          },
        ],
        details: { success: false, filePath },
      };
    }

    await context.writeFile(filePath, result.replaced!);

    // 写后回读验证
    let verified = false;
    try {
      const written = await context.readFile(filePath);
      verified = written === result.replaced;
    } catch {
      // 回读失败不阻断流程,但不标记 verified
    }

    const strategyNote = result.strategy !== "exact" ? ` (matched via ${result.strategy})` : "";
    return {
      content: [
        {
          type: "text",
          text: verified
            ? `File edited: ${filePath}${strategyNote}`
            : `File edited: ${filePath}${strategyNote} (post-write verification failed — please re-read the file to confirm)`,
        },
      ],
      details: { success: true, filePath, strategy: result.strategy, verified },
    };
  },
};
