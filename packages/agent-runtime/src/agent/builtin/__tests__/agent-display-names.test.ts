import { describe, it, expect } from "vitest";
import {
  BUILTIN_AGENT_DISPLAY_NAMES,
  BUILTIN_AGENT_ID_ALIASES,
  normalizeAgentTypeId,
  resolveBuiltinDisplayName,
  resolveSpawnAgentTypeInput,
} from "../agent-display-names.js";
import { BUILTIN_AGENT_DEFINITIONS, findBuiltInAgent } from "../definitions.js";

describe("BUILTIN_AGENT_DISPLAY_NAMES", () => {
  /**
   * 防漂移护栏：本表是渲染层唯一能拿到的名字来源，
   * 与权威定义不一致就会让委托卡片显示错误的名字（本模块存在的理由，见文件头）。
   */
  it("与 BUILTIN_AGENT_DEFINITIONS 的 id → name 完全一致（不多不少不改名）", () => {
    const fromDefinitions = Object.fromEntries(
      BUILTIN_AGENT_DEFINITIONS.map((def) => [def.id, def.name]),
    );
    expect(BUILTIN_AGENT_DISPLAY_NAMES).toEqual(fromDefinitions);
  });
});

describe("normalizeAgentTypeId", () => {
  it("历史别名 main / default 归一为 assistant", () => {
    expect(normalizeAgentTypeId("main")).toBe("assistant");
    expect(normalizeAgentTypeId("default")).toBe("assistant");
  });

  it("规范 id 与用户 Agent id 原样返回", () => {
    expect(normalizeAgentTypeId("builtin:explore")).toBe("builtin:explore");
    expect(normalizeAgentTypeId("user-1757000000000-abc123")).toBe("user-1757000000000-abc123");
  });

  it("去除首尾空白", () => {
    expect(normalizeAgentTypeId("  default  ")).toBe("assistant");
  });

  it("别名表覆盖 findBuiltInAgent 的兼容规则", () => {
    for (const alias of Object.keys(BUILTIN_AGENT_ID_ALIASES)) {
      expect(findBuiltInAgent(alias)?.id).toBe(normalizeAgentTypeId(alias));
    }
  });
});

describe("resolveBuiltinDisplayName", () => {
  it("default 显示为「系统默认」（模型实际最常传的 agentType）", () => {
    expect(resolveBuiltinDisplayName("default")).toBe("系统默认");
  });

  it("builtin:* 子 Agent 有名字（此前卡片会显示 builtin:explore 字面量）", () => {
    expect(resolveBuiltinDisplayName("builtin:explore")).toBe("Explore (代码探索)");
    expect(resolveBuiltinDisplayName("builtin:plan")).toBe("Plan (架构规划)");
    expect(resolveBuiltinDisplayName("builtin:verify")).toBe("Verify (对抗性验证)");
  });

  it("团队专家显示中文名", () => {
    expect(resolveBuiltinDisplayName("system-keeper")).toBe("灵栖维护");
    expect(resolveBuiltinDisplayName("code-dev")).toBe("灵栖开发");
    expect(resolveBuiltinDisplayName("chronicler")).toBe("灵栖记事");
    expect(resolveBuiltinDisplayName("info-curator")).toBe("灵栖情报");
  });

  it("未知类型返回 undefined（由调用方回退，不臆造名字）", () => {
    expect(resolveBuiltinDisplayName("worker")).toBeUndefined();
    expect(resolveBuiltinDisplayName("researcher")).toBeUndefined();
    expect(resolveBuiltinDisplayName("user-1757000000000-abc123")).toBeUndefined();
  });
});

describe("resolveSpawnAgentTypeInput", () => {
  it("省略 agentType → assistant", () => {
    expect(resolveSpawnAgentTypeInput(undefined)).toEqual({ typeKey: "assistant" });
  });

  it("worker/researcher → assistant + 友好说明", () => {
    const w = resolveSpawnAgentTypeInput("worker");
    expect(w.typeKey).toBe("assistant");
    expect(w.roleHint).toBe("worker");
    expect(w.agentTypeNote).toContain("worker");
  });
});
