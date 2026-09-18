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
    "  - List a directory -> use `list_dir` (NOT `ls`/`dir`)\n" +
    "  - Read files -> use `file_read` tool (NOT `cat/head/tail`)\n" +
    "  - Edit files -> use `file_edit` tool (NOT `sed/awk`)\n" +
    "  - Write files -> use `file_write` tool (NOT `echo >`/`cat <<EOF`)\n" +
    "  - Create directories -> use `file_mkdir` (NOT `mkdir`)\n" +
    "  - Move/rename -> use `file_move` (NOT `mv`/`Move-Item`)\n" +
    "  - Copy files -> use `file_copy` (NOT `cp`/`Copy-Item`)\n" +
    "  - Lumii Wiki/memory/settings batch ops -> `bash` + `lumii-ui` (`lumii-ui help --json`); Wiki read stays on `wiki_*` tools\n" +
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
      // 非零退出即失败（2026-09-18 批次 1 定案）。
      // 依据：近 5 天 321 次调用里非零占 26.5%，而「非零属正常语义」的命令
      // （grep 未匹配 / diff 有差异 / test 判假）在 bash_command_log 全量 1559 条里仅 22 条（1.4%）。
      // 回退方案：若上线后错误率 > 40%（说明有未预料的语义性场景），
      // 收窄为 `result.exitCode === 127 || result.exitCode === 255`（命令未找到 / 中断）。
      isError: result.exitCode !== 0,
    };
  },
};
