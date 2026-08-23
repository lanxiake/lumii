import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffTurnSnapshots } from "@mtbot/agent-runtime";
import { captureWorkspaceTurnSnapshot } from "./workspace-turn-snapshot";

describe("captureWorkspaceTurnSnapshot", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-snap-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("捕获相对路径 hash；忽略 node_modules；支持净变更", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "v1");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x.js"), "lib");

    const start = await captureWorkspaceTurnSnapshot(dir);
    expect(start.has("a.ts")).toBe(true);
    expect([...start.keys()].some((k) => k.includes("node_modules"))).toBe(false);

    fs.writeFileSync(path.join(dir, "a.ts"), "v2");
    fs.writeFileSync(path.join(dir, "b.ts"), "new");
    // 临时文件：创建又删除，不应出现在 end 快照
    fs.writeFileSync(path.join(dir, "_transient.ts"), "gone");
    fs.unlinkSync(path.join(dir, "_transient.ts"));

    const end = await captureWorkspaceTurnSnapshot(dir);
    const diff = diffTurnSnapshots(start, end);
    expect(diff).toEqual([
      { path: "b.ts", status: "added" },
      { path: "a.ts", status: "modified" },
    ]);
  });

  it("跳过 VCS_SKIP_DIRS 与 uploads 大文件模式", async () => {
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref");
    fs.mkdirSync(path.join(dir, "tmp"));
    fs.writeFileSync(path.join(dir, "tmp", "cache.txt"), "x");
    fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(dir, "uploads", "big.pdf"), "pdf");
    fs.writeFileSync(path.join(dir, "readme.md"), "ok");

    const snap = await captureWorkspaceTurnSnapshot(dir);
    expect(snap.has("readme.md")).toBe(true);
    expect([...snap.keys()].some((k) => k.includes(".git"))).toBe(false);
    expect([...snap.keys()].some((k) => k.startsWith("tmp/"))).toBe(false);
    expect(snap.has("uploads/big.pdf")).toBe(false);
  });

  it("workspaceDir 不存在时抛错", async () => {
    await expect(
      captureWorkspaceTurnSnapshot(path.join(dir, "missing")),
    ).rejects.toThrow();
  });

  it("readdir 失败时拒绝整个快照而非返回空 Map", async () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "v1");
    fs.mkdirSync(path.join(dir, "subdir"));
    fs.writeFileSync(path.join(dir, "subdir", "b.ts"), "v2");

    const subdir = path.join(dir, "subdir");
    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, "readdir").mockImplementation(((
      target: fs.PathLike,
      options: { withFileTypes: true },
    ) => {
      if (String(target) === subdir) {
        return Promise.reject(new Error("EACCES: permission denied"));
      }
      return originalReaddir(target as string, options);
    }) as typeof fs.promises.readdir);

    await expect(captureWorkspaceTurnSnapshot(dir)).rejects.toThrow(
      /读取工作区目录失败/,
    );
  });

  it("大量文件时异步遍历不长时间阻塞事件循环", async () => {
    for (let i = 0; i < 120; i++) {
      fs.writeFileSync(path.join(dir, `file-${i}.txt`), `content-${i}`);
    }

    let tickFired = false;
    const timer = setImmediate(() => {
      tickFired = true;
    });

    const snap = await captureWorkspaceTurnSnapshot(dir);

    expect(snap.size).toBe(120);
    // 遍历内部本身通过 setImmediate 让出事件循环，
    // 一个并发调度的 setImmediate 回调应有机会在快照完成前触发。
    expect(tickFired).toBe(true);
    clearImmediate(timer);
  });
});
