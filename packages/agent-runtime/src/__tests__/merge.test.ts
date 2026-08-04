/**
 * S5 去重合并单测：mergeCandidates 纯函数 + MemoryManager.saveSummarizedCandidates
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mergeCandidates, normalizeKey } from "../memory/merge.js";
import { AgentMemoryRepo } from "../memory/memory-repo.js";
import { MemoryManager } from "../memory/manager.js";
import type { MemoryEntry, ExtractedCandidate } from "../memory/types.js";
import { createMigratedTestDb } from "./helpers/sqlite-test-db.js";

function entry(over: Partial<MemoryEntry> & { content: string; category: MemoryEntry["category"] }): MemoryEntry {
  return {
    id: "e-" + Math.random().toString(36).slice(2),
    agent_id: "a1",
    user_id: "u1",
    importance: 0.5,
    tags: [],
    source_message_id: null,
    created_at: "2026-01-01",
    last_used: "2026-01-01",
    use_count: 0,
    is_archived: false,
    ...over,
  };
}

const cand = (content: string, category: ExtractedCandidate["category"], over: Partial<ExtractedCandidate> = {}): ExtractedCandidate => ({
  content,
  category,
  importance: 0.5,
  tags: [],
  ...over,
});

describe("normalizeKey", () => {
  it("去标点/空格/大小写后相同 → 同键", () => {
    expect(normalizeKey("project", "去日本旅行。")).toBe(normalizeKey("project", "去 日本旅行"));
  });
  it("不同 category → 不同键", () => {
    expect(normalizeKey("project", "x")).not.toBe(normalizeKey("reference", "x"));
  });
  it("语义同但措辞不同 → 不同键（已知局限）", () => {
    expect(normalizeKey("user", "我喜欢爬山")).not.toBe(normalizeKey("user", "用户爱好是爬山"));
  });
});

describe("mergeCandidates", () => {
  it("命中已有 → 更新（tags 并集 + importance 取高），不新增", () => {
    const existing = [entry({ id: "e1", content: "去日本旅行", category: "project", tags: ["travel"], importance: 0.6 })];
    const incoming = [cand("去日本旅行！", "project", { tags: ["japan"], importance: 0.8 })];
    const r = mergeCandidates(existing, incoming);
    expect(r.toInsert).toHaveLength(0);
    expect(r.toUpdate).toHaveLength(1);
    expect(r.toUpdate[0].id).toBe("e1");
    expect(new Set(r.toUpdate[0].tags)).toEqual(new Set(["travel", "japan"]));
    expect(r.toUpdate[0].importance).toBe(0.8);
  });

  it("未命中 → 新增", () => {
    const r = mergeCandidates([], [cand("用户常用飞书", "reference")]);
    expect(r.toInsert).toHaveLength(1);
    expect(r.toUpdate).toHaveLength(0);
  });

  it("incoming 内部重复 → 合并为一条", () => {
    const r = mergeCandidates([], [
      cand("去日本旅行", "project", { tags: ["a"], importance: 0.5 }),
      cand("去日本旅行。", "project", { tags: ["b"], importance: 0.7 }),
    ]);
    expect(r.toInsert).toHaveLength(1);
    expect(new Set(r.toInsert[0].tags)).toEqual(new Set(["a", "b"]));
    expect(r.toInsert[0].importance).toBe(0.7);
  });
});

describe("MemoryManager.saveSummarizedCandidates", () => {
  let repo: AgentMemoryRepo;
  let personalSink: ExtractedCandidate[];
  let mgr: MemoryManager;

  beforeEach(() => {
    repo = new AgentMemoryRepo(createMigratedTestDb());
    personalSink = [];
    mgr = new MemoryManager(repo, {
      onPersonalMemoryExtracted: (cs) => personalSink.push(...cs),
    });
  });

  it("AI 记忆新增，个人记忆走回调", () => {
    const n = mgr.saveSummarizedCandidates(
      [
        cand("用户计划去日本旅行", "project"),
        cand("用户是后端工程师", "user"),
        cand("规则：回复简洁。原因：用户要求", "feedback"),
      ],
      "a1",
      "u1",
    );
    expect(n).toBe(3);
    const active = mgr.listActive("a1", "u1");
    expect(active.map((m) => m.category)).toEqual(["project"]); // 仅 AI 入 SQLite
    expect(personalSink).toHaveLength(2); // user + feedback 走回调
  });

  it("二次写入相同 AI 记忆 → 合并不新增", () => {
    mgr.saveSummarizedCandidates([cand("用户常用 Notion", "reference", { tags: ["tool"] })], "a1", "u1");
    mgr.saveSummarizedCandidates([cand("用户常用 Notion。", "reference", { tags: ["app"], importance: 0.9 })], "a1", "u1");
    const active = mgr.listActive("a1", "u1");
    expect(active).toHaveLength(1); // 合并，不新增
    expect(active[0].importance).toBe(0.9);
    expect(new Set(active[0].tags)).toEqual(new Set(["tool", "app"]));
  });

  it("多用户隔离：u1 写入不影响 u2", () => {
    mgr.saveSummarizedCandidates([cand("u1 的项目", "project")], "a1", "u1");
    expect(mgr.listActive("a1", "u2")).toHaveLength(0);
  });

  it("即时画像路径也走 merge：重复'请记住X'不新增（S6 协调）", () => {
    mgr.saveRuleExtractedCandidates(["请记住：项目用 TypeScript"], "a1", "u1");
    mgr.saveRuleExtractedCandidates(["请记住：项目用 TypeScript"], "a1", "u1");
    expect(mgr.listActive("a1", "u1")).toHaveLength(1);
  });

  it("段总结与即时画像协调：规则先写、段总结相同内容合并不新增", () => {
    mgr.saveRuleExtractedCandidates(["请记住：用户偏好深色主题"], "a1", "u1");
    const before = mgr.listActive("a1", "u1").length;
    mgr.saveSummarizedCandidates([cand("用户偏好深色主题。", "general")], "a1", "u1");
    expect(mgr.listActive("a1", "u1")).toHaveLength(before); // 合并，未新增
  });
});
