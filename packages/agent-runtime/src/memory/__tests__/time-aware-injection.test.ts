/**
 * 时间感知注入（2026-09-15）—— 席位保底 / 时间窗枚举 / 组合分
 *
 * 背景：纯 score 排序下，新条目（importance 默认 0.5）会被历史高 importance 条目
 * 永久挤出注入席位，出现「今天记的当天看不见」；同时汇总类 Agent（chronicler）
 * 需要按时间窗取全量记忆，不能走 top-N 截断。
 *
 * 样例刻意按 store 里的真实分布构造：高 importance（0.75~0.95）的历史条目占多数，
 * 新条目 importance 普遍只有 0.5。
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentMemoryRepo } from "../memory-repo.js";
import { scoreMemory } from "../scorer.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";
import type { MemoryCategory } from "../types.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const A = "assistant";
const U = "local-user";
const DAY = 86_400_000;

/** 写一条记忆并整体回拨到 N 天前（created_at + last_injected_at 同步，daysAgo=0 表示今天新建） */
function saveAged(
  repo: AgentMemoryRepo,
  db: DatabaseAdapter,
  opts: {
    content: string;
    importance: number;
    daysAgo: number;
    agentId?: string;
    category?: MemoryCategory;
  },
): string {
  const entry = repo.saveCandidate({
    agentId: opts.agentId ?? A,
    userId: U,
    category: opts.category ?? "project",
    content: opts.content,
    importance: opts.importance,
    tags: [],
  });
  if (opts.daysAgo > 0) {
    const past = new Date(Date.now() - opts.daysAgo * DAY).toISOString();
    db.prepare(
      "UPDATE agent_memories SET created_at = ?, last_injected_at = ? WHERE id = ?",
    ).run(past, past, entry.id);
  }
  return entry.id;
}

/** 与 query 完全无关的 query：用于验证「保底席位免门控」 */
const UNRELATED_QUERY = "帮我看看这段代码报错";

describe("近 24h 保底席位", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  it("低 importance 新条目不被高 importance 历史条目挤出（真实分布）", () => {
    // 15 条 0.8~0.95 的历史条目，45 天前
    for (let i = 0; i < 15; i++) {
      saveAged(repo, db, {
        content: `历史高重要度项目快照第${i}条`,
        importance: 0.95 - i * 0.01,
        daysAgo: 45,
      });
    }
    const freshIds = [
      saveAged(repo, db, { content: "今天新建的排查结论甲", importance: 0.5, daysAgo: 0 }),
      saveAged(repo, db, { content: "今天新建的排查结论乙", importance: 0.5, daysAgo: 0 }),
      saveAged(repo, db, { content: "今天新建的排查结论丙", importance: 0.5, daysAgo: 0 }),
    ];

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, UNRELATED_QUERY);
    const ids = r.map((m) => m.id);
    // 三条今日条目与 query 零重叠，靠的是保底席位而非相关性
    for (const id of freshIds) expect(ids).toContain(id);
  });

  it("近 7d 次级席位仍受相关性门控：无关的近期条目不注入", () => {
    saveAged(repo, db, { content: "三天前的会议安排", importance: 0.6, daysAgo: 3 });
    saveAged(repo, db, { content: "五天前的旅行计划", importance: 0.6, daysAgo: 5 });

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, UNRELATED_QUERY);
    expect(r.some((m) => m.content.includes("会议安排"))).toBe(false);
    expect(r.some((m) => m.content.includes("旅行计划"))).toBe(false);
  });

  it("席位数上限：今日条目多于 N1 时不超过 freshSeats24h", () => {
    for (let i = 0; i < 8; i++) {
      saveAged(repo, db, { content: `今日条目${i}`, importance: 0.5, daysAgo: 0 });
    }
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, UNRELATED_QUERY);
    expect(r.length).toBeLessThanOrEqual(DEFAULT_HOT_MEMORY_CONFIG.freshSeats24h!);
  });

  it("无 query 时保底席位仍生效，历史与近 7d 条目均不注入", () => {
    saveAged(repo, db, { content: "今天的巡检记录", importance: 0.5, daysAgo: 0 });
    saveAged(repo, db, { content: "三天前的旧记录", importance: 0.9, daysAgo: 3 });
    saveAged(repo, db, { content: "四十天前的旧记录", importance: 0.95, daysAgo: 40 });

    const r = repo.loadTopMemories(A, U);
    expect(r.map((m) => m.content)).toEqual(["今天的巡检记录"]);
  });

  it("短 query（不足 token 门槛）时保底席位仍生效", () => {
    saveAged(repo, db, { content: "今天的巡检记录", importance: 0.5, daysAgo: 0 });
    saveAged(repo, db, { content: "三天前的旧记录", importance: 0.9, daysAgo: 3 });

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "嗯");
    expect(r.map((m) => m.content)).toEqual(["今天的巡检记录"]);
  });

  it("关闭保底（freshSeats24h=0）后退回纯 score 选取", () => {
    saveAged(repo, db, { content: "今天的新条目", importance: 0.5, daysAgo: 0 });
    const cfg = { ...DEFAULT_HOT_MEMORY_CONFIG, freshSeats24h: 0, recentSeats7d: 0 };
    const r = repo.loadTopMemories(A, U, cfg, UNRELATED_QUERY);
    expect(r).toHaveLength(0);
  });

  it("总量不增加：任何情况下注入条数不超过 maxItems", () => {
    for (let i = 0; i < 30; i++) {
      saveAged(repo, db, { content: `条目${i}`, importance: 0.5 + (i % 5) * 0.1, daysAgo: i });
    }
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "条目");
    expect(r.length).toBeLessThanOrEqual(DEFAULT_HOT_MEMORY_CONFIG.maxItems);
  });
});

