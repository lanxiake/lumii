/**
 * Bash Tool — Shell 命令执行
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";

const BashInput = Type.Object({
  command: Type.String({ description: "The shell command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the command" })),
  timeoutMs: Type.Optional(
    Type.Number({ description: "Timeout in milliseconds (max 600000)", default: 120000 }),
  ),
});

export const bashToolConfig: MtBotToolConfig<typeof BashInput> = {
  name: "bash",
  label: "Bash",
  description:
    "Execute a shell command on the local system. Use for git, npm, build tools, and other terminal operations. " +
    "The default timeout is 120s. For long-running operations such as image/video generation, builds, or downloads, " +
    "pass an explicit `timeoutMs` (e.g. 180000) so the command is not killed prematurely. " +
    "Commands can be interrupted by the user at any time." +
    "\n\nIMPORTANT tool usage rules:\n" +
    "- NEVER use bash for operations that have dedicated tools:\n" +
    "  - File search -> use `glob` tool (NOT `find`)\n" +
    "  - Content search -> use `grep` tool (NOT `grep` command)\n" +
    "  - Read files -> use `file_read` tool (NOT `cat/head/tail`)\n" +
    "  - Edit files -> use `file_edit` tool (NOT `sed/awk`)\n" +
    "  - Write files -> use `file_write` tool (NOT `echo >`/`cat <<EOF`)\n" +
    "- Failure handling: if the same type of operation fails 2 times, switch to a fundamentally different approach " +
    "(e.g. bash -> write a script file), NOT just syntax variations (cp -> copy -> Copy-Item).\n" +
    "- Batch operations: for multiple similar operations (e.g. copy 10 files), merge into a single script execution, " +
    "NOT serial tool calls per file.\n" +
    "\nWindows platform notes:\n" +
    "- Commands run through Git Bash, so Unix syntax (cp, mv, rm, grep, find) works. Still prefer the dedicated tools above.\n" +
    "- Use absolute paths and quote any path containing spaces or non-ASCII characters.\n" +
    "- For non-trivial file operations (copy/move/rename of many files, or paths with tricky characters), " +
    "prefer writing a temporary Node.js script (file_write + `node script.js`) over inline shell commands.",
  parameters: BashInput,
  category: "shell",
  isReadOnly: false,
  needsPermission: true,
  execute: async (_toolCallId, params, context, signal) => {
    const { command, cwd, timeoutMs } = params;
    const result = await context.executeCommand(command, {
      cwd: cwd ?? context.getCwd(),
      timeoutMs: timeoutMs ?? 120000,
      signal,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text: output || "(no output)" }],
      details: { exitCode: result.exitCode },
    };
  },
};
