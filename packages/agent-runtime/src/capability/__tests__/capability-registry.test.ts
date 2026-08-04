import { describe, it, expect } from "vitest";
import { CapabilityRegistry } from "../capability-registry.js";
import type { CapabilityDescriptor } from "../types.js";

// ---- helpers ----

function makeDescriptor(overrides: Partial<CapabilityDescriptor> & Pick<CapabilityDescriptor, "id">): CapabilityDescriptor {
  return {
    source: "tool",
    name: overrides.id,
    description: "test",
    permissions: ["read"],
    ...overrides,
  };
}

describe("CapabilityRegistry", () => {
  it("register / get / size / unregister", () => {
    const reg = new CapabilityRegistry();
    const d = makeDescriptor({ id: "read_file" });
    reg.register(d);
    expect(reg.size).toBe(1);
    expect(reg.get("read_file")).toStrictEqual(d);
    expect(reg.unregister("read_file")).toBe(true);
    expect(reg.size).toBe(0);
  });

  it("registerAll 批量注册", () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([
      makeDescriptor({ id: "a" }),
      makeDescriptor({ id: "b" }),
    ]);
    expect(reg.size).toBe(2);
  });

  it("重复 id 覆盖", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor({ id: "tool", description: "v1" }));
    reg.register(makeDescriptor({ id: "tool", description: "v2" }));
    expect(reg.size).toBe(1);
    expect(reg.get("tool")?.description).toBe("v2");
  });

  it("getBySource 按来源过滤", () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([
      makeDescriptor({ id: "t1", source: "tool" }),
      makeDescriptor({ id: "s1", source: "skill" }),
      makeDescriptor({ id: "m1", source: "mcp" }),
    ]);
    expect(reg.getBySource("tool").map((c) => c.id)).toEqual(["t1"]);
    expect(reg.getBySource("skill").map((c) => c.id)).toEqual(["s1"]);
  });

  // ---- origin 过滤 ----

  it("local_ui 可访问所有能力", () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([
      makeDescriptor({ id: "read", permissions: ["read"] }),
      makeDescriptor({ id: "shell_cmd", permissions: ["shell"], isHighRisk: true }),
      makeDescriptor({ id: "admin_op", permissions: ["admin"], isHighRisk: true }),
    ]);
    expect(reg.getForOrigin("local_ui")).toHaveLength(3);
  });

  it("cloud_channel 不能访问 isHighRisk=true 的能力", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor({ id: "safe", permissions: ["read"], isHighRisk: false }));
    reg.register(makeDescriptor({ id: "risky", permissions: ["read"], isHighRisk: true }));
    const visible = reg.getForOrigin("cloud_channel");
    expect(visible.map((c) => c.id)).toEqual(["safe"]);
  });

  it("cloud_channel 不能访问 shell 权限的能力", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor({ id: "bash", permissions: ["read", "shell"] }));
    reg.register(makeDescriptor({ id: "web_fetch", permissions: ["read", "network"] }));
    const visible = reg.getForOrigin("cloud_channel");
    expect(visible.map((c) => c.id)).toEqual(["web_fetch"]);
  });

  it("cloud_channel 不能访问 admin 权限的能力", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor({ id: "admin_tool", permissions: ["admin"] }));
    expect(reg.getForOrigin("cloud_channel")).toHaveLength(0);
  });

  it("allowedOrigins 白名单：只有列出的 origin 可访问", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor({
      id: "local_only",
      permissions: ["read"],
      allowedOrigins: ["local_ui"],
    }));
    expect(reg.getForOrigin("local_ui").map((c) => c.id)).toEqual(["local_only"]);
    expect(reg.getForOrigin("cloud_channel")).toHaveLength(0);
    expect(reg.getForOrigin("subagent")).toHaveLength(0);
  });

  it("getForOriginWithPermissions：进一步按权限过滤", () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([
      makeDescriptor({ id: "read_only", permissions: ["read"] }),
      makeDescriptor({ id: "write_too", permissions: ["read", "write"] }),
    ]);
    const result = reg.getForOriginWithPermissions("local_ui", ["write"]);
    expect(result.map((c) => c.id)).toEqual(["write_too"]);
  });

  it("subagent origin 与 local_ui 行为相同（无额外限制）", () => {
    const reg = new CapabilityRegistry();
    reg.register(makeDescriptor({ id: "tool", permissions: ["read", "shell"], isHighRisk: true }));
    // subagent 不受 cloud_channel 限制
    expect(reg.getForOrigin("subagent")).toHaveLength(1);
  });
});
