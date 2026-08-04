/**
 * Glob Tool — 文件模式匹配查找
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";

const GlobInput = Type.Object({
  pattern: Type.String({
    description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.tsx")',
  }),
  path: Type.Optional(Type.String({ description: "Directory to search in (defaults to cwd)" })),
});

export const globToolConfig: MtBotToolConfig<typeof GlobInput> = {
  name: "glob",
  label: "Glob",
  description: "Find files matching a glob pattern. Returns matching file paths.",
  parameters: GlobInput,
  category: "filesystem",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const files = await context.glob(params.pattern, {
      cwd: params.path ?? context.getCwd(),
    });
    const output = files.length > 0 ? files.join("\n") : "No files found";
    return {
      content: [{ type: "text", text: output }],
      details: { count: files.length },
    };
  },
};
