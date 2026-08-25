/**
 * Wiki 摄入读文件的路径收窄与前缀读取。
 * 重点是越界拒绝——摄入路径来自工具参数，不是可信输入。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWikiReadablePath, readTextPrefix } from "./wiki-text-reader";

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "wiki-reader-"));
  mkdirSync(path.join(root, "outputs"), { recursive: true });
  writeFileSync(path.join(root, "outputs", "a.md"), "工作区内的正文", "utf8");
  writeFileSync(path.join(root, "big.txt"), "x".repeat(1000), "utf8");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveWikiReadablePath", () => {
  it("放行工作区内的相对路径", () => {
    expect(resolveWikiReadablePath("outputs/a.md", root)).toBe(path.resolve(root, "outputs/a.md"));
  });

  it("放行工作区内的绝对路径", () => {
    const abs = path.join(root, "outputs", "a.md");
    expect(resolveWikiReadablePath(abs, root)).toBe(path.resolve(abs));
  });

  it("拒绝 .. 逃逸出工作区", () => {
    expect(resolveWikiReadablePath("../outside.md", root)).toBeNull();
    expect(resolveWikiReadablePath("outputs/../../outside.md", root)).toBeNull();
  });

  it("拒绝工作区外的绝对路径", () => {
    expect(resolveWikiReadablePath(path.join(tmpdir(), "elsewhere.md"), root)).toBeNull();
  });

  it("拒绝非文本扩展名，即使在工作区内", () => {
    expect(resolveWikiReadablePath("outputs/a.pdf", root)).toBeNull();
    expect(resolveWikiReadablePath("outputs/secret.pem", root)).toBeNull();
  });
});

describe("readTextPrefix", () => {
  it("读出完整内容", async () => {
    const text = await readTextPrefix(path.join(root, "outputs", "a.md"), 200 * 1024);
    expect(text).toBe("工作区内的正文");
  });

  it("超过上限时只取前缀", async () => {
    const text = await readTextPrefix(path.join(root, "big.txt"), 100);
    expect(text).toHaveLength(100);
  });
});
