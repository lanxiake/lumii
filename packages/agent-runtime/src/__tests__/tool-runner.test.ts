import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { ToolRunner } from "../tools/tool-runner.js";
import { wrapMtBotToolsWithRunner } from "../tools/tool-registry.js";
import { createMtBotTool } from "../tools/tool-adapter.js";
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
