import { describe, it, expect, beforeEach } from "vitest";
import { createVerificationGateHook } from "../hooks/verification-gate-hook.js";
import { _clearVerificationRegistry } from "../verification-tracker.js";
import type { ToolHookContext, ToolHookResultContext } from "../../tools/tool-hooks.js";

const hook = createVerificationGateHook();
const INST = "gate-inst";

function beforeCtx(toolName: string, params: Record<string, unknown> = {}): ToolHookContext {
  return {
    toolCallId: "tc",
    toolName,
    category: "agent",
    isReadOnly: true,
    needsPermission: false,
    params: Object.freeze(params),
    context: { instanceId: INST } as never,
    startTime: Date.now(),
    meta: {},
  };
}

function afterCtx(
  toolName: string,
  params: Record<string, unknown>,
  resultText: string,
  isError = false,
): ToolHookResultContext {
  return {
    ...beforeCtx(toolName, params),
    result: { content: [{ type: "text", text: resultText }], details: undefined },
    isError,
    durationMs: 1,
  };
}

beforeEach(() => {
  _clearVerificationRegistry();
});

describe("verification-gate hook", () => {
  it("未验证 → 首次 task_complete 软提醒，第二次放行", async () => {
    const first = await hook.beforeExecute!(beforeCtx("task_complete", { summary: "done" }));
    expect(first).toBeDefined();
    expect(JSON.stringify(first)).toContain("未检测到验证步骤");

    const second = await hook.beforeExecute!(beforeCtx("task_complete", { summary: "done" }));
    expect(second).toBeUndefined(); // 放行
  });

  it("曾跑 test 命令 → task_complete 首次即放行", async () => {
    await hook.afterExecute!(afterCtx("bash", { command: "pnpm test" }, "all pass"));
    const out = await hook.beforeExecute!(beforeCtx("task_complete", { summary: "done" }));
    expect(out).toBeUndefined();
  });

  it("曾 spawn builtin:verify → task_complete 首次即放行", async () => {
    await hook.afterExecute!(
      afterCtx("spawn_agent", { agentType: "builtin:verify" }, "[VERIFY RESULT: PASS] ..."),
    );
    const out = await hook.beforeExecute!(beforeCtx("task_complete", { summary: "done" }));
    expect(out).toBeUndefined();
  });

  it("非验证类 bash 命令 → 不视为验证", async () => {
    await hook.afterExecute!(afterCtx("bash", { command: "ls -la" }, "files"));
    const out = await hook.beforeExecute!(beforeCtx("task_complete", { summary: "done" }));
    expect(out).toBeDefined(); // 仍触发软提醒
  });

  it("其他工具不受 beforeExecute 影响", async () => {
    const out = await hook.beforeExecute!(beforeCtx("file_read", { filePath: "/a" }));
    expect(out).toBeUndefined();
  });
});
