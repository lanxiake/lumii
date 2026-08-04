/**
 * AgentDefinitionStore — 缓存与同步行为单测
 *
 * 使用轻量 DatabaseAdapter mock，避免依赖本机 SQLite 原生模块 ABI。
 *
 * 架构说明 (v13)：
 * - 内置 Agent 的权威数据源是 api-server `system_agents` 表，不再在客户端 SQLite 做种子写入；
 * - 客户端 AgentDefinitionStore 仅做 "内存 → SQLite 缓存 → API → 离线兜底镜像" 的四级查询链。
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  DatabaseAdapter,
  PreparedStatement,
  StatementResult,
} from "../storage/local-database.js";
import { AgentDefinitionStore } from "../agent/definition-store.js";
import type { AgentDefinition } from "../types/agent-definition.js";

function sampleUserDef(id: string): AgentDefinition {
  return {
    id,
    name: `User ${id}`,
    sourceType: "custom",
    modelTier: "balanced",
    isActive: true,
  };
}

interface CacheRow {
  version: number;
  definition: string;
  synced_at: string;
}

/**
 * 仅实现 definition-store 所需 SQL 的内存适配器
 */
function createMockDefinitionCacheDb(): DatabaseAdapter {
  const rows = new Map<string, CacheRow>();

  return {
    exec() {},
    prepare<T = Record<string, unknown>>(sql: string): PreparedStatement<T> {
      return {
        run(...params: unknown[]): StatementResult {
          if (sql.includes("INSERT OR REPLACE INTO agent_definition_cache")) {
            const [agentId, version, definition, syncedAt] = params as [
              string,
              number,
              string,
              string,
            ];
            rows.set(agentId, {
              version,
              definition,
              synced_at: syncedAt,
            });
          }
          if (sql.includes("DELETE FROM agent_definition_cache WHERE agent_id")) {
            const id = params[0] as string;
            rows.delete(id);
          }
          if (sql.includes("DELETE FROM agent_definition_cache WHERE synced_at")) {
            const cutoff = params[0] as string;
            for (const [id, row] of [...rows.entries()]) {
              if (row.synced_at < cutoff) rows.delete(id);
            }
          }
          if (sql.trim() === "DELETE FROM agent_definition_cache") {
            rows.clear();
          }
          return { changes: 1, lastInsertRowid: 0 };
        },
        get(...params: unknown[]): T | undefined {
          if (sql.includes("SELECT definition FROM agent_definition_cache WHERE agent_id")) {
            const id = params[0] as string;
            const row = rows.get(id);
            return (row ? { definition: row.definition } : undefined) as T;
          }
          return undefined;
        },
        all(..._params: unknown[]): T[] {
          if (sql.includes("SELECT agent_id, version, definition, synced_at")) {
            return [...rows.entries()].map(([agent_id, v]) => ({
              agent_id,
              version: v.version,
              definition: v.definition,
              synced_at: v.synced_at,
            })) as T[];
          }
          if (sql.includes("SELECT agent_id FROM agent_definition_cache WHERE synced_at")) {
            const cutoff = _params[0] as string;
            return [...rows.entries()]
              .filter(([, v]) => v.synced_at < cutoff)
              .map(([agent_id]) => ({ agent_id })) as T[];
          }
          return [];
        },
      };
    },
    close() {},
  };
}

describe("AgentDefinitionStore", () => {
  let db: DatabaseAdapter;

  beforeEach(() => {
    db = createMockDefinitionCacheDb();
  });

  it("API 未返回时落到内置离线兜底（assistant）", async () => {
    const store = new AgentDefinitionStore({
      db,
      fetchById: async () => undefined,
    });

    const a = await store.get("assistant");
    expect(a?.id).toBe("assistant");
    expect(a?.sourceType).toBe("system");
  });

  it("API 抛错时也能落到内置离线兜底（builtin:explore）", async () => {
    const store = new AgentDefinitionStore({
      db,
      fetchById: async () => {
        throw new Error("network down");
      },
    });

    const a = await store.get("builtin:explore");
    expect(a?.id).toBe("builtin:explore");
  });

  it("API 返回权威定义后写入 SQLite，并且下次 new store 从缓存读取", async () => {
    const remote = sampleUserDef("u-1");
    const store = new AgentDefinitionStore({
      db,
      fetchById: async (id) => (id === "u-1" ? remote : undefined),
    });
    const first = await store.get("u-1");
    expect(first?.name).toBe("User u-1");

    const store2 = new AgentDefinitionStore({ db });
    const second = await store2.get("u-1");
    expect(second?.id).toBe("u-1");
  });

  it("syncUserAgents 写入多条并更新同步状态", async () => {
    const list = [sampleUserDef("a"), sampleUserDef("b")];
    const store = new AgentDefinitionStore({
      db,
      fetchAll: async () => list,
    });
    const r = await store.syncUserAgents();
    expect(r.synced).toBe(2);
    const status = store.getSyncStatus();
    expect(status.lastSyncAt).toBeInstanceOf(Date);
    expect(status.lastError).toBeNull();
    expect(status.lastResult?.synced).toBe(2);
  });
});