describe("组合分：年龄衰减 + use_count 加成", () => {
  it("纯函数：年龄衰减让新低 importance 条目胜过旧高 importance 条目", () => {
    const now = Date.now();
    const oldHigh = scoreMemory(
      {
        now,
        createdAt: now - 40 * DAY,
        importance: 0.95,
        category: "project",
        relevance: 0,
      },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    const newLow = scoreMemory(
      {
        now,
        createdAt: now,
        importance: 0.5,
        category: "project",
        relevance: 0,
      },
      DEFAULT_HOT_MEMORY_CONFIG,
    );
    expect(newLow).toBeGreaterThan(oldHigh);
  });

  // 原「缺省 createdAt 时不衰减（向后兼容）」用例已删：V47 起 createdAt 为必填，
  // 该兼容分支不复存在。自激切断的验证移到了 exposure-utility.test.ts（repo 级）。

  it("纯函数：use_count 对数加成且封顶 0.15", () => {
    const now = Date.now();
    const base = { now, createdAt: now, importance: 0.5, category: "project" as const, relevance: 0 };
    const none = scoreMemory({ ...base, useCount: 0 }, DEFAULT_HOT_MEMORY_CONFIG);
    const some = scoreMemory({ ...base, useCount: 5 }, DEFAULT_HOT_MEMORY_CONFIG);
    const many = scoreMemory({ ...base, useCount: 500 }, DEFAULT_HOT_MEMORY_CONFIG);
    expect(some).toBeGreaterThan(none);
    expect(many - none).toBeLessThanOrEqual(0.15 + 1e-9);
  });

  it("集成：同等相关下新低 importance 条目排在旧高 importance 条目之前", () => {
    const db = createMigratedTestDb();
    const repo = new AgentMemoryRepo(db);
    // 旧条目给 exposure_count=1：真实的老高价值条目是被用过的，且 exposure_count=0 且超 30 天的
    // 条目会被「冷数据跳过」拦掉（见下一个用例），那样对照组就不成立了
    const oldId = saveAged(repo, db, {
      content: "关西旅行计划：旧版本已过期",
      importance: 0.9,
      daysAgo: 40,
    });
    db.prepare("UPDATE agent_memories SET exposure_count = 1 WHERE id = ?").run(oldId);
    saveAged(repo, db, { content: "关西旅行计划：新版本待确认", importance: 0.5, daysAgo: 8 });

    // 两条与 query 的 overlap 相同（都含"关西旅行计划"），差异只在 importance × 年龄衰减
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "关西旅行计划");
    expect(r[0].content).toContain("新版本");
  });

  it("集成：关闭年龄衰减（ageDecayFloor=1）后旧高 importance 条目回到首位", () => {
    const db = createMigratedTestDb();
    const repo = new AgentMemoryRepo(db);
    const oldId = saveAged(repo, db, {
      content: "关西旅行计划：旧版本已过期",
      importance: 0.9,
      daysAgo: 40,
    });
    db.prepare("UPDATE agent_memories SET exposure_count = 1 WHERE id = ?").run(oldId);
    saveAged(repo, db, { content: "关西旅行计划：新版本待确认", importance: 0.5, daysAgo: 8 });

    const withDecay = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "关西旅行计划");
    const noDecay = repo.loadTopMemories(
      A,
      U,
      { ...DEFAULT_HOT_MEMORY_CONFIG, ageDecayFloor: 1 },
      "关西旅行计划",
    );
    // 顺序随衰减开关翻转，证明确实是年龄衰减在起作用
    expect(withDecay[0].content).toContain("新版本");
    expect(noDecay[0].content).toContain("旧版本");
  });

  it("集成：use_count 高的条目在同等相关下排前", () => {
    const db = createMigratedTestDb();
    const repo = new AgentMemoryRepo(db);
    saveAged(repo, db, { content: "关西旅行计划甲", importance: 0.6, daysAgo: 10 });
    const hotId = saveAged(repo, db, { content: "关西旅行计划乙", importance: 0.6, daysAgo: 10 });
    db.prepare("UPDATE agent_memories SET use_count = 20 WHERE id = ?").run(hotId);

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "关西旅行计划");
    expect(r[0].id).toBe(hotId);
  });

  it("冷数据跳过：use_count=0 且超期的条目不注入，但存储不变", () => {
    const db = createMigratedTestDb();
    const repo = new AgentMemoryRepo(db);
    const staleId = saveAged(repo, db, {
      content: "关西旅行计划：从未被用过的老条目",
      importance: 0.9,
      daysAgo: 45,
    });

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "关西旅行计划");
    expect(r.some((m) => m.id === staleId)).toBe(false);

    const row = db
      .prepare<{ is_archived: number; use_count: number }>(
        "SELECT is_archived, use_count FROM agent_memories WHERE id = ?",
      )
      .get(staleId);
    expect(row?.is_archived).toBe(0);
    expect(row?.use_count).toBe(0);
  });
});

