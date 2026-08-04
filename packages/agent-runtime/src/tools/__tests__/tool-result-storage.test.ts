import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { persistLargeResult } from "../tool-result-storage.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "trs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("persistLargeResult", () => {
  it("低于阈值 → 原样返回，不落盘", () => {
    const text = "short output";
    const out = persistLargeResult(text, { toolName: "bash", baseDir: dir, threshold: 100 });
    expect(out.persisted).toBe(false);
    expect(out.text).toBe(text);
    expect(out.filePath).toBeUndefined();
  });

  it("超过阈值 → 落盘并返回预览 + 路径", () => {
    const text = "x".repeat(500);
    const out = persistLargeResult(text, {
      toolName: "bash",
      baseDir: dir,
      threshold: 100,
      previewLength: 50,
    });
    expect(out.persisted).toBe(true);
    expect(out.filePath).toBeDefined();
    expect(existsSync(out.filePath!)).toBe(true);
    // 落盘文件含完整内容
    expect(readFileSync(out.filePath!, "utf8")).toBe(text);
    // 上下文文本含预览 + 路径提示
    expect(out.text).toContain("x".repeat(50));
    expect(out.text).toContain(out.filePath!);
    expect(out.text).toContain("输出过长");
    expect(out.text.length).toBeLessThan(text.length);
  });

  it("文件名包含工具名、时间戳与哈希", () => {
    const text = "y".repeat(300);
    const out = persistLargeResult(text, { toolName: "web_fetch", baseDir: dir, threshold: 100 });
    const fileName = path.basename(out.filePath!);
    expect(fileName).toMatch(/^web_fetch-\d+-[0-9a-f]{8}\.txt$/);
  });

  it("工具名中的非法字符被替换", () => {
    const text = "z".repeat(300);
    const out = persistLargeResult(text, {
      toolName: "mcp:weird/tool",
      baseDir: dir,
      threshold: 100,
    });
    const fileName = path.basename(out.filePath!);
    expect(fileName).toMatch(/^mcp_weird_tool-/);
  });

  it("边界：恰好等于阈值 → 不落盘", () => {
    const text = "a".repeat(100);
    const out = persistLargeResult(text, { toolName: "bash", baseDir: dir, threshold: 100 });
    expect(out.persisted).toBe(false);
  });
});
