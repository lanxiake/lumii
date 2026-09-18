/**
 * File Move Tool — 移动或重命名文件/目录
 *
 * 对齐 MCP move_file：目标已存在则失败，避免静默覆盖。
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

const FileMoveInput = Type.Object({
  source: Type.String({
    description: "Existing file or directory to move. Relative paths resolve against workspace root.",
  }),
  destination: Type.String({
    description:
      "New path (including filename). Must not already exist. Relative paths resolve against workspace root.",
  }),
});

export const fileMoveToolConfig: MtBotToolConfig<typeof FileMoveInput> = {
  name: "file_move",
  label: "Move File",
  description:
    "Move or rename files and directories. Can move files between directories " +
    "and rename them in a single operation. If the destination exists, the " +
    "operation will fail. Works across different directories and can be used " +
    "for simple renaming within the same directory. Both source and destination " +
    "must be within the workspace or a project directory registered in Settings → Development. " +
    "Prefer this over `bash` mv/Move-Item.",
  parameters: FileMoveInput,
  category: "filesystem",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context) => {
    const source = resolveFsPath(params.source, context);
    const destination = resolveFsPath(params.destination, context);

    if (await pathExists(destination)) {
      return {
        content: [{ type: "text", text: destinationExistsMessage(destination) }],
        details: { success: false, source, destination },
        isError: true,
      };
    }

    await ensureParentDir(destination);
    await fs.rename(source, destination);

    return {
      content: [
        {
          type: "text",
          text: `Successfully moved ${source} to ${destination}`,
        },
      ],
      details: { success: true, source, destination },
    };
  },
};
