/**
 * LocalDatabase — SQLite 连接管理 + Schema 迁移
 *
 * 使用 node:sqlite 的 DatabaseSync（Node 22.19+ / Electron 36 原生内建）。
 * 若 node:sqlite 不可用，回退到 better-sqlite3。
 */

import path from "node:path";
import fs from "node:fs";
import { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import {
  startScheduledDatabaseBackup,
  tryRestoreFromLatestBackup,
  verifyDatabaseIntegrity,
  deleteSqliteSidecarFiles,
  findLatestBackupPath,
} from "./backup.js";

/**
 * 删除 SQLite WAL/SHM 辅助文件（委托 backup 模块统一实现）
 */
function tryDeleteWalFiles(dbPath: string): boolean {
  return deleteSqliteSidecarFiles(dbPath);
}

/**
 * 将损坏的数据库文件重命名为备份
 *
 * 在 SQLITE_IOERR 等无法恢复的错误发生时，
 * 将主 db 及其辅助文件重命名为带时间戳的备份，
 * 允许应用以空数据库启动，避免无限崩溃。
 *
 * @returns 新空库应使用的路径。正常情况返回原 dbPath（rename 成功，原路径已空出）；
 *          Windows EBUSY 文件被锁时返回带时间戳的新路径（绕开被锁文件）。
 */
function rotateCorruptedDb(dbPath: string): string {
  const ts = Date.now();
  for (const ext of ["", "-wal", "-shm"]) {
    const src = dbPath + ext;
    try {
      if (fs.existsSync(src)) {
        fs.renameSync(src, `${dbPath}.corrupted-${ts}${ext}`);
      }
    } catch (err) {
      if (ext === "") {
        console.warn("[local-database] 无法重命名损坏的数据库文件，将尝试直接删除:", err);
        try {
          fs.unlinkSync(src);
        } catch (unlinkErr) {
          // Windows EBUSY：文件被 SQLite/其他进程锁定，rename 和 unlink 均失败。
          // 此时无法清空原路径，改用带时间戳的新路径作为空库，彻底绕开被锁文件。
          console.warn(
            "[local-database] 无法删除损坏的数据库文件（文件被锁定），将使用新路径启动空库:",
            unlinkErr,
          );
          return `${dbPath}.new-${ts}`;
        }
      }
    }
  }
  return dbPath;
}

/**
 * 数据库适配器接口
 *
 * 抽象 node:sqlite 和 better-sqlite3 的差异，
 * 使上层 Repo 代码无需关心具体实现。
 */
export interface DatabaseAdapter {
  /** 执行多条 SQL 语句（DDL / 批量操作） */
  exec(sql: string): void;
  /** 预编译 SQL 并返回 Statement */
  prepare<T = Record<string, unknown>>(sql: string): PreparedStatement<T>;
  /** 关闭数据库连接 */
  close(): void;
}

export interface PreparedStatement<T = Record<string, unknown>> {
  /** 执行写操作，返回 { changes, lastInsertRowid } */
  run(...params: unknown[]): StatementResult;
  /** 查询单行 */
  get(...params: unknown[]): T | undefined;
  /** 查询多行 */
  all(...params: unknown[]): T[];
}

export interface StatementResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * 手动事务封装
 *
 * node:sqlite 没有 db.transaction() 语法糖，
 * 需要手动 BEGIN/COMMIT/ROLLBACK。
 */
export function withTransaction<R>(db: DatabaseAdapter, fn: () => R): R {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * 创建 node:sqlite 适配器
 *
 * node:sqlite 的 StatementSync 方法接受 SupportedValueType[]，
 * 我们通过 as any 桥接，因为上层 Repo 代码传入的参数实际上都是有效的 SQL 值类型。
 */
async function createNodeSqliteAdapter(dbPath: string): Promise<DatabaseAdapter> {
  // 动态导入 node:sqlite（可能不可用）
  console.log("[local-database] 尝试 import node:sqlite ...");
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    const mod = await import("node:sqlite");
    DatabaseSync = mod.DatabaseSync;
    console.log("[local-database] node:sqlite 导入成功");
  } catch (err) {
    console.error("[local-database] node:sqlite 导入失败:", err);
    throw err;
  }
  console.log("[local-database] 创建 DatabaseSync 实例:", dbPath);
  const db = new DatabaseSync(dbPath);

  // 启用 WAL 模式和外键约束
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: <T = Record<string, unknown>>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: (...params: unknown[]) => stmt.run(...(params as any[])) as unknown as StatementResult,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get: (...params: unknown[]) => stmt.get(...(params as any[])) as T | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        all: (...params: unknown[]) => stmt.all(...(params as any[])) as T[],
      };
    },
    close: () => db.close(),
  };
}

