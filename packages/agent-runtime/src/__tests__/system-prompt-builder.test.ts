/**
 * 系统提示词构建器回归测试（通用助手改造 Phase 1）
 */

import { describe, expect, it } from "vitest";
import { buildClientSystemPromptStructured } from "../prompt/system-prompt-builder.js";
import type { AgentDefinition } from "../types/agent-definition.js";

/** 最小 Agent 定义，用于隔离提示词 section 测试 */
const BASE_DEF: AgentDefinition = {
  id: "test-assistant",
  name: "测试助手",
  description: "测试用",
  sourceType: "system",
  version: 1,
  systemPrompt: "You are a test assistant.",
  modelTier: "balanced",
  tools: ["*"],
  permissionMode: "default",
  memory: { scope: "user", autoExtract: true },
  isActive: true,
};

describe("buildClientSystemPromptStructured — capability-driven sections", () => {
  it("omits coding rules in full mode when coding tools are unavailable", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "message"],
      cwd: "/workspace",
      promptDetail: "full",
    });
    expect(fullPrompt).toContain("## Operating Principles");
    expect(fullPrompt).not.toContain("When writing code:");
    expect(fullPrompt).not.toContain("Write no comments by default");
  });

  it("includes coding rules in full mode when coding tools are available", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_edit", "file_write", "bash", "memory_search"],
      cwd: "/workspace",
      promptDetail: "full",
    });
    expect(fullPrompt).toContain("When writing code:");
    expect(fullPrompt).toContain("Write no comments by default");
  });

  it("includes context compaction guidance in standard mode", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
      promptDetail: "standard",
    });
    expect(dynamicPrompt).toContain("## Context Compaction");
    expect(dynamicPrompt).toContain("memory_read");
  });

  it("omits context compaction guidance in compact mode", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
      promptDetail: "compact",
    });
    expect(dynamicPrompt).not.toContain("## Context Compaction");
  });

  it("keeps recall guidance inside the memory tag", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read", "profile_memory"],
      cwd: "/workspace",
      promptDetail: "standard",
    });
    expect(dynamicPrompt).toContain("<memory>");
    expect(dynamicPrompt).toContain("## Memory");
    expect(dynamicPrompt).toContain("memory_read");
    expect(dynamicPrompt).toContain("</memory>");
  });

  it("does not enumerate low-frequency grouped tools without a guide", () => {
    const { staticPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_read", "app_screenshot", "app_goto", "screen_record_start", "screen_record_stop"],
      promptDetail: "standard",
    });
    expect(staticPrompt).toContain("`file_read`");
    expect(staticPrompt).not.toContain("`app_screenshot`");
    expect(staticPrompt).not.toContain("`screen_record_start`");
  });
});