describe("时间窗全量枚举 listByWindow", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;
  const since24h = (): string => new Date(Date.now() - DAY).toISOString();

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  it("不截断：条数远超 maxItems 时全量可达", () => {
    for (let i = 0; i < 30; i++) {
      saveAged(repo, db, { content: `今日条目${i}`, importance: 0.5, daysAgo: 0 });
    }
    const { entries, total, hasMore } = repo.listByWindow({
      userId: U,
      agentId: A,
      since: since24h(),
      limit: 100,
    });
    expect(total).toBe(30);
    expect(entries).toHaveLength(30);
    expect(entries.length).toBeGreaterThan(DEFAULT_HOT_MEMORY_CONFIG.maxItems);
    expect(hasMore).toBe(false);
  });

  it("按时间窗过滤：窗口外的条目不计入", () => {
    saveAged(repo, db, { content: "今天的条目", importance: 0.5, daysAgo: 0 });
    saveAged(repo, db, { content: "三天前的条目", importance: 0.5, daysAgo: 3 });
    saveAged(repo, db, { content: "十天前的条目", importance: 0.5, daysAgo: 10 });

    const { entries } = repo.listByWindow({ userId: U, agentId: A, since: since24h() });
    expect(entries.map((e) => e.content)).toEqual(["今天的条目"]);
  });

  it("分页不丢条目：offset 逐页取完，总数守恒", () => {
    for (let i = 0; i < 25; i++) {
      saveAged(repo, db, { content: `条目${i}`, importance: 0.5, daysAgo: 0 });
    }
    const p1 = repo.listByWindow({ userId: U, agentId: A, since: since24h(), limit: 10, offset: 0 });
    const p2 = repo.listByWindow({ userId: U, agentId: A, since: since24h(), limit: 10, offset: 10 });
    const p3 = repo.listByWindow({ userId: U, agentId: A, since: since24h(), limit: 10, offset: 20 });

    expect(p1.entries).toHaveLength(10);
    expect(p1.hasMore).toBe(true);
    expect(p2.entries).toHaveLength(10);
    expect(p3.entries).toHaveLength(5);
    expect(p3.hasMore).toBe(false);

    const ids = new Set([...p1.entries, ...p2.entries, ...p3.entries].map((e) => e.id));
    expect(ids.size).toBe(25);
  });

  it("低 importance 条目同样可达（不被 importance 预筛）", () => {
    for (let i = 0; i < 10; i++) {
      saveAged(repo, db, { content: `高重要度历史${i}`, importance: 0.95, daysAgo: 60 });
    }
    const lowId = saveAged(repo, db, { content: "今天的低重要度条目", importance: 0.5, daysAgo: 0 });

    const { entries } = repo.listByWindow({ userId: U, agentId: A, since: since24h() });
    expect(entries.map((e) => e.id)).toContain(lowId);
  });

  it("scope=user 跨 Agent 取数；缺省保持按 Agent 隔离", () => {
    saveAged(repo, db, { content: "assistant 记的工作", importance: 0.5, daysAgo: 0, agentId: A });
    saveAged(repo, db, {
      content: "chronicler 自己的记录",
      importance: 0.5,
      daysAgo: 0,
      agentId: "chronicler",
    });

    const agentScoped = repo.listByWindow({
      userId: U,
      agentId: "chronicler",
      since: since24h(),
    });
    expect(agentScoped.total).toBe(1);

    const userScoped = repo.listByWindow({
      userId: U,
      agentId: "chronicler",
      scope: "user",
      since: since24h(),
    });
    expect(userScoped.total).toBe(2);
    expect(userScoped.entries.map((e) => e.content)).toEqual(
      expect.arrayContaining(["assistant 记的工作", "chronicler 自己的记录"]),
    );
  });

  it("scope=agent 且缺 agentId 时抛错（防静默全量）", () => {
    expect(() => repo.listByWindow({ userId: U, since: since24h() })).toThrow(/agentId is required/);
  });
});

