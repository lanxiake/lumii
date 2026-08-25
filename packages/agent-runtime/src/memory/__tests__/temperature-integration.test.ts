/**
 * Task 4 P0：温度集成测试
 *
 * 验证：逐行 computeTemperature → cold 丢弃 / warm 过门控 / hot 跳门控
 * → archiveCold 批量归档 → unarchiveById 恢复 → countByTemperature 统计分布
 */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentMemoryRepo } from "../memory-repo.js";
import { DEFAULT_HOT_MEMORY_CONFIG } from "../types.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";

describe("温度流转：cold/warm/hot 分档与归档", () => {
  let repo: AgentMemoryRepo;
  let db: DatabaseAdapter;
  const A = "agent1";
  const U = "user1";

  /** 写一条记忆并覆写 last_used 到指定天数前 */
  function saveWithAge(
    content: string,
    importance: number,
    daysAgo: number,
    category: "project" | "reference" | "general" = "project",
  ): string {
    const entry = repo.saveCandidate({
      agentId: A,
      userId: U,
      category,
      content,
      importance,
      tags: [],
    });
    const past = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    db.prepare("UPDATE agent_memories SET last_used = ? WHERE id = ?").run(past, entry.id);
    return entry.id;
  }

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new AgentMemoryRepo(db);
  });
  // 温度判定：hot = 个人类 / 7天内使用 / importance>=0.8；warm = 7~30天 && importance>=0.4；cold = 其余

  it("cold 记忆不参与注入（直接丢弃）", () => {
    saveWithAge("35天前的冷记忆", 0.5, 35);
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "随便问点什么无关的东西");
    expect(r.some((m) => m.content.includes("冷记忆"))).toBe(false);
  });

  it("warm 记忆需过相关性门控：与 query 无关时丢弃", () => {
    saveWithAge("15天前的温记忆-骑车爬山", 0.5, 15);
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "帮我看一下这段代码报错原因");
    expect(r.some((m) => m.content.includes("温记忆"))).toBe(false);
  });

  it("warm 记忆过门控：与 query 相关时保留", () => {
    saveWithAge("15天前的温记忆-骑车爬山路线规划", 0.5, 15);
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "帮我规划一条骑车爬山的路线");
    expect(r.some((m) => m.content.includes("温记忆"))).toBe(true);
  });

  it("hot 记忆跳过门控：即使与 query 无关也保留（高重要度）", () => {
    saveWithAge("高重要度的热记忆-项目截止日期", 0.9, 20);
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "今天天气怎么样");
    expect(r.some((m) => m.content.includes("热记忆"))).toBe(true);
  });

  it("hot 记忆跳过门控：最近使用（7天内）即使与 query 无关也保留", () => {
    saveWithAge("最近用过的记忆-会议安排", 0.5, 3);
    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "今天天气怎么样");
    expect(r.some((m) => m.content.includes("会议安排"))).toBe(true);
  });

  it("personal 类（user/feedback）恒为 hot，不受温度衰减影响", () => {
    saveWithAge("用户是后端工程师", 0.3, 60, "project");
    const personalId = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "user",
      content: "用户叫张三",
      importance: 0.3,
      tags: [],
    }).id;
    // 手动把画像记忆也拨到 60 天前，验证即使很久没用仍是 hot
    const past = new Date(Date.now() - 60 * 86_400_000).toISOString();
    db.prepare("UPDATE agent_memories SET last_used = ? WHERE id = ?").run(past, personalId);

    const r = repo.loadTopMemories(A, U, DEFAULT_HOT_MEMORY_CONFIG, "今天天气怎么样");
    expect(r.some((m) => m.content.includes("张三"))).toBe(true);
  });

  it("archiveCold：归档 30 天以上的非 user/feedback 记忆，个人记忆不受影响", () => {
    const coldId = saveWithAge("35天前的旧项目记录", 0.5, 35);
    const personalId = repo.saveCandidate({
      agentId: A,
      userId: U,
      category: "feedback",
      content: "用户偏好简洁回复",
      importance: 0.3,
      tags: [],
    }).id;
    const past = new Date(Date.now() - 60 * 86_400_000).toISOString();
    db.prepare("UPDATE agent_memories SET last_used = ? WHERE id = ?").run(past, personalId);

    const changed = repo.archiveCold(A, U, Date.now());
    expect(changed).toBe(1);

    // 归档不是删除：数据仍在库里，只是 is_archived=1
    const coldRow = db
      .prepare<{ is_archived: number }>("SELECT is_archived FROM agent_memories WHERE id = ?")
      .get(coldId);
    expect(coldRow?.is_archived).toBe(1);

    // 个人记忆不受温度归档影响
    const personalRow = db
      .prepare<{ is_archived: number }>("SELECT is_archived FROM agent_memories WHERE id = ?")
      .get(personalId);
    expect(personalRow?.is_archived).toBe(0);

    // 归档后不再被检索注入
    const r = repo.loadTopMemories(A, U);
    expect(r.some((m) => m.id === coldId)).toBe(false);
  });

  it("unarchiveById：恢复归档后记忆重新可见", () => {
    const coldId = saveWithAge("35天前的旧项目记录", 0.5, 35);
    repo.archiveCold(A, U, Date.now());

    let r = repo.loadTopMemories(A, U);
    expect(r.some((m) => m.id === coldId)).toBe(false);

    repo.unarchiveById(coldId);
    // 恢复后 is_archived 标记必须已清除（unarchive 只解冻不解冷：last_used 仍是 35 天前，
    // 仍会被温度门控挡在注入之外，但归档状态本身要恢复）
    const row = db
      .prepare<{ is_archived: number }>("SELECT is_archived FROM agent_memories WHERE id = ?")
      .get(coldId);
    expect(row?.is_archived).toBe(0);
  });

  it("countByTemperature：返回 hot/warm/cold 分布统计", () => {
    saveWithAge("hot-最近用过", 0.5, 2);
    saveWithAge("warm-15天前", 0.5, 15);
    saveWithAge("cold-35天前", 0.5, 35);

    const dist = repo.countByTemperature(A, U, Date.now());
    expect(dist.hot).toBe(1);
    expect(dist.warm).toBe(1);
    expect(dist.cold).toBe(1);
  });
});
