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
      /不在允许范围内/,
    );
  });

  it("拒绝空路径", () => {
    expect(() => resolveAgentFilePath("  ", workspace)).toThrow(/不能为空/);
  });
});

describe("resolveAgentFilePath · extraRoots（宿主注册的项目目录）", () => {
  const workspace = path.resolve("/tmp/mtbot-workspace");
  const projectA = path.resolve("/tmp/projects/alpha");
  const projectB = path.resolve("/tmp/projects/beta");

  it("接受 extraRoots 内的绝对路径", () => {
    const target = path.join(projectA, "src", "index.ts");
    expect(resolveAgentFilePath(target, workspace, [projectA])).toBe(path.resolve(target));
  });

  it("接受多个 extraRoots 中的任一个", () => {
    const target = path.join(projectB, "README.md");
    expect(resolveAgentFilePath(target, workspace, [projectA, projectB])).toBe(path.resolve(target));
  });

  it("相对路径仍锚定 workspace，不因 extraRoots 改变", () => {
    const resolved = resolveAgentFilePath("outputs/foo.md", workspace, [projectA]);
    expect(resolved).toBe(path.join(path.resolve(workspace), "outputs", "foo.md"));
  });

  it("workspace 自身始终有效，即使不在 extraRoots 中", () => {
    const abs = path.join(workspace, "notes.md");
    expect(resolveAgentFilePath(abs, workspace, [projectA])).toBe(path.resolve(abs));
  });

  it("拒绝 extraRoots 之外的绝对路径", () => {
    const outside = path.resolve("/tmp/elsewhere/secret.txt");
    expect(() => resolveAgentFilePath(outside, workspace, [projectA])).toThrow(/不在允许范围内/);
  });

  it("拒绝前缀伪装的相邻目录（alpha-evil 不被 alpha 命中）", () => {
    const sibling = path.join(`${projectA}-evil`, "secret.txt");
    expect(() => resolveAgentFilePath(sibling, workspace, [projectA])).toThrow(/不在允许范围内/);
  });

  it("空数组与不传等价（仅 workspace 单根）", () => {
    const abs = path.join(workspace, "outputs", "bar.md");
    expect(resolveAgentFilePath(abs, workspace, [])).toBe(path.resolve(abs));
    expect(() =>
      resolveAgentFilePath(path.resolve("/tmp/elsewhere/x.txt"), workspace, []),
    ).toThrow(/不在允许范围内/);
  });
});

describe("resolveAgentFilePath · mode=read（读/搜放开）", () => {
  const workspace = path.resolve("/tmp/mtbot-workspace");

  it("read：workspace 外的绝对路径也放行（可搜/读其他目录）", () => {
    const outside = path.resolve("/tmp/elsewhere/notes.md");
    expect(resolveAgentFilePath(outside, workspace, [], "read")).toBe(outside);
  });

  it("read：相对路径仍锚定 workspace", () => {
    expect(resolveAgentFilePath("outputs/foo.md", workspace, [], "read")).toBe(
      path.join(workspace, "outputs", "foo.md"),
    );
  });

  it("read：空路径仍拒绝", () => {
    expect(() => resolveAgentFilePath("  ", workspace, [], "read")).toThrow(/不能为空/);
  });

  it("write（默认）不受影响：workspace 外仍被拒", () => {
    const outside = path.resolve("/tmp/elsewhere/notes.md");
    expect(() => resolveAgentFilePath(outside, workspace, [])).toThrow(/不在允许范围内/);
  });
});
