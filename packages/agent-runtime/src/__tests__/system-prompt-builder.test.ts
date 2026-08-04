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

describe("buildClientSystemPromptStructured — 能力驱动条件注入", () => {
  it("无代码工具时 full 模式不注入代码细则", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "message"],
      cwd: "/workspace",
      promptDetail: "full",
    });
    expect(fullPrompt).toContain("## 工作原则");
    expect(fullPrompt).not.toContain("涉及写代码时额外遵守");
    expect(fullPrompt).not.toContain("默认不写注释");
  });

  it("含代码工具时 full 模式仍注入代码细则", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_edit", "file_write", "bash", "memory_search"],
      cwd: "/workspace",
      promptDetail: "full",
    });
    expect(fullPrompt).toContain("涉及写代码时额外遵守");
    expect(fullPrompt).toContain("默认不写注释");
  });

  it("standard 模式注入上下文自动压缩 section", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
      promptDetail: "standard",
    });
    expect(dynamicPrompt).toContain("## 上下文自动压缩");
    expect(dynamicPrompt).toContain("memory_read");
  });

  it("compact 模式不注入上下文自动压缩 section", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
      promptDetail: "compact",
    });
    expect(dynamicPrompt).not.toContain("## 上下文自动压缩");
  });

  it("memory_read 可用时记忆召回段包含回查原文指引", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read", "profile_memory"],
      cwd: "/workspace",
      promptDetail: "standard",
    });
    expect(dynamicPrompt).toContain("## 记忆召回");
    expect(dynamicPrompt).toContain("memory_read");
  });
});