/**
 * 创建 better-sqlite3 适配器（备选方案）
 *
 * better-sqlite3 是可选依赖，仅在 node:sqlite 不可用时使用。
 * 使用动态 require/import + any 类型避免强制安装。
 */
async function createBetterSqliteAdapter(dbPath: string): Promise<DatabaseAdapter> {
  console.log("[local-database] 尝试加载 better-sqlite3 ...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BetterSqlite: any;
  try {
    // 优先尝试 require()（Electron CJS 环境下更可靠，能正确定位 native addon）
    // 使用变量绕过 bundler 的静态分析
    const moduleName = "better-sqlite3";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof require !== "undefined") {
      // CJS 环境（Electron 主进程打包后）
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(moduleName);
      BetterSqlite = mod.default ?? mod;
      console.log("[local-database] better-sqlite3 require 成功");
    } else {
      // ESM 环境（Node.js 直接执行）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (Function("m", "return import(m)") as (m: string) => Promise<any>)(
        moduleName,
      );
      BetterSqlite = mod.default ?? mod;
      console.log("[local-database] better-sqlite3 dynamic import 成功");
    }
  } catch (err) {
    console.error("[local-database] better-sqlite3 加载失败:", err);
    throw new Error(
      "Neither node:sqlite nor better-sqlite3 is available. " +
        "Please install better-sqlite3 or use Node.js >= 22.5.0 with --experimental-sqlite.",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new BetterSqlite(dbPath) as any;

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  return {
    exec: (sql: string) => db.exec(sql),
    prepare: <T = Record<string, unknown>>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params) as StatementResult,
        get: (...params: unknown[]) => stmt.get(...params) as T | undefined,
        all: (...params: unknown[]) => stmt.all(...params) as T[],
      };
    },
    close: () => db.close(),
  };
}

/**
 * 判断错误是否由 better-sqlite3 原生绑定缺失导致
 *
 * 在 Electron/Node 升级后，若未重新编译 better-sqlite3，
 * 会抛出 "Could not locate the bindings file"。
 * 该场景不应覆盖 node:sqlite 的原始错误，否则会中断后续恢复流程。
 */
function isBetterSqliteBindingMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
  return (
    message.includes("Could not locate the bindings file") ||
    message.includes("compiled against a different Node.js version") ||
    code === "ERR_DLOPEN_FAILED"
  );
}

/**
 * 创建内存数据库适配器（用于测试）
 */
export async function createMemoryDatabase(): Promise<DatabaseAdapter> {
  try {
    return await createNodeSqliteAdapter(":memory:");
  } catch {
    return await createBetterSqliteAdapter(":memory:");
  }
}

export interface LocalDatabaseOptions {
  /** 数据库文件路径 */
  readonly dbPath: string;
  /** 是否优先使用 better-sqlite3（跳过 node:sqlite 检测） */
  readonly preferBetterSqlite?: boolean;
  /** 是否启用每日自动备份（默认 true；`openWith` 内存库建议 false） */
  readonly enableScheduledBackup?: boolean;
  /** 备份目录，默认与数据库同级的 `backups/` */
  readonly backupDirectory?: string;
  /** 保留备份天数，默认 7 */
  readonly backupRetentionDays?: number;
  /** 本地时间每日备份小时（0–23），默认 3 */
  readonly backupHourLocal?: number;
  /** 打开成功后立即执行一次备份 */
  readonly backupOnOpen?: boolean;
}

/**
 * LocalDatabase — 管理 SQLite 连接和 schema 迁移
 */
export class LocalDatabase {
  private _db: DatabaseAdapter | null = null;
  /** 当前打开的数据库文件路径（`open` / `openWithRecovery` 后可用） */
  private _dbPath: string | null = null;
  /** 停止定时备份（由 `startScheduledDatabaseBackup` 返回） */
  private _stopBackup: (() => void) | null = null;

