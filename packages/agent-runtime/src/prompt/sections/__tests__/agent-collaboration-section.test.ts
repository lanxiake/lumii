/**
 * Task Orchestration 提示词诚实化：async 完成由系统注入，不可假装 wait
 */

import { describe, it, expect } from "vitest";
import { buildTaskOrchestrationSection } from "../agent-collaboration-section.js";

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
