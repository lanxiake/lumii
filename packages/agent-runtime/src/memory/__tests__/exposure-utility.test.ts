/**
 * V47：曝光 / 效用分离（2026-09-17，评审 §2.4.2 / §4.3）
 *
 * 背景：`use_count` 在**注入时** +1，而 `last_used` 也在注入时刷新——两者都是打分的输入，
 * 构成自激：被注入 → 分数变高 → 更容易再被注入。实测 9 条记忆吃掉全部注入席位的 54%，
 * 单条最高 251 次。
 *
 * 本次整改把循环切断在**打分公式**这一层（`scoreMemory` 只按 `created_at`），而不是靠
 * "写入侧少写一个字段"——所以本轮测试的重点是：**连续注入，分数与排序不变**。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentMemoryRepo } from "../memory-repo.js";
import { computeContribution } from "../memory-feedback-repo.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const A = "assistant";
const U = "local-user";

describe("V47 注入只记观测，不改打分输入", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  function rowOf(id: string) {
    return db
      .prepare<
        { last_used: string; use_count: number; last_injected_at: string; exposure_count: number }
      >(
        "SELECT last_used, use_count, last_injected_at, exposure_count FROM agent_memories WHERE id = ?",
      )
      .get(id)!;
  }

  it("注入递增 exposure_count 与 last_injected_at，冻结 use_count 与 last_used", () => {
    const entry = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "project",
      content: "注入计数的观测语义验证条目",
      importance: 0.6,
    });
    const before = rowOf(entry.id);

    repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "注入计数");

    const after = rowOf(entry.id);
    expect(after.exposure_count).toBe(before.exposure_count + 1);
    expect(after.last_injected_at >= before.last_injected_at).toBe(true);
    // 打分输入不变
    expect(after.use_count).toBe(before.use_count);
    expect(after.last_used).toBe(before.last_used);
  });

  it("连续注入 10 轮，排序与得分不变（自激被切断）", () => {
    const old = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "project",
      content: "老条目：高重要度但已很久",
      importance: 0.85,
    });
    const fresh = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "project",
      content: "新条目：重要度普通",
      importance: 0.5,
    });
    // 把老条目回拨 40 天（created_at 与活动时间同步回拨，fixture 自洽）；
    // exposure_count 置 1 以绕过「从未注入且超 30 天」的门控——真实的高价值老条目
    // 正是被用过的那些
    const past = new Date(Date.now() - 40 * 86_400_000).toISOString();
    db.prepare(
      "UPDATE agent_memories SET created_at = ?, last_injected_at = ?, exposure_count = 1 WHERE id = ?",
    ).run(past, past, old.id);

    const order = (): string[] =>
      repo
        .loadTopMemories(A, U, { ...DEFAULT_HOT_MEMORY_CONFIG, maxItems: 10 }, "老条目 新条目")
        .map((e) => e.id);

    const first = order();
    // 前置断言：两条都真的被注入了，否则下面的"顺序不变"是空断言
    expect(first).toHaveLength(2);
    for (let i = 0; i < 10; i++) {
      repo.loadTopMemories(A, U, { ...DEFAULT_HOT_MEMORY_CONFIG, maxItems: 10 }, "老条目 新条目");
    }
    expect(order()).toEqual(first);

    // 被反复注入的老条目 exposure_count 涨了，但 use_count（打分输入）没动
    expect(rowOf(old.id).exposure_count).toBeGreaterThan(10);
    expect(rowOf(old.id).use_count).toBe(0);
    expect(rowOf(fresh.id).use_count).toBe(0);
  });
});

describe("V47 冷数据门控改读 exposure_count", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  it("从未注入且超过 30 天的条目被跳过；注入过的不受影响（即使 use_count 冻结为 0）", () => {
    const never = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "general",
      content: "从未注入过的陈旧条目内容",
      importance: 0.5,
    });
    const used = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "general",
      content: "注入过的陈旧条目内容",
      importance: 0.5,
    });
    const past = new Date(Date.now() - 60 * 86_400_000).toISOString();
    for (const id of [never.id, used.id]) {
      db.prepare("UPDATE agent_memories SET created_at = ?, last_injected_at = ? WHERE id = ?").run(
        past,
        past,
        id,
      );
    }
    // 两条的 use_count 都是 0（新写入不再增长），只有 exposure_count 不同
    db.prepare("UPDATE agent_memories SET exposure_count = 7 WHERE id = ?").run(used.id);
    db.prepare("UPDATE agent_memories SET last_injected_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      used.id,
    );

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "陈旧条目内容");
    const ids = r.map((e) => e.id);
    expect(ids).not.toContain(never.id);
    expect(ids).toContain(used.id);
  });
});

describe("computeContribution — 效用代理三档", () => {
  it("回复近乎照搬记忆用词 → 1", () => {
    const r = computeContribution(
      "用户偏好 pnpm 而不是 npm",
      "记住了：用户偏好 pnpm 而不是 npm。",
    );
    expect(r.contributionScore).toBe(1);
    expect(r.keywordMatch).toBeGreaterThan(0);
  });

  it("回复转述但换了措辞 → 弱相关档（0.5）", () => {
    // 真实回复很少照抄记忆原词，多是转述——这正是「代理噪声未知、先不接打分」的原因
    const r = computeContribution(
      "用户偏好用 pnpm 而不是 npm 安装依赖",
      "好的，后续安装依赖我会统一用 pnpm，不再使用 npm。",
    );
    expect(r.contributionScore).toBe(0.5);
    expect(r.overlap).toBeGreaterThan(0.2);
    expect(r.overlap).toBeLessThan(0.5);
  });

  it("回复与记忆无交集 → 0", () => {
    const r = computeContribution("用户偏好用 pnpm", "今天北京天气晴朗，适合出门。");
    expect(r.contributionScore).toBe(0);
    expect(r.keywordMatch).toBe(0);
  });

  it("空回复 → 0（不产生虚假效用）", () => {
    expect(computeContribution("任意内容", "").contributionScore).toBe(0);
  });
});

describe("效用反馈落库", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  it("写 memory_usage_feedback 并只给被用上的条目递增 utility_count", () => {
    const used = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "reference",
      content: "用户的构建工具偏好是 pnpm",
      importance: 0.7,
    });
    const unused = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "reference",
      content: "用户喜欢在周末爬山远足",
      importance: 0.7,
    });

    const features = { semanticSimilarity: 0, keywordMatch: 0 } as Record<string, number | boolean>;
    const written = repo.recordInjectionOutcomes([
      {
        memoryId: used.id,
        sessionId: "s1",
        queryLength: 12,
        wasUsedInResponse: true,
        contributionScore: 1,
        features,
      },
      {
        memoryId: unused.id,
        sessionId: "s1",
        queryLength: 12,
        wasUsedInResponse: false,
        contributionScore: 0,
        features,
      },
    ]);

    expect(written).toBe(2);
    expect(repo.countFeedback()).toBe(2);

    const utility = (id: string): number =>
      db.prepare<{ utility_count: number }>("SELECT utility_count FROM agent_memories WHERE id = ?").get(id)!
        .utility_count;
    // 负样本也入库（供训练），但不抬高效用
    expect(utility(used.id)).toBe(1);
    expect(utility(unused.id)).toBe(0);

    // query 原文不落库，只落长度
    const row = db
      .prepare<{ query_length: number; was_used_in_response: number }>(
        "SELECT query_length, was_used_in_response FROM memory_usage_feedback LIMIT 1",
      )
      .get()!;
    expect(row.query_length).toBe(12);
    expect(row.was_used_in_response).toBe(1);
  });
});
