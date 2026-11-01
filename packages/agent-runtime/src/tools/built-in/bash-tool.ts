/**
 * Bash Tool — Shell 命令执行
 *
 * 超时前 {@link BASH_RENEWAL_LEAD_MS} 若宿主注入了 `callLLM`，
 * 嵌套询问 **Agent** 是否续期（execute 期间主循环无法再调工具）。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { AgentToolUpdateCallback } from "../../types/tool.js";
import {
  BASH_RENEWAL_LEAD_MS,
  buildBashRenewalAgentPrompt,
  extendMsFromAgentRenewalReply,
} from "./bash-renewal.js";

const DEFAULT_TIMEOUT_MS = 120_000;

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
    "About 60s before timeout the runtime may ask the agent (nested LLM) whether to renew the deadline; " +
    "if the agent declines, the command times out as scheduled; if it renews, pass extendMs. " +
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
  execute: async (_toolCallId, params, context, signal, onUpdate) => {
    const { command, cwd, timeoutMs } = params;
    const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const result = await context.executeCommand(command, {
      cwd: cwd ?? context.getCwd(),
      timeoutMs: effectiveTimeout,
      signal,
      renewalLeadMs: BASH_RENEWAL_LEAD_MS,
      onApproachingTimeout: context.callLLM
        ? async (info) => {
            notifyRenewalPrompt(onUpdate, info.remainingMs);
            const prompt = buildBashRenewalAgentPrompt(info);
            // 决策必须在硬超时前返回；留余量给杀进程
            const llmBudgetMs = Math.max(5_000, Math.min(45_000, info.remainingMs - 3_000));
            try {
              const reply = await Promise.race([
                context.callLLM!(prompt, {
                  purpose: "bash_renewal",
                  instanceId: context.instanceId,
                }),
                new Promise<string>((resolve) => {
                  setTimeout(() => resolve('{"renew":false}'), llmBudgetMs);
                }),
              ]);
              const extendMs = extendMsFromAgentRenewalReply(reply);
              notifyRenewalResult(onUpdate, extendMs);
              return { extendMs };
            } catch {
              notifyRenewalResult(onUpdate, 0);
              return { extendMs: 0 };
            }
          }
        : undefined,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      content: [{ type: "text", text: output || "(no output)" }],
      details: { exitCode: result.exitCode },
      // 非零退出即失败（2026-09-18 批次 1 定案）。
      isError: result.exitCode !== 0,
    };
  },
};

/** tool_progress：正在询问 Agent 是否续期 */
function notifyRenewalPrompt(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  remainingMs: number,
): void {
  onUpdate?.({
    content: [
      {
        type: "text",
        text: `命令即将超时（约 ${Math.round(remainingMs / 1000)}s），正在询问 Agent 是否续期…`,
      },
    ],
    details: { phase: "renewal_prompt", remainingMs },
  });
}

/** tool_progress：Agent 续期结论 */
function notifyRenewalResult(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
  extendMs: number,
): void {
  onUpdate?.({
    content: [
      {
        type: "text",
        text:
          extendMs > 0
            ? `Agent 决定续期 ${Math.round(extendMs / 1000)}s，继续等待命令。`
            : "Agent 决定不续期，将按原超时终止命令。",
      },
    ],
    details: { phase: "renewal_result", extendMs },
  });
}
