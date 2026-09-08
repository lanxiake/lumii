/**
 * LocalDatabase 轮转指针单测
 *
 * 覆盖：主库路径持续被锁定时，重启不应遗弃上次轮转路径已写入的数据。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activePathPointerFile,
  applySqliteConnectionPragmas,
  readActivePathPointer,
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
