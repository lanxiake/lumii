import { describe, it, expect, beforeEach } from "vitest";
import {
  FileStateCache,
  getFileStateCache,
  normalizeFilePathKey,
  _clearFileStateRegistry,
} from "../file-state-cache.js";

describe("FileStateCache", () => {
  beforeEach(() => {
    _clearFileStateRegistry();
  });

  it("set/get 基本读写", () => {
    const cache = new FileStateCache();
    cache.set("/a/b.txt", { mtimeMs: 100, offset: 1, limit: 500 });
    const entry = cache.get("/a/b.txt");
    expect(entry?.mtimeMs).toBe(100);
    expect(entry?.offset).toBe(1);
  });

  it("路径归一化：分隔符与 .. 段命中同一条", () => {
    const cache = new FileStateCache();
    cache.set("/a/b/../c.txt", { mtimeMs: 5 });
    expect(cache.get("/a/c.txt")?.mtimeMs).toBe(5);
  });

  it("Windows 大小写不敏感（仅 win32 平台断言归一化小写）", () => {
    const key = normalizeFilePathKey("C:\\A\\B.txt");
    if (process.platform === "win32") {
      expect(key).toBe(key.toLowerCase());
    }
  });

  it("LRU 条数上限：超过 maxEntries 驱逐最旧", () => {
    const cache = new FileStateCache(3, 1024 * 1024);
    cache.set("/1", { mtimeMs: 1 });
    cache.set("/2", { mtimeMs: 2 });
    cache.set("/3", { mtimeMs: 3 });
    cache.set("/4", { mtimeMs: 4 }); // 触发驱逐 /1
    expect(cache.get("/1")).toBeUndefined();
    expect(cache.get("/4")?.mtimeMs).toBe(4);
    expect(cache.size).toBe(3);
  });

  it("LRU 触达后不被优先驱逐", () => {
    const cache = new FileStateCache(2, 1024 * 1024);
    cache.set("/1", { mtimeMs: 1 });
    cache.set("/2", { mtimeMs: 2 });
    cache.get("/1"); // 触达 /1 → 移到末尾
    cache.set("/3", { mtimeMs: 3 }); // 驱逐最旧 = /2
    expect(cache.get("/2")).toBeUndefined();
    expect(cache.get("/1")?.mtimeMs).toBe(1);
  });

  it("delete/clear", () => {
    const cache = new FileStateCache();
    cache.set("/a", { mtimeMs: 1 });
    cache.delete("/a");
    expect(cache.get("/a")).toBeUndefined();
    cache.set("/b", { mtimeMs: 2 });
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("getFileStateCache 按 instanceId 隔离", () => {
    const a = getFileStateCache("inst-a");
    const b = getFileStateCache("inst-b");
    a.set("/x", { mtimeMs: 1 });
    expect(b.get("/x")).toBeUndefined();
    expect(getFileStateCache("inst-a")).toBe(a);
  });
});
