import { describe, it, expect, vi } from "vitest";
import { ToolRunner } from "../../tools/tool-runner.js";
import { CapabilityRegistry } from "../capability-registry.js";
import type { CapabilityDescriptor } from "../types.js";
import type { MtBotTool } from "../../types/tool.js";
import { Type } from "@sinclair/typebox";

function makeDescriptor(id: string, overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id,
    source: "tool",
    name: id,
    description: "test",
    permissions: ["read"],
    ...overrides,
  };
}

function makeTool(name: string): MtBotTool {
  return {
    name,
    label: name,
    description: "test",
    parameters: Type.Object({}),
    category: "filesystem",
    isReadOnly: true,
    needsPermission: false,
    isEnabled: () => true,
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  };
}

const stubContext = () => ({
  executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
  glob: async () => [],
  grep: async () => [],
  fetch: async () => ({ status: 200, body: "" }),
  getCwd: () => "/",
});

describe("ToolRunner + CapabilityRegistry 权限过滤", () => {
  it("local_ui 可执行所有工具（含高风险）", async () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([
      makeDescriptor("safe_tool"),
      makeDescriptor("shell_tool", { permissions: ["shell"], isHighRisk: true }),
    ]);

    const runner = new ToolRunner(undefined, reg, "local_ui");
    const tool = makeTool("shell_tool");
    const result = await runner.run(tool, stubContext(), "tc1", {});

    // local_ui 不受限，工具正常执行
    expect((result.content[0] as { text: string }).text).toBe("ok");
    // meta 中注入了 origin 和 capabilityDescriptor
    // (verifying via execute being called once)
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("meta 中含 origin 和 capabilityDescriptor", async () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor("read_file", { permissions: ["read"] }));

    let capturedMeta: Record<string, unknown> = {};
    const runner = new ToolRunner(undefined, reg, "cloud_channel");
    runner.addHook({
      name: "meta-capture",
      beforeExecute: (ctx) => {
        capturedMeta = { ...ctx.meta };
        return undefined;
      },
    });

    const tool = makeTool("read_file");
    await runner.run(tool, stubContext(), "tc1", {});

    expect(capturedMeta.origin).toBe("cloud_channel");
    expect((capturedMeta.capabilityDescriptor as CapabilityDescriptor)?.id).toBe("read_file");
  });

  it("未注册工具时 capabilityDescriptor 为 undefined", async () => {
    const reg = new CapabilityRegistry(); // empty
    let capturedDescriptor: unknown = "not-set";
    const runner = new ToolRunner(undefined, reg, "local_ui");
    runner.addHook({
      name: "desc-capture",
      beforeExecute: (ctx) => {
        capturedDescriptor = ctx.meta.capabilityDescriptor;
        return undefined;
      },
    });

    const tool = makeTool("unknown_tool");
    await runner.run(tool, stubContext(), "tc1", {});
    expect(capturedDescriptor).toBeUndefined();
  });
});