  /** 主库文件路径（未打开时为 null） */
  get dbPath(): string | null {
    return this._dbPath;
  }

  /** 获取底层数据库适配器 */
  get db(): DatabaseAdapter {
    if (!this._db) {
      throw new Error("Database not initialized. Call open() first.");
    }
    return this._db;
  }

  /** 数据库是否已打开 */
  get isOpen(): boolean {
    return this._db !== null;
  }

  /**
   * 打开数据库并执行 schema 迁移
   */
  async open(options: LocalDatabaseOptions): Promise<void> {
    if (this._db) return;

    const backupDir = options.backupDirectory ?? path.join(path.dirname(options.dbPath), "backups");
    await this.openWithRecovery(options, backupDir, 0);
  }

  /**
   * 打开数据库并可选从备份恢复（integrity_check 失败时最多恢复一次）
   */
  private async openWithRecovery(
    options: LocalDatabaseOptions,
    backupDir: string,
    recoveryDepth: number,
  ): Promise<void> {
    const { dbPath, preferBetterSqlite } = options;
    const maxRecovery = 1;

    const tryOpen = async (openPath: string = dbPath): Promise<DatabaseAdapter> => {
      if (preferBetterSqlite) {
        return createBetterSqliteAdapter(openPath);
      }
      try {
        return await createNodeSqliteAdapter(openPath);
      } catch (nodeSqliteErr) {
        console.warn("[local-database] node:sqlite 失败，回退 better-sqlite3:", nodeSqliteErr);
        try {
          return await createBetterSqliteAdapter(openPath);
        } catch (betterSqliteErr) {
          // better-sqlite3 未就绪时，回退失败不应掩盖 node:sqlite 原始错误。
          // 继续抛出 node:sqlite 错误，以便外层走 WAL 清理/损坏库轮转恢复逻辑。
          if (isBetterSqliteBindingMissing(betterSqliteErr)) {
            console.warn(
              "[local-database] better-sqlite3 原生绑定缺失，继续使用 node:sqlite 错误触发恢复流程:",
              betterSqliteErr,
            );
            throw nodeSqliteErr;
          }
          throw betterSqliteErr;
        }
      }
    };

    /**
     * 判断是否属于可自动恢复的 SQLite I/O/损坏错误
     *
     * 兼容 node:sqlite 在 Electron 下返回的错误形态：
     * - code: ERR_SQLITE_ERROR（Node.js 原生）或 SQLITE_IOERR*（某些版本）
     * - errstr/message: "disk I/O error" / "database disk image is malformed"
     *
     * 注意：Electron 内嵌的 node:sqlite 有时不设置 code 字段，
     * 因此同时检测 message 内容作为兜底。
     */
    const isIoErr = (err: unknown): boolean => {
      const e = (err ?? {}) as {
        code?: string;
        errstr?: string;
        message?: string;
      };
      const code = e.code ?? "";
      const detail = `${e.errstr ?? ""} ${e.message ?? ""}`.toLowerCase();
      const ioKeywords = [
        "disk i/o error",
        "database disk image is malformed",
        "database is malformed",
        "database or disk is full",
      ];

      return (
        code.startsWith("SQLITE_IOERR") ||
        code === "SQLITE_CORRUPT" ||
        (code === "ERR_SQLITE_ERROR" && ioKeywords.some((kw) => detail.includes(kw))) ||
        // 兜底：code 缺失时直接匹配 message（Electron node:sqlite 某些版本行为）
        (!code && ioKeywords.some((kw) => detail.includes(kw)))
      );
    };

    /**
     * 打印完整错误信息（包括 code/errstr），方便诊断 node:sqlite 在不同 Electron 版本下的行为差异
     */
    const logSqliteErr = (label: string, err: unknown): void => {
      const e = (err ?? {}) as { code?: string; errstr?: string; message?: string };
      console.warn(
        `[local-database] ${label}: code=${e.code ?? "(none)"} errstr=${e.errstr ?? "(none)"} message=${e.message ?? err}`,
      );
    };

    // 实际打开的数据库路径（正常情况 = dbPath；Windows EBUSY 时 = 带时间戳的新路径）
    let actualDbPath = dbPath;

    // 第 1 次尝试：直接打开（SQLite 会自动重放有效的 WAL 文件，保留已提交的变更）
    // ⚠️ 不在此处预先删除 WAL/SHM：若进程上次异常退出，WAL 中可能保存着已提交但
    //    尚未 checkpoint 的操作（如用户删除会话的 DELETE）。预先删 WAL 会丢失这些变更。
    try {
      this._db = await tryOpen();
    } catch (err) {
      logSqliteErr("第1次打开失败", err);
      if (!isIoErr(err)) throw err;

      // 第 2 次尝试：IOERR → WAL/SHM 可能处于不一致状态，清理后重试
      // 仅在打开失败后才删 WAL，此时 WAL 已损坏，删除不会造成数据丢失
      tryDeleteWalFiles(dbPath);
      try {
        this._db = await tryOpen();
      } catch (err2) {
        logSqliteErr("第2次打开失败（清理WAL后）", err2);
        if (!isIoErr(err2)) throw err2;

        // 第 3 次尝试：WAL 清理后仍失败，主 db 文件本身损坏
        // 先轮转/绕开被锁文件，再优先从 backups/ 恢复，避免以空库启动丢失历史
        actualDbPath = rotateCorruptedDb(dbPath);
        let openedFromBackup = false;
        if (recoveryDepth < maxRecovery && findLatestBackupPath(backupDir)) {
          if (tryRestoreFromLatestBackup(actualDbPath, backupDir)) {
            try {
              this._db = await tryOpen(actualDbPath);
              openedFromBackup = true;
              console.info(
                `[local-database] 已从备份恢复数据库: target=${actualDbPath} backupDir=${backupDir}`,
              );
            } catch (restoreErr) {
              logSqliteErr("从备份恢复后打开仍失败", restoreErr);
              tryDeleteWalFiles(actualDbPath);
            }
          }
        }
        if (!openedFromBackup) {
          try {
            this._db = await tryOpen(actualDbPath);
          } catch (err3) {
            logSqliteErr("第3次打开失败（轮转损坏库后）", err3);
            // 连空库都打不开（极端情况：磁盘满/权限拒绝/文件被锁定）
            const dbDir = path.dirname(dbPath);
            let dirExists = false;
            try {
              dirExists = fs.existsSync(dbDir);
            } catch {
              /* ignore */
            }
            throw new Error(
              `SQLite 无法打开数据库（${(err3 as Error).message ?? err3}）。` +
                `数据目录: ${dbDir}（${dirExists ? "存在" : "不存在"}）。` +
                "请检查磁盘空间、文件权限，以及是否有其他进程锁定了数据库文件。",
            );
          }
        }
      }
    }

    this._dbPath = actualDbPath;
    this.migrate();

    const dbAfterMigrate = this._db;
    if (!dbAfterMigrate) {
      throw new Error("Database not initialized after migrate.");
    }

    // 空库但存在历史备份时自动恢复一次（覆盖「上次以空库启动」的降级场景）
    if (
      recoveryDepth < maxRecovery &&
      findLatestBackupPath(backupDir) &&
      isDatabaseLikelyEmpty(dbAfterMigrate)
    ) {
      const latestBackup = findLatestBackupPath(backupDir)!;
      try {
        const backupSize = fs.statSync(latestBackup).size;
        if (backupSize > 4096) {
          console.warn(
            `[local-database] 当前库为空但存在备份（${path.basename(latestBackup)}），尝试自动恢复…`,
          );
          dbAfterMigrate.close();
          this._db = null;
          this._dbPath = null;
          if (tryRestoreFromLatestBackup(actualDbPath, backupDir)) {
            await this.openWithRecovery(options, backupDir, recoveryDepth + 1);
            return;
          }
          this._db = await tryOpen(actualDbPath);
          this._dbPath = actualDbPath;
          this.migrate();
        }
      } catch {
        /* 自动恢复失败时继续使用当前已打开的空库 */
      }
    }

    const dbForIntegrity = this._db;
    if (!dbForIntegrity) {
      throw new Error("Database not initialized before integrity_check.");
    }

    if (!verifyDatabaseIntegrity(dbForIntegrity)) {
      dbForIntegrity.close();
      this._db = null;
      this._dbPath = null;
      if (recoveryDepth < maxRecovery && tryRestoreFromLatestBackup(dbPath, backupDir)) {
        await this.openWithRecovery(options, backupDir, recoveryDepth + 1);
        return;
      }
      throw new Error(
        "SQLite database failed integrity_check and could not be restored from backup.",
      );
    }

    if (options.enableScheduledBackup !== false) {
      this._stopBackup?.();
      this._stopBackup = startScheduledDatabaseBackup({
        dbPath: actualDbPath,
        backupDir,
        retentionDays: options.backupRetentionDays ?? 7,
        hourLocal: options.backupHourLocal ?? 3,
        // 启动时立即备份一次：保住启动前的干净状态，恢复时可回退到本次启动前
        backupOnOpen: options.backupOnOpen ?? true,
        // 传入 db 引用，备份前自动执行 wal_checkpoint(FULL) 确保备份完整
        db: this._db ?? undefined,
      });
    }
  }

