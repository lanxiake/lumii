/**
 * File Mkdir Tool — 创建目录（幂等）
 *
 * 对齐 MCP create_directory：递归创建嵌套目录，已存在则静默成功。
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { resolveFsPath } from "./file-fs-ops.js";

const FileMkdirInput = Type.Object({
  path: Type.String({
    description:
      "Directory path to create. Relative paths resolve against workspace root. Parent directories are created as needed.",
  }),
});

export const fileMkdirToolConfig: MtBotToolConfig<typeof FileMkdirInput> = {
  name: "file_mkdir",
  label: "Create Directory",
  description:
    "Create a new directory or ensure a directory exists. Can create multiple " +
    "nested directories in one operation. If the directory already exists, " +
    "this operation will succeed silently. Perfect for setting up directory " +
    "structures for projects or ensuring required paths exist. " +
    "Writing a file with `file_write` already creates missing parent directories — " +
    "use this tool when you need an empty directory without writing a file. " +
    "Only works within the workspace.",
  parameters: FileMkdirInput,
  category: "filesystem",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context) => {
    const dirPath = resolveFsPath(params.path, context.getCwd());
    await fs.mkdir(dirPath, { recursive: true });
    return {
      content: [
        {
          type: "text",
          text: `Successfully created directory ${dirPath}`,
        },
      ],
      details: { path: dirPath },
    };
  },
};
