/**
 * SQLite 备份与恢复单元测试
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteDatabaseBackup,
  deleteSqliteSidecarFiles,
  listDatabaseBackups,
  restoreDatabaseFromBackup,
  tryRestoreFromLatestBackup,
} from "./backup.js";

describe("backup", () => {
  const tmpDirs: string[] = [];

  /**
   * 创建临时目录并在测试结束后清理
   */
  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtbot-backup-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("listDatabaseBackups 按修改时间降序返回 .db.bak 文件", () => {
    const dir = makeTmpDir();
    const older = path.join(dir, "agent-runtime_2026-01-01_00-00-00.db.bak");
    const newer = path.join(dir, "agent-runtime_2026-06-29_12-00-00.db.bak");
    fs.writeFileSync(older, "old");
    fs.writeFileSync(newer, "newer-content");

    const olderTime = Date.now() - 60_000;
    fs.utimesSync(older, olderTime / 1000, olderTime / 1000);

    const list = listDatabaseBackups(dir);
    expect(list).toHaveLength(2);
    expect(list[0]!.fileName).toBe("agent-runtime_2026-06-29_12-00-00.db.bak");
  });

  it("restoreDatabaseFromBackup 覆盖主库并清理 WAL/SHM", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    const backupPath = path.join(dir, "backup.db.bak");
    fs.writeFileSync(dbPath, "corrupted");
    fs.writeFileSync(`${dbPath}-wal`, "wal");
    fs.writeFileSync(`${dbPath}-shm`, "shm");
    fs.writeFileSync(backupPath, "restored-db-content");

    const ok = restoreDatabaseFromBackup(dbPath, backupPath);
    expect(ok).toBe(true);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("restored-db-content");
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("tryRestoreFromLatestBackup 使用最新备份", () => {
    const dir = makeTmpDir();
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir);
    const dbPath = path.join(dir, "agent-runtime.db");
    fs.writeFileSync(dbPath, "broken");

    const older = path.join(backupDir, "agent-runtime_2026-01-01_00-00-00.db.bak");
    const newer = path.join(backupDir, "agent-runtime_2026-06-29_12-00-00.db.bak");
    fs.writeFileSync(older, "old-backup");
    fs.writeFileSync(newer, "latest-backup");
    const olderTime = Date.now() - 120_000;
    fs.utimesSync(older, olderTime / 1000, olderTime / 1000);

    expect(tryRestoreFromLatestBackup(dbPath, backupDir)).toBe(true);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("latest-backup");
  });

  it("deleteSqliteSidecarFiles 删除 wal/shm", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    fs.writeFileSync(`${dbPath}-wal`, "wal");
    fs.writeFileSync(`${dbPath}-shm`, "shm");
    expect(deleteSqliteSidecarFiles(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("deleteDatabaseBackup 删除指定备份并拒绝路径穿越", () => {
    const dir = makeTmpDir();
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(backupDir);
    const target = path.join(backupDir, "agent-runtime_2026-06-29_12-00-00.db.bak");
    fs.writeFileSync(target, "backup");

    expect(deleteDatabaseBackup(backupDir, "agent-runtime_2026-06-29_12-00-00.db.bak")).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(deleteDatabaseBackup(backupDir, "../escape.db.bak")).toBe(false);
    expect(deleteDatabaseBackup(backupDir, "not-a-backup.txt")).toBe(false);
  });
});
