/**
 * Project 快照取代（V48 · 评审 §4.4 / §2.5.3）
 *
 * 旧实现用 `extractProjectTheme()` 的正则从自由文本里猜项目主题，实测只识别 18% 的
 * project 记忆、零重复主题、251 条零归档——根因是正则要求 `项目：XXX`，而真实内容写的是
 * `XXX：项目当前状态为…`，方向反了。
 *
 * 现在改由提取时的模型产出结构化 `project_key`，检测器比对它：
 * **把解释工作放在写路径**，读路径才廉价且确定。
 *
 * 本用例守住：
 * 1. 同 key 的新快照写入后，旧快照被标记 superseded（非破坏：行还在，可回放）
 * 2. 被取代的条目不再参与注入与检索
 * 3. 不同 key、无 key 的条目不受影响
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryManager } from "../manager.js";
import { AgentMemoryRepo } from "../memory-repo.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const A = "assistant";
const U = "local-user";

describe("project 快照取代（按 project_key）", () => {
  let db: DatabaseAdapter;
  let repo: AgentMemoryRepo;
  let manager: MemoryManager;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
    manager = new MemoryManager(repo);
  });

  function saveSnapshot(content: string, projectKey?: string): void {
    manager.saveSummarizedCandidates(
      [{ content, category: "project", importance: 0.7, tags: [], ...(projectKey ? { projectKey } : {}) }],
      A,
      U,
    );
  }

  function supersededAtOf(content: string): string | null {
    return db
      .prepare<{ superseded_at: string | null }>(
        "SELECT superseded_at FROM agent_memories WHERE content = ?",
      )
      .get(content)!.superseded_at;
  }

  it("同 key 的新快照写入后，旧快照被取代且仍留在库中", () => {
    saveSnapshot("K8s 系列：写到第 3 篇", "k8s小红书系列");
    saveSnapshot("K8s 系列：写到第 5 篇", "k8s小红书系列");

    expect(supersededAtOf("K8s 系列：写到第 3 篇")).not.toBeNull();
    expect(supersededAtOf("K8s 系列：写到第 5 篇")).toBeNull();

    // 非破坏：旧行还在，带 superseded_by 指回新快照（可回放「当时为什么那么认为」）
    const old = db
      .prepare<{ superseded_by: string; archive_reason: string; c: number }>(
        `SELECT m.superseded_by, m.archive_reason, (SELECT COUNT(*) FROM agent_memories WHERE id = m.superseded_by) AS c
         FROM agent_memories m WHERE m.content = 'K8s 系列：写到第 3 篇'`,
      )
      .get()!;
    expect(old.archive_reason).toBe("superseded");
    expect(old.c).toBe(1); // 取代者确实存在
  });

  it("被取代的条目不再参与注入与检索", () => {
    saveSnapshot("K8s 系列：写到第 3 篇", "k8s小红书系列");
    saveSnapshot("K8s 系列：写到第 5 篇", "k8s小红书系列");

    const injected = repo
      .loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "K8s 系列 写到")
      .map((e) => e.content);
    expect(injected).toContain("K8s 系列：写到第 5 篇");
    expect(injected).not.toContain("K8s 系列：写到第 3 篇");

    expect(repo.search(A, U, "K8s 系列").map((e) => e.content)).toEqual(["K8s 系列：写到第 5 篇"]);
    expect(repo.listActive(A, U).map((e) => e.content)).toEqual(["K8s 系列：写到第 5 篇"]);
  });

  it("不同 key 的 project 快照互不影响", () => {
    saveSnapshot("K8s 系列：写到第 3 篇", "k8s小红书系列");
    saveSnapshot("二十四史学习：第 2 课", "二十四史");

    expect(supersededAtOf("K8s 系列：写到第 3 篇")).toBeNull();
    expect(repo.listActive(A, U)).toHaveLength(2);
  });

  it("没有 project_key 的条目永不被取代（不能靠猜内容格式）", () => {
    saveSnapshot("某个没给 key 的项目快照");
    saveSnapshot("另一个没给 key 的项目快照");

    expect(repo.listActive(A, U)).toHaveLength(2);
    expect(supersededAtOf("某个没给 key 的项目快照")).toBeNull();
  });

  it("非 project 类别带 key 也不触发取代（键只对 project 有意义）", () => {
    manager.saveSummarizedCandidates(
      [{ content: "一条 reference 内容", category: "reference", importance: 0.6, tags: [], projectKey: "k" }],
      A,
      U,
    );
    manager.saveSummarizedCandidates(
      [{ content: "另一条 reference 内容", category: "reference", importance: 0.6, tags: [], projectKey: "k" }],
      A,
      U,
    );

    expect(repo.listActive(A, U)).toHaveLength(2);
  });

  it("key 归一化：大小写与标点差异视为同一个项目", () => {
    saveSnapshot("K8s 系列：写到第 3 篇", "K8s 小红书系列");
    saveSnapshot("K8s 系列：写到第 5 篇", "k8s小红书系列");

    expect(supersededAtOf("K8s 系列：写到第 3 篇")).not.toBeNull();
  });
});