describe("读取作用域：scope=user 让汇总类 Agent 读到用户的工作记忆", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });

  it("loadTopMemories：chronicler 缺省读自己的空库，scope=user 时读到 assistant 的当日工作", () => {
    saveAged(repo, db, {
      content: "assistant 今天的工单排查结论",
      importance: 0.5,
      daysAgo: 0,
      agentId: A,
    });

    // 缺省（scope=agent）：chronicler 名下无记忆 → 空，这正是「日报永远工作记忆为空」的成因
    const own = repo.loadTopMemories("chronicler", U, DEFAULT_HOT_MEMORY_CONFIG, "整理今天的工作日报");
    expect(own).toHaveLength(0);

    // scope=user：用户级读取，跨 Agent 拿到主 Agent 积累的工作
    const shared = repo.loadTopMemories(
      "chronicler",
      U,
      DEFAULT_HOT_MEMORY_CONFIG,
      "整理今天的工作日报",
      "user",
    );
    expect(shared.map((m) => m.content)).toContain("assistant 今天的工单排查结论");
  });

  it("scope=user 仍不跨用户", () => {
    saveAged(repo, db, { content: "本地用户的工作", importance: 0.5, daysAgo: 0, agentId: A });
    const other = repo.loadTopMemories("chronicler", "other-user", DEFAULT_HOT_MEMORY_CONFIG, "整理今天的工作", "user");
    expect(other).toHaveLength(0);
  });
});
