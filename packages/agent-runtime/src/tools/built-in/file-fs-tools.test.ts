/**
 * list_dir / file_mkdir / file_move / file_copy 行为测试
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionContext } from "../../types/tool.js";
import { fileCopyToolConfig } from "./file-copy-tool.js";
import { fileMkdirToolConfig } from "./file-mkdir-tool.js";
import { fileMoveToolConfig } from "./file-move-tool.js";
import { listDirToolConfig } from "./list-dir-tool.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function mockContext(cwd: string, allowedRoots?: readonly string[]): ToolExecutionContext {
  return {
    getCwd: () => cwd,
    ...(allowedRoots ? { getAllowedRoots: () => allowedRoots } : {}),
    executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    writeFile: async () => {},
    glob: async () => [],
    grep: async () => [],
    fetch: async () => ({ status: 200, body: "" }),
  };
}

describe("workspace 文件结构工具", () => {
  let cwd: string;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-fs-tools-"));
    ctx = mockContext(cwd);
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  describe("list_dir", () => {
    it("用 [FILE]/[DIR] 前缀列出一层内容", async () => {
      fs.mkdirSync(path.join(cwd, "docs"));
      fs.writeFileSync(path.join(cwd, "readme.md"), "hi");

      const result = await listDirToolConfig.execute("t1", { path: "." }, ctx);
      const text = textOf(result);

      expect(text).toContain("[DIR] docs");
      expect(text).toContain("[FILE] readme.md");
    });

    it("拒绝越出工作空间的路径", async () => {
      await expect(listDirToolConfig.execute("t1", { path: ".." }, ctx)).rejects.toThrow(
        /不在允许范围内/,
      );
    });
  });

  describe("file_mkdir", () => {
    it("递归创建目录且已存在时不报错", async () => {
      const result = await fileMkdirToolConfig.execute("t1", { path: "a/b/c" }, ctx);
      expect(textOf(result)).toMatch(/created directory/i);
      expect(fs.statSync(path.join(cwd, "a/b/c")).isDirectory()).toBe(true);

      const again = await fileMkdirToolConfig.execute("t1", { path: "a/b/c" }, ctx);
      expect(textOf(again)).toMatch(/created directory/i);
    });
  });

  describe("file_move", () => {
    it("移动文件；目标已存在则失败", async () => {
      fs.writeFileSync(path.join(cwd, "from.txt"), "src");
      fs.writeFileSync(path.join(cwd, "taken.txt"), "dst");

      const moved = await fileMoveToolConfig.execute(
        "t1",
        { source: "from.txt", destination: "to.txt" },
        ctx,
      );
      expect(textOf(moved)).toMatch(/moved/i);
      expect(fs.existsSync(path.join(cwd, "from.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(cwd, "to.txt"), "utf-8")).toBe("src");

      const conflict = await fileMoveToolConfig.execute(
        "t1",
        { source: "to.txt", destination: "taken.txt" },
        ctx,
      );
      expect(textOf(conflict)).toMatch(/exists/i);
      expect(fs.existsSync(path.join(cwd, "to.txt"))).toBe(true);
    });
  });

  describe("file_copy", () => {
    it("复制文件与目录；目标已存在则失败", async () => {
      fs.mkdirSync(path.join(cwd, "srcDir"));
      fs.writeFileSync(path.join(cwd, "srcDir", "a.txt"), "copy-me");

      const copied = await fileCopyToolConfig.execute(
        "t1",
        { source: "srcDir", destination: "dstDir" },
        ctx,
      );
      expect(textOf(copied)).toMatch(/copied/i);
      expect(fs.readFileSync(path.join(cwd, "srcDir", "a.txt"), "utf-8")).toBe("copy-me");
      expect(fs.readFileSync(path.join(cwd, "dstDir", "a.txt"), "utf-8")).toBe("copy-me");

      const conflict = await fileCopyToolConfig.execute(
        "t1",
        { source: "srcDir", destination: "dstDir" },
        ctx,
      );
      expect(textOf(conflict)).toMatch(/exists/i);
    });
  });
});

describe("已注册项目目录（getAllowedRoots）", () => {
  let workspace: string;
  let project: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-ws-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-proj-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it("list_dir 可列出项目目录内容（绝对路径在 extraRoots 内）", async () => {
    fs.writeFileSync(path.join(project, "index.ts"), "export {}");
    const result = await listDirToolConfig.execute(
      "t1",
      { path: project },
      mockContext(workspace, [project]),
    );
    expect(textOf(result)).toContain("[FILE] index.ts");
  });

  it("file_mkdir 可在项目目录内创建子目录", async () => {
    const target = path.join(project, "src", "nested");
    await fileMkdirToolConfig.execute("t1", { path: target }, mockContext(workspace, [project]));
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("file_copy 可从 workspace 复制到项目目录", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "payload");
    await fileCopyToolConfig.execute(
      "t1",
      { source: path.join(workspace, "a.txt"), destination: path.join(project, "b.txt") },
      mockContext(workspace, [project]),
    );
    expect(fs.readFileSync(path.join(project, "b.txt"), "utf-8")).toBe("payload");
  });

  it("未注入 getAllowedRoots 时项目目录仍被拒（向后兼容）", async () => {
    await expect(
      listDirToolConfig.execute("t1", { path: project }, mockContext(workspace)),
    ).rejects.toThrow(/不在允许范围内/);
  });
});
