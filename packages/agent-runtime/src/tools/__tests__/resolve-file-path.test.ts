import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveAgentFilePath } from "../resolve-file-path.js";

describe("resolveAgentFilePath", () => {
  const workspace = path.resolve("/tmp/mtbot-workspace");

  it("将相对路径解析到 workspace 根目录下", () => {
    const resolved = resolveAgentFilePath("outputs/foo.md", workspace);
    expect(resolved).toBe(path.join(workspace, "outputs", "foo.md"));
  });

  it("保留 workspace 内的绝对路径", () => {
    const abs = path.join(workspace, "outputs", "bar.md");
    expect(resolveAgentFilePath(abs, workspace)).toBe(path.resolve(abs));
  });

  it("拒绝越出 workspace 的路径穿越", () => {
    expect(() => resolveAgentFilePath("../outside.txt", workspace)).toThrow(
      /不在工作空间内/,
    );
  });

  it("拒绝空路径", () => {
    expect(() => resolveAgentFilePath("  ", workspace)).toThrow(/不能为空/);
  });
});
