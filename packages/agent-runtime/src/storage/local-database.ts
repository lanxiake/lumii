/**
 * LocalDatabase — SQLite 连接管理 + Schema 迁移
 *
 * 使用 node:sqlite 的 DatabaseSync（Node 22.19+ / Electron 36 原生内建）。
 * 若 node:sqlite 不可用，回退到 better-sqlite3。
 */

import path from "node:path";
import fs from "node:fs";
import { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import { timeSql } from "./slow-query.js";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SQLite 忙等超时（毫秒）。
 * 默认 0 时第二连接写库（如云同步 SyncImporter）会立刻 SQLITE_BUSY / database is locked。
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * 主库与旁路连接（云同步等）共用的连接级 PRAGMA。
 */
export function sqliteConnectionPragmaStatements(): string[] {
  return [
    "PRAGMA journal_mode=WAL",
    "PRAGMA synchronous=NORMAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA wal_autocheckpoint=256",
    `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`,
  ];
}

/**
 * 对已打开的 SQLite 连接应用标准 PRAGMA（含 busy_timeout）。
 */
export function applySqliteConnectionPragmas(db: { exec(sql: string): void }): void {
  for (const sql of sqliteConnectionPragmaStatements()) {
    db.exec(sql);
  }
}

/**
 * 记录「当前实际使用的数据库路径」的指针文件路径
 *
 * 当主库路径被其他进程长期锁定（如残留的僵尸进程）时，每次启动都会轮转到新的
 * `.new-<ts>` 路径。若不记录上次轮转的目标，下次启动主库仍被锁定时会再轮转出
 * 一个新路径，永久遗弃上一次轮转路径中已经写入的会话数据。
 */
export function activePathPointerFile(dbPath: string): string {
  return `${dbPath}.active-path`;
}

/**
 * 读取指针文件，返回上次轮转的目标路径（文件必须仍存在才有效）
 */
export function readActivePathPointer(dbPath: string): string | null {
  try {
    const pointerFile = activePathPointerFile(dbPath);
    if (!fs.existsSync(pointerFile)) return null;
    const target = fs.readFileSync(pointerFile, "utf-8").trim();
    return target && fs.existsSync(target) ? target : null;
  } catch {
    return null;
  }
}

/**
 * 更新指针文件：实际路径 = 原路径时删除指针（恢复正常）；否则记录轮转目标
 */
export function writeActivePathPointer(dbPath: string, actualDbPath: string): void {
  try {
    const pointerFile = activePathPointerFile(dbPath);
    if (actualDbPath === dbPath) {
      if (fs.existsSync(pointerFile)) fs.unlinkSync(pointerFile);
    } else {
      fs.writeFileSync(pointerFile, actualDbPath, "utf-8");
    }
  } catch {
    // 指针文件写入失败不影响本次启动，只是下次可能多轮转一次
  }
}

/**
 * 将「确实损坏（且未被占用）」的数据库文件重命名为带时间戳的备份，
 * 允许应用在该路径上以空库启动、再由上层从 backups/ 恢复，避免无限崩溃。
 *
 * 关键约束：重命名失败即代表文件被其他进程占用（Windows EBUSY），这是**锁**而非损坏。
 * 此时必须抛错终止启动，绝不另起 `.new-<ts>` 空库 —— 那会把同一份历史劈成两条互不相见的
 * 时间线：应用继续往新库写，旧库原地冻结，等锁释放后又被静默切回旧库，中间写入全部丢失。
 */
export function rotateCorruptedDb(dbPath: string): void {
  const ts = Date.now();
  for (const ext of ["", "-wal", "-shm"]) {
    const src = dbPath + ext;
    try {
      if (fs.existsSync(src)) {
        fs.renameSync(src, `${dbPath}.corrupted-${ts}${ext}`);
      }
    } catch (err) {
      if (ext === "") {
        console.warn("[local-database] 无法重命名数据库文件，判定为文件被占用而非损坏:", err);
        throw new Error(
          `数据库文件被占用，无法轮转（${(err as Error).message}）。` +
            "可能有另一个 Lumii 实例仍在运行或未完全退出；请先彻底退出它再重试。",
        );
      }
    }
  }
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
const txnDepth = new WeakMap<DatabaseAdapter, number>();

export function withTransaction<R>(
  db: DatabaseAdapter,
  fn: () => R,
  begin = "BEGIN",
): R {
  // 可重入：SQLite 不支持嵌套事务，内层直接借用外层事务（外层回滚会一并撤销）
  const depth = txnDepth.get(db) ?? 0;
  if (depth > 0) {
    txnDepth.set(db, depth + 1);
    try {
      return fn();
    } finally {
      txnDepth.set(db, depth);
    }
  }

  db.exec(begin);
  txnDepth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    txnDepth.set(db, 0);
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
  applySqliteConnectionPragmas(db);
  const dbLabel = path.basename(dbPath);

  return {
    exec: (sql: string) => timeSql(dbLabel, "exec", sql, () => db.exec(sql)),
    prepare: <T = Record<string, unknown>>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: (...params: unknown[]) =>
          timeSql(dbLabel, "run", sql, () => stmt.run(...(params as any[])) as unknown as StatementResult),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get: (...params: unknown[]) =>
          timeSql(dbLabel, "get", sql, () => stmt.get(...(params as any[])) as T | undefined),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        all: (...params: unknown[]) =>
          timeSql(dbLabel, "all", sql, () => stmt.all(...(params as any[])) as T[]),
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
  // 与 node:sqlite 路径共用同一组 PRAGMA（含 busy_timeout）
  applySqliteConnectionPragmas({ exec: (sql) => db.exec(sql) });
  const dbLabel = path.basename(dbPath);

  return {
    exec: (sql: string) => timeSql(dbLabel, "exec", sql, () => db.exec(sql)),
    prepare: <T = Record<string, unknown>>(sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) =>
          timeSql(dbLabel, "run", sql, () => stmt.run(...params) as StatementResult),
        get: (...params: unknown[]) =>
          timeSql(dbLabel, "get", sql, () => stmt.get(...params) as T | undefined),
        all: (...params: unknown[]) => timeSql(dbLabel, "all", sql, () => stmt.all(...params) as T[]),
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
  /** 最多保留的备份数量，默认 10 */
  readonly backupMaxCount?: number;
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
    // 开库路径曾整体 3 秒，分段计时找出该动谁（与 bridge 的 [Startup] 前缀保持一致）
    const tDbOpen = performance.now();
    // 用 console.log 而不是 console.info：主进程的日志捕获器只收 log/warn/error，
    // info 不进文件（排查时踩过）
    const phase = (name: string) =>
      console.log(`[Startup] localdb.${name} ${(performance.now() - tDbOpen).toFixed(0)}ms`);

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

    // 实际打开的数据库路径。
    //
    // 「粘性指针」：一旦此前发生过损坏轮转，轮转出的路径就是数据的权威副本 ——
    // 原路径已被冻结，之后所有写入都落在轮转路径上。因此只要指针存在且目标仍在，
    // 就必须优先沿用它，**绝不因为原路径的锁已释放就静默切回去**：那会把轮转路径里
    // 更新的会话数据永久遗弃（2026-10-04 碧瑶会话当日丢失即由此产生）。
    const priorRotatedPath = readActivePathPointer(dbPath);
    if (priorRotatedPath) {
      console.warn(`[local-database] 检测到历史轮转路径，优先沿用: ${priorRotatedPath}`);
    }
    let actualDbPath = priorRotatedPath ?? dbPath;

    // Windows 下文件锁冲突（残留进程未完全退出、杀软/云同步短暂占用）与真正的磁盘损坏
    // 都会抛出同样的 SQLITE_IOERR，仅凭一次失败无法区分。给锁一个足够长的自然清除窗口：
    // 预算覆盖 SQLITE_BUSY_TIMEOUT_MS 并显著放宽（dev:restart 的残留进程可能占用数十秒），
    // 避免把「文件暂时被占用」误判为「损坏」而触发下面的轮转（会丢失最近数据）。
    const LOCK_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

    // 第 1 次尝试：直接打开（SQLite 会自动重放有效的 WAL 文件，保留已提交的变更）
    // ⚠️ 不在此处预先删除 WAL/SHM：若进程上次异常退出，WAL 中可能保存着已提交但
    //    尚未 checkpoint 的操作（如用户删除会话的 DELETE）。预先删 WAL 会丢失这些变更。
    try {
      this._db = await tryOpen(actualDbPath);
    } catch (err) {
      logSqliteErr("第1次打开失败", err);
      if (!isIoErr(err)) throw err;

      let recoveredFromLock = false;
      for (const delay of LOCK_RETRY_DELAYS_MS) {
        await sleep(delay);
        try {
          this._db = await tryOpen(actualDbPath);
          recoveredFromLock = true;
          console.info(`[local-database] 等待 ${delay}ms 后重试打开成功，判定为瞬时文件锁而非损坏`);
          break;
        } catch (retryErr) {
          logSqliteErr(`等待 ${delay}ms 后重试打开仍失败`, retryErr);
          if (!isIoErr(retryErr)) throw retryErr;
        }
      }

      if (!recoveredFromLock) {
        // 第 2 次尝试：IOERR → WAL/SHM 可能处于不一致状态，清理后重试
        // 仅在打开失败后才删 WAL，此时 WAL 已损坏，删除不会造成数据丢失
        tryDeleteWalFiles(actualDbPath);
        try {
          this._db = await tryOpen(actualDbPath);
        } catch (err2) {
          logSqliteErr("第2次打开失败（清理WAL后）", err2);
          if (!isIoErr(err2)) throw err2;

          // 若沿用的是历史轮转路径且它打不开，退一步试原始路径（它可能仍然完好）
          if (actualDbPath !== dbPath) {
            try {
              this._db = await tryOpen(dbPath);
              if (this._db) {
                actualDbPath = dbPath;
                console.warn(`[local-database] 轮转路径打不开，回退到原始路径: ${dbPath}`);
              }
            } catch (fallbackErr) {
              logSqliteErr("回退原始路径也失败", fallbackErr);
            }
          }

          if (!this._db) {
            // 第 3 次尝试：长重试 + 清 WAL 后仍打不开，才判定需要轮转。
            // rotateCorruptedDb 若因文件仍被占用而无法重命名，会直接抛错而不是另起空库 ——
            // 「锁」绝不能演变成「分叉出第二条时间线」。
            rotateCorruptedDb(actualDbPath);
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
      }
    }

    writeActivePathPointer(dbPath, actualDbPath);
    this._dbPath = actualDbPath;
    phase("1-adapter-ready");
    this.migrate();
    phase("2-migrated");

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

    // 上次是干净关闭 / 24 小时内已完整校验过 → 跳过全库扫描（356MB 实测 1.2–6.5 秒）。
    // 跳过时**不刷新时间戳**：否则每天重启一次就永远不会再校验，等于关掉了这项保护。
    if (!wasVerifiedRecently(actualDbPath)) {
      if (!verifyDatabaseIntegrity(dbForIntegrity)) {
        dbForIntegrity.close();
        this._db = null;
        this._dbPath = null;
        // 用 actualDbPath 而非 dbPath 恢复：本轮打开的可能是历史轮转路径，
        // 恢复到 dbPath 会让「当前正在用的库」保持损坏状态。
        if (recoveryDepth < maxRecovery && tryRestoreFromLatestBackup(actualDbPath, backupDir)) {
          await this.openWithRecovery(options, backupDir, recoveryDepth + 1);
          return;
        }
        throw new Error(
          "SQLite database failed integrity_check and could not be restored from backup.",
        );
      }
      // 只有真正跑过校验才起算 24 小时窗口
      writeCleanShutdownMarker(actualDbPath);
    }
    phase("3-integrity-checked")

    if (options.enableScheduledBackup !== false) {
      this._stopBackup?.();
      this._stopBackup = startScheduledDatabaseBackup({
        dbPath: actualDbPath,
        backupDir,
        maxBackupCount: options.backupMaxCount ?? 10,
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
      const closedPath = this._dbPath;
      try {
        this._db.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // 退出阶段 checkpoint 失败不阻断 close
      }
      this._db.close();
      this._db = null;
      this._dbPath = null;
      // 干净关闭标记：下次开库见到它就跳过全库完整性扫描（306MB 实测 1.6 秒）。
      // 崩溃/断电不会写这个标记，那种情况照旧做 quick_check。
      if (closedPath) writeCleanShutdownMarker(closedPath);
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
        case 12:
          return hasColumn("messages", "compacted_at");
        case 39:
          return hasColumn("wiki_sources", "user_path");
        case 41:
          return hasColumn("conversations", "channel_type");
        // V44 是重建表（RENAME → 建新 → 拷 → DROP）：重放一次不会报错，而是
        // 静默把已归因的 agent 维度全部压回 'unknown'——比报错更糟，所以必须守卫。
        case 44:
          return hasColumn("tool_usage_stats", "agent_id");
        // V53 在 SCHEMA_VERSION 仍写 52 期间就发布过，于是老库有两条到达路径：
        // 一条是从 ≤51 升上来时顺带跑过 V53（列已存在，版本却记成 52），另一条是
        // 早已停在 52、根本没跑过 V53。bump 到 53 后两条路径都会进到这里重放，
        // 靠本守卫按「列是否已存在」区分，避免前一条撞 duplicate column。
        case 53:
          return hasColumn("autonomous_satisfaction_scores", "task_summary");
        // V56 与 V44 同类：重建表（RENAME → 建新 → 拷 → DROP）。重放不会报错，
        // 但会把已经归因的 channel 全部压回 'unknown'，且把 tool_exposure_log 里
        // 已有的暴露记录「接管」到一个空表上——比报错更糟，必须守卫。
        //
        // 这里的「列已存在」判定之所以足够，是因为下面的迁移循环**整体在一个事务里**
        // （见 for 循环外的 `withTransaction`）。没有事务时，进程若死在
        // `CREATE TABLE … channel` 之后、`INSERT SELECT` 之前，本守卫会看到列存在而
        // 跳过迁移，把 340 行统计永久留在 `tool_usage_stats_v55` 里且**不报任何错**。
        case 56:
          return hasColumn("tool_usage_stats", "channel");
        // 纯新增列，重放会撞 duplicate column 直接抛错。本库历史上不缺
        // 「版本号没跟上、列却早就在」的先例（见 V53 注释），所以照样守卫。
        case 57:
          return hasColumn("local_cron_jobs", "origin_conversation_id");
        default:
          return false;
      }
    };

    // 按序执行 migration
    //
    // **整批在一个事务里**（用已有的 `withTransaction`，它带重入计数）：
    // 迁移是「RENAME → 建新 → 拷 → DROP」这种多语句序列，半途崩溃会留下一个
    // 既不是旧形态也不是新形态的库。而 `isMigrationAlreadyApplied` 靠「列是否存在」
    // 判断是否已应用——半成品恰好带着新列，于是下次启动会**跳过**它，数据永久留在
    // `*_v55` 临时表里且不报任何错（V56 实测：340 行统计会静默消失）。
    // SQLite 的 DDL 是事务性的，所以包一层就够。
    withTransaction(db, () => {
      for (const [version, sql] of MIGRATIONS) {
        if (version > currentVersion) {
          if (isMigrationAlreadyApplied(version)) {
            continue;
          }
          db.exec(sql);
        }
      }

      // 版本号与迁移同一个事务：否则「DDL 成功了、版本没写进去」会让下一轮重放。
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
    });
  }
}

/**
 * 判断当前数据库是否像「刚创建的空库」（无会话与消息）。
 */

/** 干净关闭标记的路径（与主库同目录，旁路文件）。 */
function cleanShutdownMarkerPath(dbPath: string): string {
  return `${dbPath}.clean-shutdown`;
}

/**
 * 距上次完整校验过了多久以内可以跳过。
 *
 * 为什么需要上限而不是「每次非正常退出都扫」：`quick_check` 要扫完 356MB，
 * 实测 1.2–6.5 秒且**同步阻塞主线程**（发生在窗口已显示之后的 S7.4 阶段，
 * 用户看到的就是 6 秒卡死）。dev 下频繁 taskkill、生产下崩溃都算「非正常退出」，
 * 于是几乎每次启动都付一遍。
 *
 * 24 小时内已经完整校验过一次，就认为「结构损坏的概率足够低」：
 * SQLite 自己在读取坏页时仍会抛错，这里放弃的只是「启动前主动发现」的提前量。
 */
const INTEGRITY_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function writeCleanShutdownMarker(dbPath: string): void {
  try {
    fs.writeFileSync(cleanShutdownMarkerPath(dbPath), String(Date.now()));
  } catch {
    // 写不进去只影响下次是否做完整校验，不影响正确性
  }
}

/**
 * 距上次**实际校验通过**（或正常关闭）是否还在 24 小时窗口内。
 *
 * 只读不删：跳过时不刷新窗口，避免「每天重启一次 ⇒ 永远不再校验」。
 * 时间戳只在校验真正跑过、以及 `close()` 正常退出时更新。
 */
function wasVerifiedRecently(dbPath: string): boolean {
  try {
    const marker = cleanShutdownMarkerPath(dbPath);
    if (!fs.existsSync(marker)) return false;
    const verifiedAt = Number(fs.readFileSync(marker, "utf-8").trim());
    return Number.isFinite(verifiedAt) && Date.now() - verifiedAt < INTEGRITY_RECHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

function isDatabaseLikelyEmpty(db: DatabaseAdapter): boolean {
  try {
    // 用 LIMIT 1 而不是 COUNT(*)：这里只问「有没有数据」，而 COUNT(*) 要扫全表——
    // 306MB 的 messages 上实测 1.7 秒，白压在开库路径上。
    const conv = db.prepare<{ one: number }>("SELECT 1 as one FROM conversations LIMIT 1").get();
    if (conv) return false;
    const msg = db.prepare<{ one: number }>("SELECT 1 as one FROM messages LIMIT 1").get();
    return msg === undefined;
  } catch {
    return false;
  }
}
