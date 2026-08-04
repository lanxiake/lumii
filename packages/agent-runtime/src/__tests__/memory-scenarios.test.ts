/**
 * 记忆场景测试 —— 模拟真实使用场景，覆盖"提取/召回门控/去重/边界"四类。
 *
 * 重点覆盖用户反馈的问题：问 A 话题时不应注入无关的 B 记忆（相关性门控）。
 * 与验证手册场景对应，可作为自动化回归 + 手动测试的参照。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentMemoryRepo } from "../memory/memory-repo.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../memory/types.js";
import type { MemoryCategory } from "../memory/types.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

const A = "assistant";
const U = "local-user";

describe("记忆场景：召回相关性门控（用户反馈的核心问题）", () => {
  let repo: AgentMemoryRepo;

  function save(category: MemoryCategory, content: string, importance = 0.6): void {
    repo.saveCandidate({ agentId: A, userId: U, category, content, importance, tags: [] });
  }

  beforeEach(() => {
    repo = new AgentMemoryRepo(createMigratedTestDb());
    // 模拟截图里的记忆集：旅行项目 + Notion 资源 + 骑车爱好（画像）
    save("project", "项目：七月日本关西自由行，规划中，预算2万，成都直飞关西");
    save("reference", "用户平时用 Notion 记笔记和管理任务");
    save("user", "用户喜欢骑车去爬山，特别是去龙泉山骑车加徒步");
  });

  it("问骑车路线 → 不注入无关的旅行/Notion 项目记忆", () => {
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "帮我规划一条龙泉山骑车的路线");
    const contents = r.map((m) => m.content);
    // 骑车爱好（画像/含"骑车"）应在；旅行/Notion（上下文且无关）不应在
    expect(contents.some((c) => c.includes("骑车"))).toBe(true);
    expect(contents.some((c) => c.includes("日本关西"))).toBe(false);
    expect(contents.some((c) => c.includes("Notion"))).toBe(false);
  });

  it("问日本旅行 → 注入旅行项目记忆", () => {
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "我之前规划的日本关西旅行怎么样了");
    expect(r.some((m) => m.content.includes("日本关西"))).toBe(true);
  });

  it("问 Notion → 注入 Notion 资源记忆", () => {
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "我用 Notion 怎么整理资料比较好");
    expect(r.some((m) => m.content.includes("Notion"))).toBe(true);
  });

  it("画像类（user）即使与 query 无关也始终注入", () => {
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "今天天气怎么样");
    expect(r.some((m) => m.category === "user")).toBe(true);
  });

  it("无 query（新会话首轮）→ 退化标量，全部可注入", () => {
    const r = repo.loadTopMemories(A, U);
    expect(r.length).toBe(3);
  });

  it("无意义短 query（嗯/好的）→ 退化标量，不误门控", () => {
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "嗯");
    expect(r.length).toBe(3);
  });
});

describe("记忆场景：取消/过期项目（已知局限说明）", () => {
  let repo: AgentMemoryRepo;
  function save(category: MemoryCategory, content: string, importance = 0.6): void {
    repo.saveCandidate({ agentId: A, userId: U, category, content, importance, tags: [] });
  }
  beforeEach(() => {
    repo = new AgentMemoryRepo(createMigratedTestDb());
  });

  it("取消的旅行：问无关话题时不会被注入（门控已缓解污染）", () => {
    save("project", "项目：七月日本关西自由行，规划中");
    save("project", "项目：七月日本关西自由行，已取消");
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "帮我看看这段代码报错");
    expect(r.some((m) => m.content.includes("日本关西"))).toBe(false);
  });

  it("问旅行时，规划中与已取消两条都会注入（语义去重/取代需阶段③向量，当前为已知局限）", () => {
    save("project", "项目：七月日本关西自由行，规划中");
    save("project", "项目：七月日本关西自由行，已取消");
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "我的日本关西旅行计划");
    // 当前：两条都注入（AI 能看到"已取消"信息）；自动取代旧条目是后续语义合并的事
    expect(r.filter((m) => m.content.includes("日本关西")).length).toBeGreaterThanOrEqual(2);
  });

  it("手动删除：用户删掉过期记忆后不再被召回", () => {
    save("project", "项目：七月日本关西自由行，已取消");
    const before = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "日本关西旅行");
    const id = before[0].id;
    repo.removeById(id);
    const after = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "日本关西旅行");
    expect(after.some((m) => m.id === id)).toBe(false);
  });
});

describe("记忆场景：去重与重要度", () => {
  let repo: AgentMemoryRepo;
  function save(category: MemoryCategory, content: string, importance = 0.6): void {
    repo.saveCandidate({ agentId: A, userId: U, category, content, importance, tags: [] });
  }
  beforeEach(() => {
    repo = new AgentMemoryRepo(createMigratedTestDb());
  });

  it("高重要度记忆在同等相关下排序靠前", () => {
    save("reference", "用户常用飞书协作", 0.3);
    save("reference", "用户常用钉钉打卡", 0.9);
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "用户常用什么办公工具");
    expect(r[0].importance).toBeGreaterThanOrEqual(r[r.length - 1].importance);
  });

  it("召回会更新 use_count（被用过的记忆更热门）", () => {
    save("user", "用户是成都的后端工程师");
    repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "我是做什么工作的");
    const all = repo.listActive(A, U);
    expect(all[0].use_count).toBeGreaterThan(0);
  });
});
