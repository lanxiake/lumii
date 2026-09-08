/**
 * File Write Tool — 写入文件内容
 *
 * 支持三种写入模式：
 * - 默认（不传 mode/startLine/endLine）：整文件覆盖写入
 * - mode='append'：追加到文件末尾
 * - mode='range' 或传入 startLine/endLine：按 1-based 行号范围替换原文件中的对应行
 *
 * 所有写入后都做回读验证,确保写入成功(防 Windows 文件锁/杀软静默失败)。
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { resolveAgentFilePath } from "../resolve-file-path.js";

/**
 * 大文件分段写入的字符阈值与块大小。
 *
 * 背景：模型一次性输出过大的 content（写长文档）会被 max_tokens 截断，tool call 的
 * arguments 变成半截 JSON，上游裸 JSON.parse 抛错整轮失败。即使提高 maxTokens 兜底，
 * 再大的上限也架不住无限长文档。因此超过阈值时把内容按块切分写入，让「单段写满后
 * 继续追加」成为模型可感知的稳定路径，从源头避免单次 arguments 超长。
 */
const SEGMENT_THRESHOLD = 32_000;
const SEGMENT_CHUNK = 24_000;

const FileWriteInput = Type.Object({
  filePath: Type.String({
    description:
      "Path to the file to write. Relative paths (e.g. outputs/foo.md) resolve against workspace root.",
  }),
  content: Type.String({ description: "Content to write to the file" }),
  /** 写入模式：overwrite(默认) / append / range(按行号片段) */
  mode: Type.Optional(
    Type.Union([Type.Literal("overwrite"), Type.Literal("append"), Type.Literal("range")], {
      description: "Write mode: 'overwrite' (default), 'append', or 'range'",
    }),
  ),
  /** range 模式起始行号（1-based，含） */
  startLine: Type.Optional(
    Type.Number({ description: "Start line number (1-based, inclusive) for range mode" }),
  ),
  /** range 模式结束行号（1-based，含）；省略则等价于从 startLine 开始替换到末尾 */
  endLine: Type.Optional(
    Type.Number({ description: "End line number (1-based, inclusive) for range mode" }),
  ),
});

/** 按行号范围替换原文件中的指定行，返回新的整体内容 */
function replaceLinesByRange(
  original: string,
  newContent: string,
  startLine: number,
  endLine?: number,
): string {
  const originalLines = original.length === 0 ? [] : original.split("\n");
  const start0 = Math.max(0, startLine - 1);
  const end0 =
    endLine === undefined ? originalLines.length : Math.min(originalLines.length, endLine);

  // 新内容按行拆分；去掉末尾可能多余的空行，避免替换后多出一空行
  const newLines = newContent.split("\n");
  const head = originalLines.slice(0, start0);
  const tail = originalLines.slice(end0);
  return [...head, ...newLines, ...tail].join("\n");
}

/**
 * 写后验证：回读文件内容,比对是否与期望一致。
 * 成功返回 true,失败/异常返回 false(不抛出,由调用方决定如何提示)。
 */
async function verifyWrite(
  filePath: string,
  expected: string,
  readFile: (path: string) => Promise<string>,
): Promise<boolean> {
  try {
    const actual = await readFile(filePath);
    return actual === expected;
  } catch {
    return false;
  }
}

