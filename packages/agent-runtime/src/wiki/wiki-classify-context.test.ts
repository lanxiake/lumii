/**
 * Wiki 分类上下文构造单测
 */
import { describe, expect, it } from "vitest";
import { buildDirectoryTreeText, buildNavSectionGuide } from "./wiki-classify-context.js";

describe("buildDirectoryTreeText", () => {
  it("生成相对导入根的 ASCII 目录树", () => {
    const tree = buildDirectoryTreeText(
      ["outputs/project/script.md", "outputs/project/assets/logo.png"],
      "outputs/project",
    );
    expect(tree).toContain("project/");
    expect(tree).toContain("script.md");
    expect(tree).toContain("assets/");
    expect(tree).toContain("logo.png");
  });
});

describe("buildNavSectionGuide", () => {
  it("包含工作/学习等 UI 分区", () => {
    const guide = buildNavSectionGuide();
    expect(guide).toContain("工作");
    expect(guide).toContain("做事记录");
    expect(guide).toContain("生活");
  });
});
