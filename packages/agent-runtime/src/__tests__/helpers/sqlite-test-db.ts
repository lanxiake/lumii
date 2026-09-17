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

/** 建一个只迁移到 V26（即将执行 V27 之前）的内存库，供 V27 迁移测试构造 fixture */
export function createPreV27TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 27) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V27 库执行 V27 迁移 SQL */
export function runMigration27(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 27);
  if (!entry) throw new Error("V27 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

/** 建一个只迁移到 V40（即将执行 V41 之前）的内存库，供 V41 迁移测试构造 fixture */
export function createPreV41TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 41) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V41 库执行 V41 迁移 SQL */
export function runMigration41(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 41);
  if (!entry) throw new Error("V41 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

/** 建一个只迁移到 V43（即将执行 V44 之前）的内存库，供 V44 迁移测试构造 fixture */
export function createPreV44TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 44) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V44 库执行 V44 迁移 SQL（工具统计重建为 agent 维度） */
export function runMigration44(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 44);
  if (!entry) throw new Error("V44 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

/** 建一个只迁移到 V44（即将执行 V45 之前）的内存库，供 V45 迁移测试构造 fixture */
export function createPreV45TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 45) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V45 库执行 V45 迁移 SQL（审计表补 definition_id） */
export function runMigration45(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 45);
  if (!entry) throw new Error("V45 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

/** 建一个只迁移到 V46（即将执行 V47 之前）的内存库，供 V47 迁移测试构造 fixture */
export function createPreV47TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 47) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V47 库执行 V47 迁移 SQL（记忆的曝光 / 效用分离） */
export function runMigration47(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 47);
  if (!entry) throw new Error("V47 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

/** 建一个只迁移到 V47（即将执行 V48 之前）的内存库，供 V48 迁移测试构造 fixture */
export function createPreV48TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 48) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V48 库执行 V48 迁移 SQL（取代语义：project_key / superseded_* / archive_reason） */
export function runMigration48(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 48);
  if (!entry) throw new Error("V48 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}

/** 建一个只迁移到 V48（即将执行 V49 之前）的内存库，供 V49 迁移测试构造 fixture */
export function createPreV49TestDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter();
  for (const [version, sql] of MIGRATIONS) {
    if (version >= 49) continue;
    db.exec(sql);
  }
  return db;
}

/** 对一个 pre-V49 库执行 V49 迁移 SQL（自建记忆宫殿：palace_drawers + FTS） */
export function runMigration49(db: DatabaseAdapter): void {
  const entry = MIGRATIONS.find(([version]) => version === 49);
  if (!entry) throw new Error("V49 migration not found in MIGRATIONS");
  db.exec(entry[1]);
}
