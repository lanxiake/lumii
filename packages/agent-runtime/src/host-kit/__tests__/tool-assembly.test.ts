import { describe, it, expect, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { MtBotTool, ToolExecutionContext } from "../../types/tool.js";
import type { AgentDefinition } from "../../types/agent-definition.js";
import { createFeatureFlags } from "../../config/feature-flags.js";
import { PermissionMemory } from "../../security/permission-memory.js";
import type { ToolHook } from "../../tools/tool-hooks.js";
import type { PermissionProvider } from "../types.js";
import { assembleTools, filterToolsByDefinition } from "../tool-assembly.js";

function fakeTool(name: string, overrides: Partial<MtBotTool> = {}): MtBotTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    category: "filesystem",
    isReadOnly: true,
    needsPermission: false,
    isEnabled: () => true,
    execute: async () => ({ content: [{ type: "text", text: `${name}-ok` }] }),
    ...overrides,
  } as MtBotTool;
}

const TOOL_CTX = {} as ToolExecutionContext;

function defWith(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "test-agent",
    name: "Test",
    description: "",
    systemPrompt: "",
    ...overrides,
  } as AgentDefinition;
}

const allowAllPermission: PermissionProvider = {
  requestPermission: async () => "allow-once",
};

function gateDeps(permission: PermissionProvider, def: AgentDefinition) {
  return {
    definition: def,
    instanceId: "inst-1",
    runContext: { runId: "run-1", sessionKey: "s-1", rootSessionKey: "r-1" },
    permissionMemory: new PermissionMemory(),
    permission,
  };
}

describe("filterToolsByDefinition", () => {
  it("canSpawnSubAgents=false 移除 spawn_agent/send_message", () => {
    const tools = [fakeTool("bash"), fakeTool("spawn_agent"), fakeTool("send_message")];
    const out = filterToolsByDefinition(tools, defWith({ canSpawnSubAgents: false }));
    expect(out.map((t) => t.name)).toEqual(["bash"]);
  });

  it("tools 白名单生效（含 * 时不过滤）", () => {
    const tools = [fakeTool("a"), fakeTool("b"), fakeTool("c")];
    expect(filterToolsByDefinition(tools, defWith({ tools: ["a", "c"] })).map((t) => t.name)).toEqual(["a", "c"]);
    expect(filterToolsByDefinition(tools, defWith({ tools: ["*"] })).length).toBe(3);
  });

  it("disallowedTools 黑名单生效", () => {
    const tools = [fakeTool("a"), fakeTool("b")];
    expect(filterToolsByDefinition(tools, defWith({ disallowedTools: ["b"] })).map((t) => t.name)).toEqual(["a"]);
  });

  it("readOnly 模式过滤写工具", () => {
    const tools = [fakeTool("file_read"), fakeTool("file_write")];
    expect(filterToolsByDefinition(tools, defWith({ permissionMode: "readOnly" })).map((t) => t.name)).toEqual(["file_read"]);
  });
});

describe("assembleTools", () => {
  const flags = createFeatureFlags();

  it("产出已包裹工具，数量=过滤后数量", () => {
    const tools = [fakeTool("a"), fakeTool("b")];
    const out = assembleTools({
      tools,
      definition: defWith(),
      toolContext: TOOL_CTX,
      featureFlags: flags,
      permissionGate: gateDeps(allowAllPermission, defWith()),
    });
    expect(out.enabledCount).toBe(2);
    expect(out.tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("optionalHooks 按顺序插入到 logging 之后、cache 之前", () => {
    const seen: string[] = [];
    const probe: ToolHook = {
      name: "probe",
      beforeExecute: (ctx) => {
        seen.push(`probe:${ctx.toolName}`);
      },
    };
    const out = assembleTools({
      tools: [fakeTool("a")],
      definition: defWith(),
      toolContext: TOOL_CTX,
      featureFlags: flags,
      permissionGate: gateDeps(allowAllPermission, defWith()),
      optionalHooks: [probe],
    });
    // runner 内部 hooks 顺序：probe 必然在已注册的 hooks 列表里
    const names = (out.runner as unknown as { globalHooks: ToolHook[] }).globalHooks.map((h) => h.name);
    expect(names[0]).toBe("permission-gate");
    expect(names).toContain("probe");
    expect(names[names.length - 1]).toBe("cache");
    // probe 在 logging 之后
    expect(names.indexOf("probe")).toBeGreaterThan(names.indexOf("logging"));
    // probe 在 cache 之前
    expect(names.indexOf("probe")).toBeLessThan(names.indexOf("cache"));
  });

  it("needsPermission 工具在 default 模式触发 PermissionProvider 询问", async () => {
    const requestPermission = vi.fn(async () => "allow-once" as const);
    const permission: PermissionProvider = { requestPermission };
    const writeTool = fakeTool("file_write", { isReadOnly: false, needsPermission: true });
    const def = defWith();
    const out = assembleTools({
      tools: [writeTool],
      definition: def,
      toolContext: TOOL_CTX,
      featureFlags: flags,
      permissionGate: gateDeps(permission, def),
    });
    await out.tools[0].execute("call-1", {}, undefined, undefined);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("用户 deny 时工具结果以 throw 暴露失败", async () => {
    const permission: PermissionProvider = { requestPermission: async () => "deny" };
    const writeTool = fakeTool("file_write", { isReadOnly: false, needsPermission: true });
    const def = defWith();
    const out = assembleTools({
      tools: [writeTool],
      definition: def,
      toolContext: TOOL_CTX,
      featureFlags: flags,
      permissionGate: gateDeps(permission, def),
    });
    await expect(out.tools[0].execute("call-1", {}, undefined, undefined)).rejects.toThrow();
  });
});
