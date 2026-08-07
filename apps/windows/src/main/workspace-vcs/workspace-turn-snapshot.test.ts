import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
});
