import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { ToolRunner } from "../tools/tool-runner.js";
import { wrapMtBotToolsWithRunner } from "../tools/tool-registry.js";
import { createMtBotTool } from "../tools/tool-adapter.js";
import type { BackgroundToolRunInput } from "../tools/background-tool.js";
import type { ToolExecutionContext } from "../types/tool.js";

/** 最小 ToolExecutionContext stub */
function stubContext(): ToolExecutionContext {
  return {
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    writeFile: async () => {},
    glob: async () => [],
    grep: async () => [],
    fetch: async () => ({ status: 200, body: "" }),
    getCwd: () => "/",
  };
}

describe("ToolRunner", () => {
  it("短路 beforeExecute 时跳过真实 execute 与 lifecycle", async () => {
    const ctx = stubContext();
    const Params = Type.Object({ q: Type.String() });
    const inner = createMtBotTool(
      {
        name: "t_short",
        label: "t",
        description: "d",
        parameters: Params,
        category: "web",
        isReadOnly: true,
        needsPermission: false,
        execute: async () => ({
          content: [{ type: "text", text: "inner" }],
        }),
      },
      ctx,
    );

    const runner = new ToolRunner();
    runner.addHook({
      name: "sc",
      beforeExecute: () => ({
        content: [{ type: "text", text: "cached" }],
      }),
    });

    let beforeActual = 0;
    let afterActual = 0;
    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx, {
      beforeActualToolExecute: () => {
        beforeActual++;
      },
      afterActualToolExecute: () => {
        afterActual++;
      },
    });

    const out = await wrapped[0]!.execute("id-1", { q: "x" });
    expect(out.content?.[0]).toMatchObject({ text: "cached" });
    expect(beforeActual).toBe(0);
    expect(afterActual).toBe(0);
  });

  it("afterExecute 可链式改写 result", async () => {
    const ctx = stubContext();
    const Params = Type.Object({});
    const inner = createMtBotTool(
      {
        name: "t_chain",
        label: "t",
        description: "d",
        parameters: Params,
        category: "web",
        isReadOnly: true,
        needsPermission: false,
        execute: async () => ({
          content: [{ type: "text", text: "a" }],
        }),
      },
      ctx,
    );

    const runner = new ToolRunner();
    runner.addHook({
      name: "m1",
      afterExecute: (c) => ({
        ...c.result,
        content: [{ type: "text", text: "b" }],
      }),
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx);
    const out = await wrapped[0]!.execute("id-2", {});
    expect(out.content?.[0]).toMatchObject({ text: "b" });
  });

  it("onError 可返回降级结果", async () => {
    const ctx = stubContext();
    const Params = Type.Object({});
    const inner = createMtBotTool(
      {
        name: "t_err",
        label: "t",
        description: "d",
        parameters: Params,
        category: "web",
        isReadOnly: true,
        needsPermission: false,
        execute: async () => {
          throw new Error("boom");
        },
      },
      ctx,
    );

    const runner = new ToolRunner();
    runner.addHook({
      name: "fb",
      onError: () => ({
        content: [{ type: "text", text: "fallback" }],
      }),
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx);
    const out = await wrapped[0]!.execute("id-3", {});
    expect(out.content?.[0]).toMatchObject({ text: "fallback" });
  });

  it("critical hook 抛出时向上传递", async () => {
    const ctx = stubContext();
    const Params = Type.Object({});
    const inner = createMtBotTool(
      {
        name: "t_crit",
        label: "t",
        description: "d",
        parameters: Params,
        category: "web",
        isReadOnly: true,
        needsPermission: false,
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
      ctx,
    );

    const runner = new ToolRunner();
    runner.addHook({
      name: "bad",
      critical: true,
      beforeExecute: () => {
        throw new Error("perm");
      },
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx);
    await expect(wrapped[0]!.execute("id-4", {})).rejects.toThrow("perm");
  });

  it("非 critical hook 异常不阻断执行", async () => {
    const ctx = stubContext();
    const Params = Type.Object({});
    const inner = createMtBotTool(
      {
        name: "t_soft",
        label: "t",
        description: "d",
        parameters: Params,
        category: "web",
        isReadOnly: true,
        needsPermission: false,
        execute: async () => ({
          content: [{ type: "text", text: "done" }],
        }),
      },
      ctx,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = new ToolRunner();
    runner.addHook({
      name: "soft",
      beforeExecute: () => {
        throw new Error("ignored");
      },
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx);
    const out = await wrapped[0]!.execute("id-5", {});
    expect(out.content?.[0]).toMatchObject({ text: "done" });
    warn.mockRestore();
  });
});

describe("ToolRunner 后台化", () => {
  it("命中策略时不等待真实执行，返回占位结果；真实 execute 交给 runner", async () => {
    const ctx = stubContext();
    const Params = Type.Object({ q: Type.String() });
    let executeCalled = 0;
    const inner = createMtBotTool(
      {
        name: "mcp__comfyui-remote__enqueue_workflow",
        label: "ComfyUI: enqueue_workflow",
        description: "d",
        parameters: Params,
        category: "channel",
        isReadOnly: false,
        needsPermission: false,
        execute: () => {
          executeCalled++;
          return new Promise(() => {}); // 永不 resolve，证明确实没被等待
        },
      },
      ctx,
    );

    const runInputs: BackgroundToolRunInput[] = [];
    const runner = new ToolRunner();
    runner.setBackground({
      policy: { shouldBackground: (name) => name.includes("enqueue_workflow") },
      runner: {
        run: (input) => {
          runInputs.push(input);
          return "task-1";
        },
      },
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, { ...ctx, instanceId: "inst-9" });
    const out = await wrapped[0]!.execute("id-1", { q: "x" });

    expect(out.details).toMatchObject({ background: true, taskId: "task-1" });
    expect((out.content?.[0] as { text: string }).text).toContain("后台");
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]!.instanceId).toBe("inst-9");
    expect(executeCalled).toBe(0); // runner 未调用真实 execute
  });

  it("策略未命中走同步执行", async () => {
    const ctx = stubContext();
    const inner = createMtBotTool(
      {
        name: "file_read",
        label: "read",
        description: "d",
        parameters: Type.Object({}),
        category: "filesystem",
        isReadOnly: true,
        needsPermission: false,
        execute: async () => ({ content: [{ type: "text", text: "inner" }] }),
      },
      ctx,
    );

    let policyCalls = 0;
    const runner = new ToolRunner();
    runner.setBackground({
      policy: {
        shouldBackground: () => {
          policyCalls++;
          return false;
        },
      },
      runner: { run: () => "never" },
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx);
    const out = await wrapped[0]!.execute("id-2", {});
    expect((out.content?.[0] as { text: string }).text).toBe("inner");
    expect(policyCalls).toBe(1);
  });

  it("后台登记抛错时退化为同步执行（工具调用不消失）", async () => {
    const ctx = stubContext();
    const inner = createMtBotTool(
      {
        name: "mcp__comfyui-remote__enqueue_workflow",
        label: "ComfyUI: enqueue_workflow",
        description: "d",
        parameters: Type.Object({}),
        category: "channel",
        isReadOnly: false,
        needsPermission: false,
        execute: async () => ({ content: [{ type: "text", text: "inner" }] }),
      },
      ctx,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runner = new ToolRunner();
    runner.setBackground({
      policy: { shouldBackground: () => true },
      runner: {
        run: () => {
          throw new Error("登记失败");
        },
      },
    });

    const wrapped = wrapMtBotToolsWithRunner([inner], runner, ctx);
    const out = await wrapped[0]!.execute("id-3", {});
    expect((out.content?.[0] as { text: string }).text).toBe("inner");
    warn.mockRestore();
  });
});