/** 把字符串按块边界切分；边界优先落在换行符上，避免切断多字节字符。 */
function chunkByBoundary(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * 分段写入：内容超阈值时逐块落盘（首块覆盖、后续块追加），返回最终全文与是否分段。
 * 分段写入同样做回读验证；若回读失败，调用方会以失败提示兜底。
 */
async function writeInSegments(
  filePath: string,
  content: string,
  writeFile: (path: string, data: string) => Promise<void>,
  readFile: (path: string) => Promise<string>,
): Promise<{ segmented: boolean; verified: boolean }> {
  const chunks = chunkByBoundary(content, SEGMENT_CHUNK);
  if (chunks.length <= 1) {
    await writeFile(filePath, content);
    return { segmented: false, verified: await verifyWrite(filePath, content, readFile) };
  }
  await writeFile(filePath, chunks[0]!);
  for (let i = 1; i < chunks.length; i++) {
    const existing = await readFile(filePath);
    await writeFile(filePath, existing + chunks[i]!);
  }
  return { segmented: true, verified: await verifyWrite(filePath, content, readFile) };
}

export const fileWriteToolConfig: MtBotToolConfig<typeof FileWriteInput> = {
  name: "file_write",
  label: "Write File",
  description:
    "Create a new file or completely overwrite an existing file with new content. " +
    "Use with caution as it will overwrite existing files without warning. " +
    "Missing parent directories are created automatically. " +
    "Supports overwrite (default), append (mode='append'), or line-range replace " +
    "(mode='range' with startLine/endLine, 1-based inclusive). " +
    "Only works within the workspace. Prefer this over `bash` echo/redirection.",
  parameters: FileWriteInput,
  category: "filesystem",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context) => {
    const filePath = resolveAgentFilePath(params.filePath, context.getCwd());
    const { content, mode, startLine, endLine } = params;
    const effectiveMode = mode ?? (startLine !== undefined ? "range" : "overwrite");

    if (effectiveMode === "append") {
      let existing = "";
      try {
        existing = await context.readFile(filePath);
      } catch {
        // 文件不存在 → 当作空内容
      }
      const joined =
        existing.length > 0 && !existing.endsWith("\n")
          ? existing + "\n" + content
          : existing + content;
      await context.writeFile(filePath, joined);

      const verified = await verifyWrite(filePath, joined, context.readFile);

      return {
        content: [
          {
            type: "text",
            text: verified
              ? `File appended: ${filePath}\n[文件路径: ${filePath}，如需读取请使用此完整路径]`
              : `File appended: ${filePath} (post-write verification failed — please re-read to confirm)\n[文件路径: ${filePath}]`,
          },
        ],
        details: { filePath, mode: "append", verified },
      };
    }

    if (effectiveMode === "range") {
      if (startLine === undefined || startLine < 1) {
        return {
          content: [
            {
              type: "text",
              text: `Error: mode='range' requires startLine >= 1`,
            },
          ],
          details: { success: false, filePath },
        };
      }
      let existing = "";
      try {
        existing = await context.readFile(filePath);
      } catch {
        // 不存在 → 从空内容开始
      }
      const updated = replaceLinesByRange(existing, content, startLine, endLine);
      await context.writeFile(filePath, updated);

      const verified = await verifyWrite(filePath, updated, context.readFile);

      return {
        content: [
          {
            type: "text",
            text: verified
              ? `File range written: ${filePath} (lines ${startLine}${endLine !== undefined ? `-${endLine}` : "+"})\n[文件路径: ${filePath}，如需读取请使用此完整路径]`
              : `File range written: ${filePath} (lines ${startLine}${endLine !== undefined ? `-${endLine}` : "+"}) (post-write verification failed — please re-read to confirm)\n[文件路径: ${filePath}]`,
          },
        ],
        details: {
          filePath,
          mode: "range",
          startLine,
          endLine,
          verified,
        },
      };
    }

    // 默认：整文件覆盖写入（超长内容分段落盘，避免单次 arguments 超限被截断）
    const { segmented, verified } = await writeInSegments(
      filePath,
      content,
      context.writeFile,
      context.readFile,
    );

    return {
      content: [
        {
          type: "text",
          text: verified
            ? `File written: ${filePath}${segmented ? ` (large content written in ${Math.ceil(content.length / SEGMENT_CHUNK)} segments)` : ""}\n[文件路径: ${filePath}，如需读取请使用此完整路径]`
            : `File written: ${filePath} (post-write verification failed — please re-read to confirm)\n[文件路径: ${filePath}]`,
        },
      ],
      details: { filePath, mode: "overwrite", verified, segmented },
    };
  },
};
