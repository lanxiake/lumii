/**
 * 测试用真实 SQLite 适配器（基于 Node 22 内置 node:sqlite）
 *
 * 为什么不用 createMemoryDatabase：
 * - better-sqlite3 原生绑定按 Electron ABI 编译，系统 Node 下 vitest 加载失败
 * - node:sqlite 是 Node 内置，跨环境可用，仅需 `--experimental-sqlite` 标志
 *
 * 用法：vitest 需带 NODE_OPTIONS=--experimental-sqlite（见 package.json test 脚本）。
 * 返回已应用全部 MIGRATIONS 的内存库适配器。
 */

import { createRequire } from "node:module";
import type { DatabaseAdapter, PreparedStatement, StatementResult } from "../../storage/local-database.js";
import { MIGRATIONS } from "../../storage/schema.js";

// 用 createRequire 在运行时直接加载内置 node:sqlite，绕过 vite 对 "node:sqlite" 的打包解析
const nodeRequire = createRequire(import.meta.url);

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

export function createTestSqliteAdapter(): DatabaseAdapter {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => DatabaseSyncLike;
  };
  const sq = new DatabaseSync(":memory:");
  const adapter: DatabaseAdapter = {
    exec: (sql: string) => sq.exec(sql),
    prepare: <T = Record<string, unknown>>(sql: string): PreparedStatement<T> => {
      const stmt = sq.prepare(sql);
      return {
        run: (...params: unknown[]): StatementResult =>
          stmt.run(...params) as unknown as StatementResult,
        get: (...params: unknown[]): T | undefined => stmt.get(...params) as T | undefined,
        all: (...params: unknown[]): T[] => stmt.all(...params) as T[],
      };
    },
    close: () => sq.close(),
  };
  return adapter;
}

/** 建一个已迁移到最新 schema 的内存库 */
export function createMigratedTestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [, sql] of MIGRATIONS) db.exec(sql);
  return db;
}
