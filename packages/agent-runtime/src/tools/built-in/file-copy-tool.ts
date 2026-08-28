/**
 * File Copy Tool — 复制文件或目录
 *
 * MCP filesystem 没有 copy；补齐整理资料时「复制后再改」的需求。
 * 目标已存在则失败，与 file_move 一致，避免静默覆盖。
 */

import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import type { MtBotToolConfig } from "../tool-adapter.js";
import {
  destinationExistsMessage,
  ensureParentDir,
  pathExists,
  resolveFsPath,
} from "./file-fs-ops.js";

const FileCopyInput = Type.Object({
  source: Type.String({
    description: "Existing file or directory to copy. Relative paths resolve against workspace root.",
  }),
  destination: Type.String({
    description:
      "New path (including filename). Must not already exist. Relative paths resolve against workspace root.",
  }),
});

export const fileCopyToolConfig: MtBotToolConfig<typeof FileCopyInput> = {
  name: "file_copy",
  label: "Copy File",
  description:
    "Copy files and directories within the workspace. Directories are copied recursively. " +
    "If the destination exists, the operation will fail. Both source and destination " +
    "must be within the workspace. Prefer this over `bash` cp/Copy-Item.",
  parameters: FileCopyInput,
  category: "filesystem",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context) => {
    const cwd = context.getCwd();
    const source = resolveFsPath(params.source, cwd);
    const destination = resolveFsPath(params.destination, cwd);

    if (await pathExists(destination)) {
      return {
        content: [{ type: "text", text: destinationExistsMessage(destination) }],
        details: { success: false, source, destination },
      };
    }

    await ensureParentDir(destination);
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });

    return {
      content: [
        {
          type: "text",
          text: `Successfully copied ${source} to ${destination}`,
        },
      ],
      details: { success: true, source, destination },
    };
  },
};
