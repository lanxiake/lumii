/**
 * 记忆提取提示词单测
 */

import { describe, it, expect } from "vitest";
import { buildExtractionPrompt } from "../memory/memory-extractor.js";

describe("buildExtractionPrompt", () => {
  it("包含三层架构说明", () => {
    const prompt = buildExtractionPrompt([{ role: "user", content: "请记住我喜欢简洁回复" }]);
    expect(prompt).toContain("记忆系统三层架构");
    expect(prompt).toContain("个人记忆");
    expect(prompt).toContain("工作记忆");
    expect(prompt).toContain("记忆宫殿");
  });

  it("包含个人记忆和工作记忆历史上下文", () => {
    const prompt = buildExtractionPrompt(
      [{ role: "user", content: "用 image_generate 生图" }],
      {
        personalMemory: "- 规则：只用 generate_image.py 生图",
        workMemories: [{ content: "K8s 系列进行中", category: "project" }],
      },
    );
    expect(prompt).toContain("已有个人记忆");
    expect(prompt).toContain("generate_image.py");
    expect(prompt).toContain("已有工作记忆");
    expect(prompt).toContain("K8s 系列进行中");
  });

  it("包含去重与冲突消解规则", () => {
    const prompt = buildExtractionPrompt([{ role: "user", content: "test" }]);
    expect(prompt).toContain("去重与冲突消解");
    expect(prompt).toContain("冲突时以最新为准");
    expect(prompt).toContain("标注适用范围");
  });

  it("明确提取与整理任务边界", () => {
    const prompt = buildExtractionPrompt([{ role: "user", content: "你好" }]);
    expect(prompt).toContain("任务边界");
    expect(prompt).toContain("独立的整理流程");
    expect(prompt).toContain("必须返回 []");
  });

  it("区分个人记忆与工作记忆写入路由", () => {
    const prompt = buildExtractionPrompt([{ role: "user", content: "test" }]);
    expect(prompt).toContain("写入路由");
    expect(prompt).toContain("user_memory Markdown");
    expect(prompt).toContain("SQLite agent_memories");
  });
});
