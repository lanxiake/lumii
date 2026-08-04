/**
 * Memory 模块单元测试
 */

import { describe, it, expect, vi } from "vitest";
import { extractByRules, extractByLLM, hasMemoryTrigger } from "../memory/memory-extractor.js";
import {
  formatMemoriesForPrompt,
  formatUserMemoryForPrompt,
  injectMemories,
} from "../memory/memory-injector.js";
import type { MemoryEntry } from "../memory/types.js";
import type { AgentMemoryRepo } from "../memory/memory-repo.js";
import { MemoryManager } from "../memory/manager.js";

// ─── extractByRules 测试 ───

describe("extractByRules", () => {
  // ─── 保留的高置信规则 ───

  it("提取'记住'命令", () => {
    const results = extractByRules(["请记住：我的项目用 TypeScript"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.category).toBe("general");
    expect(results[0]!.importance).toBeGreaterThanOrEqual(0.9);
    expect(results[0]!.content).toContain("TypeScript");
  });

  it("提取用户姓名", () => {
    const results = extractByRules(["我叫张三"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.category).toBe("user");
    expect(results[0]!.content).toContain("张三");
  });

  it("提取英文姓名", () => {
    const results = extractByRules(["my name is Alice"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.content).toContain("Alice");
  });

  it("提取年龄", () => {
    const results = extractByRules(["我今年28岁"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.category).toBe("user");
    expect(results[0]!.tags).toContain("age");
    expect(results[0]!.content).toContain("28");
  });

  it("提取地理位置", () => {
    const results = extractByRules(["我住在上海"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.category).toBe("user");
    expect(results[0]!.tags).toContain("location");
    expect(results[0]!.content).toContain("上海");
  });

  it("提取健康/过敏信息", () => {
    const results = extractByRules(["我对花粉过敏"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.category).toBe("user");
    expect(results[0]!.tags).toContain("health");
  });

  it("提取职业", () => {
    const results = extractByRules(["我是一名软件工程师"]);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.category).toBe("user");
    expect(results[0]!.tags).toContain("profession");
    expect(results[0]!.content).toContain("工程师");
  });

  // ─── 边界用例 ───

  it("空消息返回空结果", () => {
    const results = extractByRules([]);
    expect(results).toHaveLength(0);
  });

  it("无匹配时返回空结果", () => {
    const results = extractByRules(["今天天气真好"]);
    expect(results).toHaveLength(0);
  });

  it("忽略过短内容", () => {
    const results = extractByRules(["记住：ab"]);
    expect(results).toHaveLength(0);
  });

  // ─── 防止任务指令被误当成长期记忆 ───

  it("任务指令中的'不要 XXX'不应被当成 feedback 记忆", () => {
    const results = extractByRules(["请优化这篇文章，不要改变原文的核心内容和结构"]);
    expect(results).toHaveLength(0);
  });

  it("任务描述中的'我需要 XXX'不应被当成 project 记忆", () => {
    const results = extractByRules(["我需要你帮我写一份会议纪要"]);
    expect(results).toHaveLength(0);
  });

  it("操作意愿'我计划/我打算'不应被当成长期计划", () => {
    const results = extractByRules(["我打算用这段代码替换掉原函数"]);
    expect(results).toHaveLength(0);
  });

  it("工具使用'我常用/我在用'不应被当成 reference 记忆", () => {
    const results = extractByRules(["我常用的变量名是 ctx，帮我改一下"]);
    expect(results).toHaveLength(0);
  });

  it("泛泛的喜好'我喜欢'不应被误当成偏好记忆", () => {
    const results = extractByRules(["我喜欢这个方案，就按这个来"]);
    expect(results).toHaveLength(0);
  });
});

// ─── hasMemoryTrigger 测试 ───

describe("hasMemoryTrigger", () => {
  it("命中中文触发词", () => {
    expect(hasMemoryTrigger("请记住我的生日是 5 月 1 日")).toBe(true);
    expect(hasMemoryTrigger("帮我记一下这个账号")).toBe(true);
    expect(hasMemoryTrigger("保存到记忆")).toBe(true);
  });

  it("命中英文触发词", () => {
    expect(hasMemoryTrigger("remember this conversation")).toBe(true);
    expect(hasMemoryTrigger("save to memory please")).toBe(true);
  });

  it("普通陈述不应命中", () => {
    expect(hasMemoryTrigger("今天天气真好")).toBe(false);
    expect(hasMemoryTrigger("我在写一份方案")).toBe(false);
    expect(hasMemoryTrigger("不要改变原文结构")).toBe(false);
  });
});

// ─── extractByLLM 测试 ───

describe("extractByLLM", () => {
  it("解析有效 JSON 响应", async () => {
    const mockLLM = async () =>
      JSON.stringify([
        { content: "用户名: Bob", category: "user", importance: 0.8, tags: ["identity"] },
      ]);

    const results = await extractByLLM({
      recentMessages: [{ role: "user", content: "我叫 Bob" }],
      existingMemories: [],
      callLLM: mockLLM,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("用户名: Bob");
    expect(results[0]!.category).toBe("user");
  });

  it("处理带 code fence 的 JSON 响应", async () => {
    const mockLLM = async () => '```json\n[{"content": "test", "category": "general"}]\n```';

    const results = await extractByLLM({
      recentMessages: [{ role: "user", content: "test" }],
      existingMemories: [],
      callLLM: mockLLM,
    });

    expect(results).toHaveLength(1);
  });

  it("LLM 返回空数组", async () => {
    const mockLLM = async () => "[]";
    const results = await extractByLLM({
      recentMessages: [{ role: "user", content: "hello" }],
      existingMemories: [],
      callLLM: mockLLM,
    });
    expect(results).toHaveLength(0);
  });

  it("LLM 返回非 JSON 不抛错", async () => {
    const mockLLM = async () => "not json";
    const results = await extractByLLM({
      recentMessages: [{ role: "user", content: "hello" }],
      existingMemories: [],
      callLLM: mockLLM,
    });
    expect(results).toHaveLength(0);
  });

  it("空消息列表返回空", async () => {
    const mockLLM = async () => "[]";
    const results = await extractByLLM({
      recentMessages: [],
      existingMemories: [],
      callLLM: mockLLM,
    });
    expect(results).toHaveLength(0);
  });

  it("无效 category 回退到 general", async () => {
    const mockLLM = async () => JSON.stringify([{ content: "test", category: "invalid_cat" }]);
    const results = await extractByLLM({
      recentMessages: [{ role: "user", content: "test" }],
      existingMemories: [],
      callLLM: mockLLM,
    });
    expect(results[0]!.category).toBe("general");
  });

  it("importance 被 clamp 到 0-1", async () => {
    const mockLLM = async () =>
      JSON.stringify([{ content: "test", category: "user", importance: 5.0 }]);
    const results = await extractByLLM({
      recentMessages: [{ role: "user", content: "test" }],
      existingMemories: [],
      callLLM: mockLLM,
    });
    expect(results[0]!.importance).toBe(1);
  });
});

// ─── MemoryInjector 测试 ───

describe("formatUserMemoryForPrompt", () => {
  it("空内容返回空字符串", () => {
    expect(formatUserMemoryForPrompt("")).toBe("");
  });

  it("包含个人记忆标题和硬约束", () => {
    const result = formatUserMemoryForPrompt("- 用户是架构师");
    expect(result).toContain("关于用户（个人记忆）");
    expect(result).toContain("硬约束");
    expect(result).toContain("用户是架构师");
  });
});

describe("formatMemoriesForPrompt", () => {
  it("空记忆返回空字符串", () => {
    expect(formatMemoriesForPrompt([])).toBe("");
  });

  it("格式化记忆为 markdown", () => {
    const memories: MemoryEntry[] = [
      {
        id: "1",
        agent_id: "main",
        user_id: "user1",
        category: "user",
        content: "用户名: Alice",
        importance: 0.8,
        tags: ["identity"],
        source_message_id: null,
        created_at: "2024-01-01",
        last_used: "2024-01-01",
        use_count: 1,
        is_archived: false,
      },
    ];
    const result = formatMemoriesForPrompt(memories);
    expect(result).toContain("工作记忆");
    expect(result).toContain("用户画像");
    expect(result).toContain("用户名: Alice");
  });
});

describe("injectMemories", () => {
  it("无记忆时返回原始 prompt", () => {
    const prompt = "You are a helpful assistant.";
    expect(injectMemories(prompt, [])).toBe(prompt);
  });

  it("追加记忆到 prompt 末尾", () => {
    const prompt = "You are a helpful assistant.";
    const memories: MemoryEntry[] = [
      {
        id: "1",
        agent_id: "main",
        user_id: "user1",
        category: "feedback",
        content: "用户偏好简洁回复",
        importance: 0.7,
        tags: [],
        source_message_id: null,
        created_at: "2024-01-01",
        last_used: "2024-01-01",
        use_count: 0,
        is_archived: false,
      },
    ];
    const result = injectMemories(prompt, memories);
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("工作记忆");
    expect(result).toContain("用户偏好简洁回复");
  });
});

// ─── MemoryManager（Mock Repo，不依赖本机 SQLite 原生模块） ───

describe("MemoryManager", () => {
  it("saveRuleExtractedCandidates 委托 repo 并返回保存条数", () => {
    const saveCandidate = vi.fn();
    const listActive = vi.fn().mockReturnValue([]); // merge 路径需要：返回空表示无已有记忆
    const updateMergedFields = vi.fn();
    const repo = { saveCandidate, listActive, updateMergedFields } as unknown as AgentMemoryRepo;
    const mgr = new MemoryManager(repo);
    const n = mgr.saveRuleExtractedCandidates(["请记住：mock 测试"], "a", "u");
    expect(n).toBeGreaterThan(0);
    expect(saveCandidate).toHaveBeenCalled();
  });

  it("deleteMemory 调用 repo.removeById", () => {
    const removeById = vi.fn();
    const repo = { removeById } as unknown as AgentMemoryRepo;
    const mgr = new MemoryManager(repo);
    mgr.deleteMemory("mid-1");
    expect(removeById).toHaveBeenCalledWith("mid-1");
  });

  it("injectIntoSystemPrompt 在无记忆时返回原文", () => {
    const repo = {
      loadTopMemories: () => [] as MemoryEntry[],
    } as unknown as AgentMemoryRepo;
    const mgr = new MemoryManager(repo);
    const { updatedPrompt, injected } = mgr.injectIntoSystemPrompt("base", "x", "y");
    expect(updatedPrompt).toBe("base");
    expect(injected).toHaveLength(0);
  });
});
