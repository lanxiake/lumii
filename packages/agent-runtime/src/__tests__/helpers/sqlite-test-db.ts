/**
 * 测试用真实 SQLite 适配器
 *
 * 优先 better-sqlite3（默认编译含 FTS5）；若不可用再回退 node:sqlite。
 * 系统 Node 自带的 node:sqlite 常未启用 FTS5（报 no such module: fts5），
 * 而 Electron 路径与 better-sqlite3 均支持 FTS5。
 *
 * 用法：vitest 需能加载 better-sqlite3（宿主 Node ABI）或带 --experimental-sqlite。
 */

import { createRequire } from "node:module";
import type { DatabaseAdapter, PreparedStatement, StatementResult } from "../../storage/local-database.js";
import { MIGRATIONS } from "../../storage/schema.js";

const nodeRequire = createRequire(import.meta.url);

/** 探测适配器是否支持 FTS5 */
function supportsFts5(db: DatabaseAdapter): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
    db.exec("DROP TABLE __fts5_probe");
    return true;
  } catch {
    return false;
  }
}

function wrapBetterSqlite(dbPath: string): DatabaseAdapter {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite = nodeRequire("better-sqlite3") as new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  };
  const sq = new BetterSqlite(dbPath);
  return {
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
}

function wrapNodeSqlite(dbPath: string): DatabaseAdapter {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
      };
      close(): void;
    };
  };
  const sq = new DatabaseSync(dbPath);
  return {
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
}

/**
 * 创建测试用 SQLite 适配器：优先带 FTS5 的 better-sqlite3，否则 node:sqlite。
 */
export function createTestSqliteAdapter(): DatabaseAdapter {
  try {
    const db = wrapBetterSqlite(":memory:");
    if (supportsFts5(db)) return db;
    db.close();
  } catch {
    // fall through
  }

  const nodeDb = wrapNodeSqlite(":memory:");
  if (!supportsFts5(nodeDb)) {
    nodeDb.close();
    throw new Error(
      "测试库需要 FTS5：请安装并重建 better-sqlite3（pnpm --filter @mtbot/agent-runtime rebuild better-sqlite3）",
    );
  }
  return nodeDb;
}

/** 建一个已迁移到最新 schema 的内存库 */
export function createMigratedTestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [, sql] of MIGRATIONS) db.exec(sql);
  return db;
}

/** 建一个只迁移到 V25（即将执行 V26 之前）的内存库，供 V26 迁移测试构造 fixture */
export function createPreV26TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 26) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V26 库执行 V26 迁移 SQL */
export function runMigration26(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 26);
  if (!entry) throw new Error("V26 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}
