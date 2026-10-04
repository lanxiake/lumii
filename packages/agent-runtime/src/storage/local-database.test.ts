/**
 * LocalDatabase 轮转指针单测
 *
 * 覆盖：主库路径持续被锁定时，重启不应遗弃上次轮转路径已写入的数据。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activePathPointerFile,
  applySqliteConnectionPragmas,
  LocalDatabase,
  readActivePathPointer,
  rotateCorruptedDb,
  SQLITE_BUSY_TIMEOUT_MS,
  sqliteConnectionPragmaStatements,
  writeActivePathPointer,
} from "./local-database.js";

describe("sqlite connection pragmas", () => {
  /**
   * 多连接争用时（如云同步另开 DatabaseSync），无 busy_timeout 会立刻 SQLITE_BUSY。
   */
  it("连接 PRAGMA 列表包含 busy_timeout", () => {
    expect(sqliteConnectionPragmaStatements()).toContain(
      `PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`,
    );
  });

  it("applySqliteConnectionPragmas 会执行 busy_timeout", () => {
    const calls: string[] = [];
    applySqliteConnectionPragmas({ exec: (sql) => calls.push(sql) });
    expect(calls).toContain(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
  });
});

describe("active-path pointer", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtbot-localdb-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("写入轮转路径后可读回，等于原路径时清除指针", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    const rotatedPath = path.join(dir, "agent-runtime.db.new-123");
    fs.writeFileSync(rotatedPath, "rotated-content");

    writeActivePathPointer(dbPath, rotatedPath);
    expect(readActivePathPointer(dbPath)).toBe(rotatedPath);

    writeActivePathPointer(dbPath, dbPath);
    expect(fs.existsSync(activePathPointerFile(dbPath))).toBe(false);
    expect(readActivePathPointer(dbPath)).toBeNull();
  });

  it("指针指向的文件已不存在时返回 null（避免复用已被清理的路径）", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    const rotatedPath = path.join(dir, "agent-runtime.db.new-456");
    // 不创建 rotatedPath 文件本身
    writeActivePathPointer(dbPath, rotatedPath);

    expect(readActivePathPointer(dbPath)).toBeNull();
  });

  it("从未轮转过时读取返回 null", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    expect(readActivePathPointer(dbPath)).toBeNull();
  });
});

describe("rotateCorruptedDb 锁与损坏分离", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtbot-localdb-rotate-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件被占用（重命名失败）时抛错，绝不另起 .new 空库", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    fs.writeFileSync(dbPath, "locked");

    // 模拟 Windows EBUSY：rename 直接失败
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EBUSY: resource busy or locked");
    });

    expect(() => rotateCorruptedDb(dbPath)).toThrow(/被占用/);

    // 关键断言：不得遗留 `.new-<ts>` 分叉库
    expect(fs.readdirSync(dir).some((f) => f.includes(".new-"))).toBe(false);
  });

  it("文件未被占用时正常重命名到 .corrupted-<ts>", () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    fs.writeFileSync(dbPath, "corrupt");

    expect(() => rotateCorruptedDb(dbPath)).not.toThrow();
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("agent-runtime.db.corrupted-"))).toBe(true);
  });
});

describe("LocalDatabase 粘性指针", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtbot-localdb-sticky-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function openOptions(dbPath: string, backupDir: string) {
    return { dbPath, backupDirectory: backupDir, enableScheduledBackup: false, backupOnOpen: false };
  }

  it("指针存在时优先打开轮转路径，而不是原始路径（避免遗弃更新的数据）", async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    const rotatedPath = path.join(dir, "agent-runtime.db.new-999");
    // 空文件即可作为可打开的空库；只需验证「选了哪条路径」
    fs.writeFileSync(dbPath, "");
    fs.writeFileSync(rotatedPath, "");
    writeActivePathPointer(dbPath, rotatedPath);

    const ldb = new LocalDatabase();
    try {
      await ldb.open(openOptions(dbPath, path.join(dir, "backups")));
      expect(ldb.dbPath).toBe(rotatedPath);
    } finally {
      ldb.close();
    }
  });

  it("无指针时打开原始路径", async () => {
    const dir = makeTmpDir();
    const dbPath = path.join(dir, "agent-runtime.db");
    fs.writeFileSync(dbPath, "");

    const ldb = new LocalDatabase();
    try {
      await ldb.open(openOptions(dbPath, path.join(dir, "backups")));
      expect(ldb.dbPath).toBe(dbPath);
    } finally {
      ldb.close();
    }
  });
});
