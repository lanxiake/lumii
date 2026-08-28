/**
 * List Dir Tool — 列出工作空间内某一层目录
 *
 * 对齐 MCP list_directory：用 [FILE]/[DIR] 前缀区分条目。
 * 只列一层，递归查找请用 glob。
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { LIST_DIR_MAX_ENTRIES, resolveFsPath } from "./file-fs-ops.js";

const ListDirInput = Type.Object({
  path: Type.String({
    description:
      "Directory path to list. Relative paths resolve against workspace root. Use '.' for the workspace root.",
  }),
});

export const listDirToolConfig: MtBotToolConfig<typeof ListDirInput> = {
  name: "list_dir",
  label: "List Directory",
  description:
    "Get a detailed listing of all files and directories in a specified path. " +
    "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
    "prefixes. This tool is essential for understanding directory structure and " +
    "finding specific files within a directory. It lists a single level only — use `glob` " +
    "for recursive filename search. Only works within the workspace.",
  parameters: ListDirInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const dirPath = resolveFsPath(params.path, context.getCwd());
    let stat;
    try {
      stat = await fs.stat(dirPath);
    } catch {
      return {
        content: [{ type: "text", text: `Error: path does not exist: ${dirPath}` }],
        details: { success: false, path: dirPath },
      };
    }
    if (!stat.isDirectory()) {
      return {
        content: [
          {
            type: "text",
            text: `Error: path is not a directory: ${dirPath}. Use file_read for files, or list_dir on a folder.`,
          },
        ],
        details: { success: false, path: dirPath },
      };
    }
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const truncated = sorted.length > LIST_DIR_MAX_ENTRIES;
    const visible = truncated ? sorted.slice(0, LIST_DIR_MAX_ENTRIES) : sorted;
    const lines = visible.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);
    let text = lines.length > 0 ? lines.join("\n") : "(empty directory)";
    if (truncated) {
      text += `\n\n[truncated: showing ${LIST_DIR_MAX_ENTRIES} of ${sorted.length} entries. Use glob to search, or list a more specific subdirectory.]`;
    }
    return {
      content: [{ type: "text", text }],
      details: { path: dirPath, count: sorted.length, truncated },
    };
  },
};
