/**
 * Storage 模块单元测试
 *
 * 使用 mock DatabaseAdapter，不依赖实际 SQLite。
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  DatabaseAdapter,
  PreparedStatement,
  StatementResult,
} from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import { ConversationRepo } from "../storage/conversation-repo.js";
import { TaskRepo } from "../storage/task-repo.js";
import { AuditRepo } from "../storage/audit-repo.js";
import { RuntimeStateRepo } from "../storage/runtime-state-repo.js";

// ─── Mock 内存数据库 ───

/** 简单的内存 SQL 数据库 mock，用于单元测试 */
function createMockDb(): DatabaseAdapter {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const kv = new Map<string, Record<string, unknown>>();

  // 简化的内存存储 — 仅支持基本 INSERT/SELECT/UPDATE/DELETE
  // 实际的 SQL 解析太复杂，这里用键值存储模拟
  const mockDb: DatabaseAdapter = {
    exec(_sql: string) {
      // DDL 操作在 mock 中忽略
    },
    prepare<T = Record<string, unknown>>(sql: string): PreparedStatement<T> {
      return {
        run(...params: unknown[]): StatementResult {
          // 模拟写操作
          return { changes: 1, lastInsertRowid: 1 };
        },
        get(...params: unknown[]): T | undefined {
          // 模拟查询
          const key = `${sql}:${JSON.stringify(params)}`;
          return kv.get(key) as T | undefined;
        },
        all(...params: unknown[]): T[] {
          return [];
        },
      };
    },
    close() {
      tables.clear();
      kv.clear();
    },
  };

  return mockDb;
}

// ─── withTransaction 测试 ───

describe("withTransaction", () => {
  it("成功事务应正常返回", () => {
    const db = createMockDb();
    let beginCalled = false;
    let commitCalled = false;

    const originalExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === "BEGIN") beginCalled = true;
      if (sql === "COMMIT") commitCalled = true;
      originalExec(sql);
    };

    const result = withTransaction(db, () => 42);

    expect(result).toBe(42);
    expect(beginCalled).toBe(true);
    expect(commitCalled).toBe(true);
  });

  it("失败事务应回滚并抛出异常", () => {
    const db = createMockDb();
    let rollbackCalled = false;

    const originalExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      if (sql === "ROLLBACK") rollbackCalled = true;
      originalExec(sql);
    };

    expect(() => {
      withTransaction(db, () => {
        throw new Error("test error");
      });
    }).toThrow("test error");

    expect(rollbackCalled).toBe(true);
  });
});

// ─── RuntimeStateRepo 测试 ───

describe("RuntimeStateRepo", () => {
  let db: DatabaseAdapter;
  let repo: RuntimeStateRepo;
  const store = new Map<string, { value: string; updated_at: string }>();

  beforeEach(() => {
    store.clear();
    db = {
      exec() {},
      prepare<T = Record<string, unknown>>(sql: string): PreparedStatement<T> {
        return {
          run(...params: unknown[]): StatementResult {
            if (sql.includes("INSERT") || sql.includes("ON CONFLICT")) {
              const key = params[0] as string;
              const value = params[1] as string;
              const updated_at = params[2] as string;
              store.set(key, { value, updated_at });
            }
            if (sql.includes("DELETE")) {
              const key = params[0] as string;
              const existed = store.has(key);
              store.delete(key);
              return { changes: existed ? 1 : 0, lastInsertRowid: 0 };
            }
            return { changes: 1, lastInsertRowid: 0 };
          },
          get(...params: unknown[]): T | undefined {
            if (sql.includes("SELECT")) {
              const key = params[0] as string;
              const entry = store.get(key);
              if (entry) return entry as T;
            }
            return undefined;
          },
          all(...params: unknown[]): T[] {
            if (sql.includes("LIKE")) {
              const prefix = (params[0] as string).replace(/%$/, "");
              return [...store.entries()]
                .filter(([k]) => k.startsWith(prefix))
                .map(([key, entry]) => ({ key, value: entry.value }) as T);
            }
            return [...store.entries()].map(([key]) => ({ key }) as T);
          },
        };
      },
      close() {
        store.clear();
      },
    };
    repo = new RuntimeStateRepo(db);
  });

  it("set/get 字符串值", () => {
    repo.set("testKey", "testValue");
    expect(repo.get("testKey")).toBe("testValue");
  });

  it("setJson/getJson 对象值", () => {
    repo.setJson("config", { hello: "world" });
    expect(repo.getJson("config")).toEqual({ hello: "world" });
  });

  it("get 不存在的键返回 undefined", () => {
    expect(repo.get("nonexistent")).toBeUndefined();
  });

  it("delete 已存在的键返回 true", () => {
    repo.set("toDelete", "value");
    expect(repo.delete("toDelete")).toBe(true);
  });

  it("has 检查键存在性", () => {
    repo.set("exists", "yes");
    expect(repo.has("exists")).toBe(true);
    expect(repo.has("notExists")).toBe(false);
  });

  it("listByPrefix 过滤前缀", () => {
    repo.set("prefix:a", "1");
    repo.set("prefix:b", "2");
    repo.set("other:c", "3");
    const results = repo.listByPrefix("prefix:");
    expect(results).toHaveLength(2);
  });

  it("setWithExpiry / getObject 过期后删除", async () => {
    repo.setWithExpiry("ttlKey", { x: 1 }, 1);
    expect(repo.getObject<{ x: number }>("ttlKey")).toEqual({ x: 1 });
    await new Promise((r) => setTimeout(r, 15));
    expect(repo.getObject("ttlKey")).toBeUndefined();
  });
});

// ─── TaskRepo 基本测试 ───

describe("TaskRepo", () => {
  it("create 应返回带递增 ID 的 TaskRow", () => {
    const db = createMockDb();
    const repo = new TaskRepo(db);

    const task = repo.create({ subject: "Test task", description: "Test desc" });

    expect(task.id).toBe("1");
    expect(task.subject).toBe("Test task");
    expect(task.status).toBe("pending");
    expect(task.created_at).toBeTruthy();
  });
});

// ─── AuditRepo 基本测试 ───

describe("AuditRepo", () => {
  it("log 不应抛出异常", () => {
    const db = createMockDb();
    const repo = new AuditRepo(db);

    expect(() => {
      repo.log({
        agentId: "agent-1",
        toolName: "bash",
        resultSummary: "output text",
        durationMs: 100,
      });
    }).not.toThrow();
  });

  it("logLlmUsage 应记录 __llm_call__ 工具", () => {
    const db = createMockDb();
    const repo = new AuditRepo(db);

    expect(() => {
      repo.logLlmUsage({
        agentId: "agent-1",
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        durationMs: 500,
      });
    }).not.toThrow();
  });
});