  /**
   * 使用已有的数据库适配器（用于测试或共享连接）
   */
  openWith(db: DatabaseAdapter): void {
    if (this._db) return;
    this._db = db;
    this._dbPath = null;
    this.migrate();
  }

  /**
   * 关闭数据库连接（退出前执行 WAL checkpoint，降低异常退出导致 WAL 损坏的概率）
   */
  close(): void {
    this._stopBackup?.();
    this._stopBackup = null;
    if (this._db) {
      try {
        this._db.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // 退出阶段 checkpoint 失败不阻断 close
      }
      this._db.close();
      this._db = null;
      this._dbPath = null;
    }
  }

  /**
   * 执行 schema 迁移
   *
   * 从 runtime_state 读取 schemaVersion，
   * 按序执行所有 version > currentVersion 的 migration。
   */
  private migrate(): void {
    const db = this.db;

    // 确保 runtime_state 表存在（用于存储 schemaVersion）
    db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `);

    // 读取当前版本
    const row = db
      .prepare<{ value: string }>("SELECT value FROM runtime_state WHERE key = 'schemaVersion'")
      .get();
    const currentVersion = row ? parseInt(row.value, 10) : 0;

    if (currentVersion >= SCHEMA_VERSION) return;

    /**
     * 检查指定表是否存在指定列
     */
    const hasColumn = (tableName: string, columnName: string): boolean => {
      try {
        const rows = db.prepare<{ name: string }>(`PRAGMA table_info(${tableName})`).all();
        return rows.some((row) => row.name === columnName);
      } catch {
        return false;
      }
    };

    /**
     * 判断某个 migration 是否已由现有库结构覆盖（用于幂等跳过）
     */
    const isMigrationAlreadyApplied = (version: number): boolean => {
      switch (version) {
        case 2:
          return hasColumn("messages", "is_streaming");
        case 5:
          return (
            hasColumn("local_cron_jobs", "last_run_at") &&
            hasColumn("local_cron_jobs", "last_status")
          );
        case 7:
          return hasColumn("conversations", "is_pinned");
        default:
          return false;
      }
    };

    // 按序执行 migration
    for (const [version, sql] of MIGRATIONS) {
      if (version > currentVersion) {
        if (isMigrationAlreadyApplied(version)) {
          continue;
        }
        db.exec(sql);
      }
    }

    // 更新版本号
    const now = new Date().toISOString();
    if (currentVersion === 0) {
      db.prepare(
        "INSERT INTO runtime_state (key, value, updated_at) VALUES ('schemaVersion', ?, ?)",
      ).run(String(SCHEMA_VERSION), now);
    } else {
      db.prepare(
        "UPDATE runtime_state SET value = ?, updated_at = ? WHERE key = 'schemaVersion'",
      ).run(String(SCHEMA_VERSION), now);
    }
  }
}

/**
 * 判断当前数据库是否像「刚创建的空库」（无会话与消息）。
 */
function isDatabaseLikelyEmpty(db: DatabaseAdapter): boolean {
  try {
    const conv = db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM conversations").get();
    const msg = db.prepare<{ c: number }>("SELECT COUNT(*) as c FROM messages").get();
    return (conv?.c ?? 0) === 0 && (msg?.c ?? 0) === 0;
  } catch {
    return false;
  }
}
