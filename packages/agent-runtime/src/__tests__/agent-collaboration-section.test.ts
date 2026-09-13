/**
 * 多 Agent 协作 section 回归测试（队长制 F1：主助手看见团队）
 *
 * 覆盖：
 * - 常驻专家（sourceType=system）单列「团队专家」组，不混入用户自定义组；
 * - Selection 规则包含团队专家委托条目；
 * - filterAgentsForCollaborationPrompt 的 allowedSubAgents 白名单不误伤系统专家。
 */

import { describe, expect, it } from "vitest";
import {
  buildAgentCollaborationSection,
  filterAgentsForCollaborationPrompt,
} from "../prompt/sections/agent-collaboration-section.js";
import type { CustomAgentInfo } from "../prompt/system-prompt.types.js";

const BUILTIN_EXPLORE: CustomAgentInfo = {
  id: "builtin:explore",
  name: "Explore",
  description: "Fast code exploration",
};

const SYSTEM_KEEPER: CustomAgentInfo = {
  id: "system-keeper",
  name: "灵栖维护",
  description: "Maintain Lumii's knowledge assets and act on the client",
  sourceType: "system",
};

const USER_AGENT: CustomAgentInfo = {
  id: "user-123",
  name: "我的小助手",
  description: "用户自建",
};

describe("buildAgentCollaborationSection — 团队专家分组", () => {
  it("系统成员单列「团队专家」组，位于内置与用户自定义之间", () => {
    const text = buildAgentCollaborationSection(
      [BUILTIN_EXPLORE, SYSTEM_KEEPER, USER_AGENT],
      ["spawn_agent"],
    ).join("\n");

    const builtinIdx = text.indexOf("**系统内置专家 (Built-in):**");
    const specialistIdx = text.indexOf("**团队专家 (Team specialists):**");
    const userIdx = text.indexOf("**用户自定义 Agent");

    expect(builtinIdx).toBeGreaterThan(-1);
    expect(specialistIdx).toBeGreaterThan(builtinIdx);
    expect(userIdx).toBeGreaterThan(specialistIdx);

    // 成员各自落在正确的组内
    expect(text.indexOf("**灵栖维护**")).toBeGreaterThan(specialistIdx);
    expect(text.indexOf("**灵栖维护**")).toBeLessThan(userIdx);
    expect(text.indexOf("**我的小助手**")).toBeGreaterThan(userIdx);
  });

  it("无系统成员时不渲染团队专家组与专家规则", () => {
    const text = buildAgentCollaborationSection([BUILTIN_EXPLORE, USER_AGENT], [
      "spawn_agent",
    ]).join("\n");
    expect(text).not.toContain("Team specialists");
    expect(text).not.toContain("team specialist");
  });

  it("sourceType=user 显式标记仍归入用户自定义组", () => {
    const explicit: CustomAgentInfo = {
      id: "user-456",
      name: "自建二号",
      sourceType: "user",
    };
    const text = buildAgentCollaborationSection([explicit], []).join("\n");
    expect(text).toContain("**用户自定义 Agent");
    expect(text).not.toContain("Team specialists");
  });

  it("Selection 规则包含团队专家委托条目（spawn_agent, agentType = id）", () => {
    const text = buildAgentCollaborationSection([SYSTEM_KEEPER], ["spawn_agent"]).join("\n");
    expect(text).toContain("team specialist");
    expect(text).toContain("`agentType` = its id");
  });
});

describe("filterAgentsForCollaborationPrompt — 系统专家不受白名单误伤", () => {
  it("allowedSubAgents 仅约束 builtin:，系统专家与用户自建始终保留", () => {
    const filtered = filterAgentsForCollaborationPrompt(
      [
        BUILTIN_EXPLORE,
        { id: "builtin:plan", name: "Plan" },
        SYSTEM_KEEPER,
        USER_AGENT,
        { id: "assistant", name: "默认" },
      ],
      ["builtin:explore"],
    );
    expect(filtered.map((a) => a.id)).toEqual([
      "builtin:explore",
      "system-keeper",
      "user-123",
    ]);
  });
});
