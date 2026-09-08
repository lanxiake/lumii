/**
 * file_write 工具单测 —— 超长内容分段写入
 *
 * 回归场景：模型一次性输出超大 content（写长文档）时，单次 tool call 的 arguments
 * 可能超限被截断，导致上游裸 JSON.parse 抛错整轮失败。分段写入让「内容超阈值时逐块
 * 落盘」成为稳定路径，从源头避免单次 arguments 超长。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionContext } from "../../types/tool.js";
import { fileWriteToolConfig } from "./file-write-tool.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function makeContext(cwd: string): ToolExecutionContext {
  // 用真实文件系统做回读验证，覆盖分段写入的写读往返
  return {
    getCwd: () => cwd,
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: async (p: string, data: string) => fs.writeFileSync(p, data, "utf-8"),
    glob: async () => [],
    grep: async () => [],
    fetch: async () => ({ status: 200, body: "" }),
  };
}

describe("file_write 工具", () => {
  let cwd: string;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-file-write-"));
    ctx = makeContext(cwd);
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("覆盖写入正常内容并回读验证通过", async () => {
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "a.txt", content: "hello" },
      ctx,
    );
    expect(textOf(result)).toContain("File written:");
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf-8")).toBe("hello");
  });

  it("超长内容分段写入后全文一致", async () => {
    // 造一段 > 阈值、且跨换行的长文本（> 32K 字符）
    const line = "段" + "x".repeat(2_000) + "\n";
    const content = line.repeat(20); // ~40K 字符
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "big.md", content },
      ctx,
    );
    expect(textOf(result)).toContain("File written:");
    expect(fs.readFileSync(path.join(cwd, "big.md"), "utf-8")).toBe(content);
  });

  it("分段写入在结果文本中标注 segments", async () => {
    const line = "段" + "x".repeat(2_000) + "\n";
    const content = line.repeat(20);
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "big.md", content },
      ctx,
    );
    expect(textOf(result)).toContain("segments");
  });

  it("append 模式仍能正常追加", async () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "first");
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "a.txt", content: "-second", mode: "append" },
      ctx,
    );
    expect(textOf(result)).toContain("File appended:");
    // 原文 "first" 不以换行结尾，append 会补 "\n" 再接新内容（工具既有语义）
    expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf-8")).toBe("first\n-second");
  });
});
