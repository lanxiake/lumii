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
  /** 传 beforeExecute 用过的那个 ctx —— 真实链路上 before/after 共享同一个 `meta` */
  base?: ToolHookContext,
): ToolHookResultContext {
  return {
    ...(base ?? beforeCtx(toolName, params)),
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

  // 2026-10-09：原来的实现在放行时归零，于是每两次调用就重弹一遍验证提醒；
  // 实测把一次微信代聊劝出 21 次 bash + 1 个子 Agent。现在提醒只发一次，
  // 还在反复收尾就改口催收尾。
  it("反复收尾：提醒只发一次，第 3 次起在真实结果上追加收尾提醒", async () => {
    const call = async (summary: string) => {
      const b = beforeCtx("task_complete", { summary });
      const blocked = await hook.beforeExecute!(b);
      if (blocked) return { blocked, after: undefined };
      return {
        blocked,
        after: await hook.afterExecute!(
          afterCtx("task_complete", { summary }, '{"status":"completed"}', false, b),
        ),
      };
    };
    const textOf = (r: { content?: unknown }) =>
      ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");

    const first = await call("a");
    expect(first.blocked).toBeDefined();
    expect(JSON.stringify(first.blocked)).toContain("未检测到验证步骤");

    const second = await call("b");
    expect(second.blocked).toBeUndefined(); // 放行
    expect(second.after).toBeUndefined(); // 且不催

    const third = await call("c");
    expect(third.blocked).toBeUndefined(); // 依旧放行，不再劝验证
    expect(textOf(third.after!)).toContain("第 3 次调用 task_complete");
    expect(textOf(third.after!)).toContain('{"status":"completed"}'); // 原结果没被顶掉

    // 催收尾只发一次：第 4 次起既不劝验证、也不再挂提醒（长会话里那会变成噪音）
    const fourth = await call("d");
    expect(fourth.blocked).toBeUndefined();
    expect(fourth.after).toBeUndefined();
  });
});
