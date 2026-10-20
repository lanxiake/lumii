/**
 * SQLite 自动备份与损坏恢复
 *
 * 默认每日本地时间凌晨 3 点备份，最多保留最近 10 次；主库损坏时尝试从最新备份恢复。
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseAdapter } from "./local-database.js";

/** 备份文件摘要（供设置页展示与手动恢复） */
export interface DatabaseBackupInfo {
  readonly fileName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

const BACKUP_SUFFIX = ".db.bak";

export interface ScheduledBackupOptions {
  /** 主库文件路径 */
  readonly dbPath: string;
  /** 备份目录（默认为数据库同级 backups/） */
  readonly backupDir: string;
  /** 最多保留的备份数量（按修改时间保留最近 N 个） */
  readonly maxBackupCount: number;
  /** 本地时间几点执行（0–23），默认 3 */
  readonly hourLocal?: number;
  /** 打开后立即执行一次备份（可选） */
  readonly backupOnOpen?: boolean;
  /** 数据库适配器引用，用于备份前执行 wal_checkpoint(FULL) */
  readonly db?: DatabaseAdapter;
}

const DEFAULT_MAX_BACKUP_COUNT = 10;

/**
 * 开库备份的最小间隔：24 小时内已有备份就跳过。
 *
 * 与每日定时备份配合——开库这份只为兜住「定时任务没跑成」，
 * 不需要每次启动都拷一遍几百 MB。
 */
const BACKUP_ON_OPEN_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 备份目录里是否存在 intervalMs 内生成的 .db.bak */
export function hasRecentBackup(backupDir: string, intervalMs: number): boolean {
  try {
    const newest = fs
      .readdirSync(backupDir)
      .filter((name) => name.startsWith('agent-runtime_') && name.endsWith('.db.bak'))
      .map((name) => fs.statSync(path.join(backupDir, name)).mtimeMs)
      .sort((a, b) => b - a)[0];
    return newest !== undefined && Date.now() - newest < intervalMs;
  } catch {
    // 目录不存在/不可读 → 当作没有备份，让它照常备份（宁可多备份一次）
    return false;
  }
}
const DEFAULT_HOUR = 3;

let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
let dailyInterval: ReturnType<typeof setInterval> | undefined;

/**
 * 开库完整性检查。
 *
 * 用 `quick_check` 而不是 `integrity_check`：后者要全库扫描（306MB 库实测数秒，
 * 直接压在启动关键路径上）。quick_check 跳过「索引内容与表内容是否一致」的逐行比对，
 * 仍然会发现结构性损坏——而对「要不要从备份恢复」这个决策来说，结构性损坏才是判据。
 *
 * 真要逐行全量校验时，直接 `db.prepare("PRAGMA integrity_check").get()`；
 * 封成函数没人调用只会变成死代码（曾被 knip 抓住）。
 */
export function verifyDatabaseIntegrity(db: DatabaseAdapter): boolean {
  const row = db.prepare<{ quick_check: string }>("PRAGMA quick_check").get();
  return row?.quick_check === "ok";
}

/**
 * 将当前数据库文件复制到备份目录，文件名含日期。
 *
 * 若传入 `db`，备份前先执行 `PRAGMA wal_checkpoint(FULL)`，确保 WAL 中已提交的
 * 事务全部合并回主库文件，避免备份出来的 .db 文件缺少最新数据。
 *
 * @returns 备份文件绝对路径；失败时返回 null
 */
export function runBackupNow(
  dbPath: string,
  backupDir: string,
  maxBackupCount: number = DEFAULT_MAX_BACKUP_COUNT,
  db?: DatabaseAdapter,
): string | null {
  try {
    if (!fs.existsSync(dbPath)) {
      return null;
    }
    // WAL checkpoint：将未刷盘的已提交事务合并回主库，保证备份文件完整
    if (db) {
      try {
        db.exec("PRAGMA wal_checkpoint(FULL)");
      } catch {
        // checkpoint 失败不阻断备份（只是备份可能缺少最近几条写入）
      }
    }
    fs.mkdirSync(backupDir, { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const name = `agent-runtime_${stamp}.db.bak`;
    const dest = path.join(backupDir, name);
    fs.copyFileSync(dbPath, dest);
    pruneOldBackups(backupDir, maxBackupCount);
    return dest;
  } catch {
    return null;
  }
}

/**
 * 仅保留备份目录中最近 maxBackupCount 个 .bak 文件，其余按修改时间从旧到新删除。
 */
export function pruneOldBackups(backupDir: string, maxBackupCount: number): void {
  if (!fs.existsSync(backupDir)) return;
  const keep = Math.max(1, maxBackupCount);
  const files: { readonly full: string; readonly mtimeMs: number }[] = [];
  for (const name of fs.readdirSync(backupDir)) {
    if (!name.endsWith(".bak")) continue;
    const full = path.join(backupDir, name);
    try {
      files.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
    } catch {
      /* ignore single file stat failure */
    }
  }
  if (files.length <= keep) return;
  // 按修改时间降序：保留前 keep 个，删除其余较旧的备份
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { full } of files.slice(keep)) {
    try {
      fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 删除 SQLite WAL/SHM 辅助文件
 *
 * 恢复或轮转损坏库前调用，避免旧 WAL 与备份主库不一致导致再次 I/O 错误。
 */
export function deleteSqliteSidecarFiles(dbPath: string): boolean {
  let deleted = false;
  for (const ext of ["-wal", "-shm"]) {
    const filePath = dbPath + ext;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleted = true;
      }
    } catch {
      // 忽略删除失败（文件被锁等极端情况）
    }
  }
  return deleted;
}

/**
 * 列出备份目录中所有 .db.bak 文件（按修改时间降序）。
 */
export function listDatabaseBackups(backupDir: string): DatabaseBackupInfo[] {
  try {
    if (!fs.existsSync(backupDir)) return [];
    const items: DatabaseBackupInfo[] = [];
    for (const name of fs.readdirSync(backupDir)) {
      if (!name.endsWith(BACKUP_SUFFIX)) continue;
      const filePath = path.join(backupDir, name);
      try {
        const st = fs.statSync(filePath);
        items.push({
          fileName: name,
          filePath,
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      } catch {
        /* ignore single file stat failure */
      }
    }
    return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch {
    return [];
  }
}

/**
 * 删除备份目录中的指定 .db.bak 文件（防止路径穿越，仅允许删除备份目录内文件）。
 *
 * @returns 是否成功删除
 */
export function deleteDatabaseBackup(backupDir: string, fileName: string): boolean {
  const baseName = path.basename(fileName);
  if (!baseName.endsWith(BACKUP_SUFFIX) || baseName !== fileName) {
    return false;
  }
  const filePath = path.join(backupDir, baseName);
  const relative = path.relative(path.resolve(backupDir), path.resolve(filePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将指定备份文件复制覆盖主库路径（主进程应在关闭 DB 连接后调用）。
 *
 * @returns 是否成功恢复
 */
export function restoreDatabaseFromBackup(dbPath: string, backupFilePath: string): boolean {
  try {
    if (!fs.existsSync(backupFilePath)) return false;
    deleteSqliteSidecarFiles(dbPath);
    fs.copyFileSync(backupFilePath, dbPath);
    deleteSqliteSidecarFiles(dbPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 将目录内最新的 .bak 复制覆盖主库路径（主进程应在关闭 DB 连接后调用）。
 *
 * @returns 是否成功恢复
 */
export function tryRestoreFromLatestBackup(dbPath: string, backupDir: string): boolean {
  const backups = listDatabaseBackups(backupDir);
  if (backups.length === 0) return false;
  return restoreDatabaseFromBackup(dbPath, backups[0]!.filePath);
}

/**
 * 判断备份目录是否存在可用备份（修改时间最新的文件）。
 */
export function findLatestBackupPath(backupDir: string): string | null {
  const backups = listDatabaseBackups(backupDir);
  return backups[0]?.filePath ?? null;
}

/**
 * 计算到本地时间「次日 hour:00:00」或「今日若未到 hour」的毫秒数（用于首次调度）。
 */
function msUntilNextLocalHour(hour: number): number {
  const h = Math.min(23, Math.max(0, hour));
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * 启动每日定时备份；返回停止函数。
 */
export function startScheduledDatabaseBackup(opts: ScheduledBackupOptions): () => void {
  stopScheduledDatabaseBackup();

  const backupDir = opts.backupDir;
  const maxCount = opts.maxBackupCount ?? DEFAULT_MAX_BACKUP_COUNT;
  const hour = opts.hourLocal ?? DEFAULT_HOUR;

  const run = () => {
    runBackupNow(opts.dbPath, backupDir, maxCount, opts.db);
    pruneOldBackups(backupDir, maxCount);
  };

  // 开库备份只在「今天还没有备份」时做。
  //
  // 原来每次都无条件 run()：主库 306MB 时，`fs.copyFileSync` 同步拷贝要 8 秒，
  // 直接把启动主线程钉住（2026-10-20 实测 bridge.initialize 9.4 秒里 8 秒在这里）。
  // 而下面本来就有每日定时备份，开库备份只需要兜住「定时任务没跑成」的场景。
  if (opts.backupOnOpen && !hasRecentBackup(backupDir, BACKUP_ON_OPEN_MIN_INTERVAL_MS)) {
    run();
  }

  scheduledTimer = setTimeout(() => {
    run();
    dailyInterval = setInterval(run, 24 * 60 * 60 * 1000);
  }, msUntilNextLocalHour(hour));

  return stopScheduledDatabaseBackup;
}

/**
 * 停止定时备份（应用退出时调用）。
 */
export function stopScheduledDatabaseBackup(): void {
  if (scheduledTimer !== undefined) {
    clearTimeout(scheduledTimer);
    scheduledTimer = undefined;
  }
  if (dailyInterval !== undefined) {
    clearInterval(dailyInterval);
    dailyInterval = undefined;
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
