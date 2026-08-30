/**
 * Wiki 资料库 prompt section 测试
 */
import { describe, expect, it } from "vitest";
import { buildWikiKnowledgeSection } from "../misc-sections.js";

describe("buildWikiKnowledgeSection", () => {
  it("无 wiki 读工具且无 bash 时不注入", () => {
    expect(buildWikiKnowledgeSection(["file_read"])).toEqual([]);
  });

  it("有 bash 时包含 lumii-ui 文件夹导入流程", () => {
    const lines = buildWikiKnowledgeSection(["bash", "wiki_search"]);
    const text = lines.join("\n");
    expect(text).toContain("Wiki Knowledge Base");
    expect(text).toContain("wiki folder scan");
    expect(text).toContain("wiki folder import");
    expect(text).toContain("mode intake");
    expect(text).toContain("mode organize");
  });

  it("仅有 wiki 读工具时不包含 CLI 写入指引", () => {
    const lines = buildWikiKnowledgeSection(["wiki_overview", "wiki_search", "wiki_read"]);
    const text = lines.join("\n");
    expect(text).toContain("wiki_overview");
    expect(text).not.toContain("lumii-ui");
  });
});
