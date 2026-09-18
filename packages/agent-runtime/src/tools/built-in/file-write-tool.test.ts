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

  // ── range 模式（2026-09-18 批次 2 补：这个分支此前零覆盖） ──
  //
  // 为什么单独补：场景 7 核实过 range **零测试、零使用**（日志里 `mode:"range"` 0 次），
  // 但它的保护是**有的**——`read-before-write` hook 只豁免 `append`，
  // 所以文件被外部改过时 range 照样会被拦。缺的是覆盖，不是机制。
  // 这里测工具自身的行为，hook 的行为由 hook 自己的测试守。

  it("range：替换指定行范围（startLine/endLine 都是 1-based 且含端点）", async () => {
    fs.writeFileSync(path.join(cwd, "r.txt"), "a\nb\nc\nd\ne\n");
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "r.txt", content: "X\nY", mode: "range", startLine: 2, endLine: 3 },
      ctx,
    );
    expect(textOf(result)).toContain("File range written:");
    // 第 2、3 行（b、c）被换成 X、Y；首尾保留
    expect(fs.readFileSync(path.join(cwd, "r.txt"), "utf-8")).toBe("a\nX\nY\nd\ne\n");
  });

  it("range：省略 endLine 时替换到文件末尾", async () => {
    fs.writeFileSync(path.join(cwd, "r2.txt"), "keep1\nkeep2\ndrop1\ndrop2\n");
    await fileWriteToolConfig.execute(
      "t1",
      { filePath: "r2.txt", content: "tail", mode: "range", startLine: 3 },
      ctx,
    );
    // 实测：结果**不带**尾换行——`newContent.split("\n")` 对 "tail" 得 ["tail"]（无末尾空串），
    // 而原文件尾部的那个空串随 tail 一起被丢弃。记录真实行为，不按直觉写。
    expect(fs.readFileSync(path.join(cwd, "r2.txt"), "utf-8")).toBe("keep1\nkeep2\ntail");
  });

  it("range：文件不存在时从空内容开始（不抛错）", async () => {
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "brand-new.txt", content: "hello", mode: "range", startLine: 1 },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(cwd, "brand-new.txt"), "utf-8")).toBe("hello");
  });

  it("range：startLine 越界（超出文件长度）时追加在末尾，不抛错", async () => {
    fs.writeFileSync(path.join(cwd, "r3.txt"), "only\n");
    const result = await fileWriteToolConfig.execute(
      "t1",
      { filePath: "r3.txt", content: "appended", mode: "range", startLine: 99 },
      ctx,
    );
    // 记录当前行为：越界**不报错**，head 取到全文 → 等价于追加；
    // 但因原文件尾部有空行，`"only\n".split("\n")` 得 ["only", ""]，那个空串留在 head 里，
    // 于是结果**多出一个空行**（实测 "only\n\nappended"，不是直觉上的 "only\nappended"）。
    // 这是 Math.max/Math.min 夹取 + split 语义的自然结果，不是刻意设计——
    // 记下来，免得将来有人（或模型自己）以为它是"追加"的预期行为。
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(cwd, "r3.txt"), "utf-8")).toBe("only\n\nappended");
  });
});
