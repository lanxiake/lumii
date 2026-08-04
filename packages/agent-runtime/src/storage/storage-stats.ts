/**
 * 本地存储统计与全量导出（JSON Lines）
 *
 * 供 Electron 设置页展示占用、表行数，以及「导出全部数据」。
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseAdapter } from "./local-database.js";
import { AUTO_VACUUM_THRESHOLD_BYTES } from "../config/storage.js";
import { listDatabaseBackups } from "./backup.js";

/** 各表行数与文件体积摘要 */
export interface LocalStorageStats {
  readonly dbPath: string;
  readonly fileSizeBytes: number;
  readonly tableRowCounts: Readonly<Record<string, number>>;
  readonly conversationCount: number;
  readonly messageCount: number;
  /** 备份目录绝对路径 */
  readonly backupDir: string;
  /** 可用备份文件数量 */
  readonly backupCount: number;
  /** 最新备份时间（ISO），无备份时为 null */
  readonly latestBackupAt: string | null;
}

const TABLE_NAMES = [
  "conversations",
  "conversation_participants",
  "messages",
  "agent_memories",
  "agent_definition_cache",
  "tasks",
  "tool_audit_log",
  "runtime_state",
] as const;

/**
 * 统计 SQLite 文件大小及各表行数。
 */
export function getLocalStorageStats(db: DatabaseAdapter, dbPath: string): LocalStorageStats {
  let fileSizeBytes = 0;
  try {
    const st = fs.statSync(dbPath);
    fileSizeBytes = st.size;
  } catch {
    fileSizeBytes = 0;
  }

  const tableRowCounts: Record<string, number> = {};
  for (const name of TABLE_NAMES) {
    const row = db.prepare<{ c: number }>(`SELECT COUNT(*) as c FROM ${quoteIdent(name)}`).get();
    tableRowCounts[name] = row?.c ?? 0;
  }

  const backupDir = path.join(path.dirname(dbPath), "backups");
  const backups = listDatabaseBackups(backupDir);

  return {
    dbPath,
    fileSizeBytes,
    tableRowCounts,
    conversationCount: tableRowCounts.conversations ?? 0,
    messageCount: tableRowCounts.messages ?? 0,
    backupDir,
    backupCount: backups.length,
    latestBackupAt: backups[0]?.modifiedAt ?? null,
  };
}

/**
 * 若数据库文件超过阈值则执行 VACUUM（需在无长事务时调用）。
 *
 * @returns 是否执行了 VACUUM
 */
export function maybeRunAutoVacuumSync(db: DatabaseAdapter, dbPath: string): boolean {
  let size = 0;
  try {
    size = fs.statSync(dbPath).size;
  } catch {
    return false;
  }
  if (size < AUTO_VACUUM_THRESHOLD_BYTES) {
    return false;
  }
  db.exec("VACUUM");
  return true;
}

/**
 * 将会话与消息导出为 JSON Lines（每行一个 JSON 对象，含 type 字段区分）。
 */
export function exportLocalDataAsJSONL(db: DatabaseAdapter): string {
  const lines: string[] = [];

  const convs = db
    .prepare<Record<string, unknown>>("SELECT * FROM conversations ORDER BY created_at")
    .all();
  for (const row of convs) {
    lines.push(JSON.stringify({ type: "conversation", ...row }));
  }

  const parts = db
    .prepare<Record<string, unknown>>("SELECT * FROM conversation_participants")
    .all();
  for (const row of parts) {
    lines.push(JSON.stringify({ type: "conversation_participant", ...row }));
  }

  const msgs = db
    .prepare<Record<string, unknown>>("SELECT * FROM messages ORDER BY timestamp")
    .all();
  for (const row of msgs) {
    lines.push(JSON.stringify({ type: "message", ...row }));
  }

  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid table name: ${name}`);
  }
  return name;
}
