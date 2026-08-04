/**
 * 安全模块单测：权限管线、权限记忆
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkPermission } from "../permission-checker.js";
import { createPermissionContext, addRules } from "../permission-context.js";
import { PermissionMemory } from "../permission-memory.js";

describe("PermissionMemory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("记录在窗口内返回允许", () => {
    const m = new PermissionMemory();
    m.recordDecision("bash", true, 60_000);
    expect(m.getDecision("bash")).toBe(true);
  });

  it("过期后不再允许", () => {
    const m = new PermissionMemory();
    m.recordDecision("bash", true, 1000);
    vi.advanceTimersByTime(2000);
    expect(m.getDecision("bash")).toBeUndefined();
  });

  it("拒绝不写入记忆", () => {
    const m = new PermissionMemory();
    m.recordDecision("bash", false, 60_000);
    expect(m.getDecision("bash")).toBeUndefined();
  });

  it("clear 清空记忆", () => {
    const m = new PermissionMemory();
    m.recordDecision("bash", true, 60_000);
    m.clear();
    expect(m.getDecision("bash")).toBeUndefined();
  });
});

describe("checkPermission + PermissionMemory", () => {
  it("记忆命中时在 default 模式下直接允许写工具", () => {
    const ctx = createPermissionContext("default");
    const memory = new PermissionMemory();
    memory.recordDecision("bash", true, 86_400_000);
    const r = checkPermission(ctx, "bash", { command: "echo hi" }, undefined, memory);
    expect(r.outcome).toBe("allowed");
  });

  it("记忆不覆盖 deny 规则", () => {
    let ctx = createPermissionContext("default");
    ctx = addRules(ctx, "user", "deny", ["bash"]);
    const memory = new PermissionMemory();
    memory.recordDecision("bash", true, 86_400_000);
    const r = checkPermission(ctx, "bash", { command: "echo hi" }, undefined, memory);
    expect(r.outcome).toBe("denied");
  });

  it("无记忆时 default 模式对写工具要求确认", () => {
    const ctx = createPermissionContext("default");
    const memory = new PermissionMemory();
    const r = checkPermission(ctx, "bash", { command: "echo hi" }, undefined, memory);
    expect(r.outcome).toBe("needs_confirmation");
  });

  it("readOnly 模式仍拒绝写工具（记忆不绕过）", () => {
    const ctx = createPermissionContext("readOnly");
    const memory = new PermissionMemory();
    memory.recordDecision("bash", true, 86_400_000);
    const r = checkPermission(ctx, "bash", { command: "echo hi" }, undefined, memory);
    expect(r.outcome).toBe("denied");
  });
});
