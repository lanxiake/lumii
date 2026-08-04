/**
 * 个人记忆整理单测
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildMemoryConsolidationPrompt,
  consolidateUserMemory,
  consolidateExistingPersonalMemory,
  needsPersonalMemoryConsolidation,
} from "../memory/memory-consolidation.js";

describe("needsPersonalMemoryConsolidation", () => {
  it("检测 generate_image.py 与 image_generate 冲突", () => {
    const content = [
      "- 规则：只用 generate_image.py 生图",
      "- 规则：用 image_generate 工具生图",
    ].join("\n");
    const check = needsPersonalMemoryConsolidation(content);
    expect(check.needed).toBe(true);
    expect(check.trigger).toBe("existing_conflicts");
  });

  it("检测重复规则前缀", () => {
    const content = [
      "- 规则：每个时代只需封面+5-6张图。原因：A。应用：B",
      "- 规则：每个时代只需封面+5-6张图。原因：C。应用：D",
    ].join("\n");
    const check = needsPersonalMemoryConsolidation(content);
    expect(check.needed).toBe(true);
    expect(check.trigger).toBe("existing_duplicates");
  });

  it("干净短记忆不需要整理", () => {
    expect(needsPersonalMemoryConsolidation("- 用户是架构师").needed).toBe(false);
  });
});

describe("buildMemoryConsolidationPrompt", () => {
  it("包含已有个人记忆和新候选", () => {
    const prompt = buildMemoryConsolidationPrompt(
      "- 用户是架构师\n- 规则：回复要简洁",
      [{ content: "规则：用 image_generate 生图", category: "feedback", importance: 0.9, tags: [] }],
    );
    expect(prompt).toContain("已有个人记忆");
    expect(prompt).toContain("用户是架构师");
    expect(prompt).toContain("image_generate");
    expect(prompt).toContain("冲突消解");
    expect(prompt).toContain("三层架构");
  });

  it("无新候选时进入仅整理模式", () => {
    const prompt = buildMemoryConsolidationPrompt("- 用户叫张三", []);
    expect(prompt).toContain("用户叫张三");
    expect(prompt).toContain("仅整理");
  });
});

describe("consolidateUserMemory", () => {
  it("无新候选且无需整理时返回原文", async () => {
    const result = await consolidateUserMemory({
      existingContent: "- 用户叫张三",
      newCandidates: [],
      callLLM: vi.fn(),
    });
    expect(result.content).toBe("- 用户叫张三");
    expect(result.merged).toBe(false);
  });

  it("全部已存在时跳过", async () => {
    const callLLM = vi.fn();
    const result = await consolidateUserMemory({
      existingContent: "- 用户叫张三",
      newCandidates: [
        { content: "用户叫张三", category: "user", importance: 0.8, tags: [] },
      ],
      callLLM,
    });
    expect(result.merged).toBe(false);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("LLM 成功时返回整理后内容", async () => {
    const callLLM = vi.fn().mockResolvedValue(
      "## 基本信息\n- 用户叫张三\n\n## 交互偏好\n- 规则：用 image_generate 生图",
    );
    const result = await consolidateUserMemory({
      existingContent: "- 用户叫张三",
      newCandidates: [
        { content: "规则：用 image_generate 生图", category: "feedback", importance: 0.9, tags: [] },
      ],
      callLLM,
    });
    expect(result.merged).toBe(true);
    expect(result.content).toContain("image_generate");
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it("LLM 失败时回退到简单追加", async () => {
    const callLLM = vi.fn().mockRejectedValue(new Error("LLM error"));
    const result = await consolidateUserMemory({
      existingContent: "- 用户叫张三",
      newCandidates: [
        { content: "规则：回复要简洁", category: "feedback", importance: 0.8, tags: [] },
      ],
      callLLM,
    });
    expect(result.merged).toBe(false);
    expect(result.content).toContain("回复要简洁");
  });
});

describe("consolidateExistingPersonalMemory", () => {
  it("有冲突时触发 LLM 整理", async () => {
    const existing = [
      "- 规则：只用 generate_image.py",
      "- 规则：用 image_generate 工具",
    ].join("\n");
    const callLLM = vi.fn().mockResolvedValue("## 交互偏好\n- 规则：用 image_generate 工具");
    const result = await consolidateExistingPersonalMemory({
      existingContent: existing,
      callLLM,
    });
    expect(result.merged).toBe(true);
    expect(callLLM).toHaveBeenCalledOnce();
  });
});
