/**
 * 系统提示词构建器回归测试（通用助手改造 Phase 1）
 *
 * P1-T2：详度轴（compact/standard/full）已移除，改全局两态风格（detailed/terse）。
 * - 默认 detailed = 原 standard 基线（吸收 full 专属段：代码细则 / 命名契约 / Disk-Index）
 * - terse 档的红线段（safety / verification / language / taskCompletion / 压缩告知等）不变
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
  it("detailed 档无代码工具时仍注入工作原则，但不注入代码细则", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "message"],
      cwd: "/workspace",
      promptStyle: "detailed",
    });
    expect(fullPrompt).toContain("## Operating Principles");
    expect(fullPrompt).not.toContain("When writing code:");
    expect(fullPrompt).not.toContain("Write no comments by default");
  });

  it("detailed 档具备代码工具时注入代码细则（原 full 行为升格，迁移映射 #18）", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_edit", "file_write", "bash", "memory_search"],
      cwd: "/workspace",
      promptStyle: "detailed",
    });
    expect(fullPrompt).toContain("When writing code:");
    expect(fullPrompt).toContain("Write no comments by default");
  });

  it("detailed 档具备文件工具时注入工具命名契约（原 full 专属，迁移映射 #7）", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_read", "file_write", "bash"],
      cwd: "/workspace",
      promptStyle: "detailed",
    });
    expect(fullPrompt).toContain("## Tool Naming Contract");
  });

  it("terse 档不注入工具命名契约（索引化后不再需要）", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_read", "file_write", "bash"],
      cwd: "/workspace",
      promptStyle: "terse",
    });
    expect(fullPrompt).not.toContain("## Tool Naming Contract");
  });

  it("默认（不传 style）为 detailed：注入上下文压缩告知", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
    });
    expect(dynamicPrompt).toContain("## Context Compaction");
    expect(dynamicPrompt).toContain("memory_read");
  });

  it("terse 档下上下文压缩告知仍注入（红线段未 terse 化，行为=detailed 渲染）", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
      promptStyle: "terse",
    });
    expect(dynamicPrompt).toContain("## Context Compaction");
    expect(dynamicPrompt).toContain("memory_read");
  });

  it("keeps recall guidance inside the memory tag", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read", "profile_memory"],
      cwd: "/workspace",
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
    });
    expect(staticPrompt).toContain("`file_read`");
    expect(staticPrompt).not.toContain("`app_screenshot`");
    expect(staticPrompt).not.toContain("`screen_record_start`");
  });
});

describe("首批 5 段 terse/detailed 双渲染（P1-T3）", () => {
  const PILOT_TOOLS = [
    "file_read",
    "file_write",
    "message",
    "channel_list",
    "channel_send",
    "weixin_send_guide",
    "browser_screenshot",
    "browser_eval",
  ];

  const build = (promptStyle: "detailed" | "terse") =>
    buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: PILOT_TOOLS,
      cwd: "/workspace",
      runtimeInfo: { channel: "weixin" },
      promptStyle,
    });

  it("terse 档：5 段均出现展开引导（prompt_guide 字面量 / 既有工具）", () => {
    const { fullPrompt } = build("terse");
    expect(fullPrompt).toContain('prompt_guide(section: "operatingPrinciples")');
    expect(fullPrompt).toContain('prompt_guide(section: "progressiveLoading")');
    expect(fullPrompt).toContain('prompt_guide(section: "fileOutput")');
    expect(fullPrompt).toContain('prompt_guide(section: "browser")');
    // messaging 走既有工具链（weixin_send_guide）
    expect(fullPrompt).toContain("weixin_send_guide");
    expect(fullPrompt).toContain("channel_send");
    // terse 档不注入详细细则
    expect(fullPrompt).not.toContain("### Disk-Index Pattern");
    expect(fullPrompt).not.toContain("## Channel outbound");
  });

  it("terse 档静态段体量显著小于 detailed（索引化生效）", () => {
    const terse = build("terse");
    const detailed = build("detailed");
    expect(terse.staticPrompt.length).toBeLessThan(detailed.staticPrompt.length);
    // detailed 侧保留完整细则
    expect(detailed.fullPrompt).toContain("### Disk-Index Pattern");
    expect(detailed.fullPrompt).toContain("## Channel outbound");
    expect(detailed.fullPrompt).not.toContain("prompt_guide(section:");
  });

  it("terse 档保留操作原则红线句（根因 / 不越界）", () => {
    const { fullPrompt } = build("terse");
    expect(fullPrompt).toContain("stay within scope, fix root causes");
  });
});
