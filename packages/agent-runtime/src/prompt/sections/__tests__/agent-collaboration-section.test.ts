/**
 * Task Orchestration 提示词诚实化：async 完成由系统注入，不可假装 wait
 */

import { describe, it, expect } from "vitest";
import {
  buildAgentCollaborationSection,
  buildTaskOrchestrationSection,
} from "../agent-collaboration-section.js";
import type { CustomAgentInfo } from "../../system-prompt.types.js";

describe("buildTaskOrchestrationSection", () => {
  it("含 spawn 时说明 SUBAGENT_COMPLETE 系统注入，不再暗示模型能 wait async", () => {
    const text = buildTaskOrchestrationSection(["spawn_agent", "todo_write"]).join("\n");

    expect(text).toContain("[SUBAGENT_COMPLETE]");
    expect(text).toContain("system will inject");
    expect(text).not.toContain("wait for all `dependsOnIndex` tasks before serial ones");
  });

  it("无 spawn 时不注入 SUBAGENT_COMPLETE 文案", () => {
    const text = buildTaskOrchestrationSection(["todo_write"]).join("\n");
    expect(text).not.toContain("[SUBAGENT_COMPLETE]");
    expect(text).toContain("Task Orchestration");
  });
});

describe("buildAgentCollaborationSection · send_message 语义", () => {
  const agents: CustomAgentInfo[] = [
    { id: "system-keeper", name: "灵栖维护", sourceType: "system", description: "记忆与资料库维护" },
  ];

  it("有 send_message 时说明「给正在跑的任务追加」并给出未命中时的出路", () => {
    const text = buildAgentCollaborationSection(agents, ["spawn_agent", "send_message"]).join("\n");

    expect(text).toContain("Messaging a Running Task");
    expect(text).toContain("appends to work that is already running");
    expect(text).toContain("delegate the work again with `spawn_agent`");
  });

  it("terse 档同样带追加语义，且不展开完整小节", () => {
    const text = buildAgentCollaborationSection(agents, ["spawn_agent", "send_message"], "terse").join("\n");

    expect(text).toContain("appends to work that is already running");
    expect(text).not.toContain("### Messaging a Running Task");
  });

  it("没有 send_message 工具时不注入该段（避免提及不可用工具）", () => {
    const text = buildAgentCollaborationSection(agents, ["spawn_agent"]).join("\n");

    expect(text).not.toContain("Messaging a Running Task");
    expect(text).not.toContain("appends to work that is already running");
  });
});
