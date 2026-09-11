import { describe, expect, it } from "vitest";
import {
  resolveWikiAutoIngestItemType,
  shouldSkipWikiIngestPath,
} from "./wiki-ingest-filter.js";

describe("shouldSkipWikiIngestPath", () => {
  it("跳过代码与脚本扩展名", () => {
    expect(shouldSkipWikiIngestPath("outputs/run.py", "run.py")).toBe("ignored:code-or-script");
    expect(shouldSkipWikiIngestPath("outputs/helper.ts", "helper.ts")).toBe("ignored:code-or-script");
    expect(shouldSkipWikiIngestPath("outputs/deploy.sh", "deploy.sh")).toBe("ignored:code-or-script");
  });

  it("保留文档与数据扩展名", () => {
    expect(shouldSkipWikiIngestPath("outputs/report.md", "report.md")).toBeNull();
    expect(shouldSkipWikiIngestPath("outputs/data.json", "data.json")).toBeNull();
  });

  it("跳过 temp 目录下的文件", () => {
    expect(shouldSkipWikiIngestPath("outputs/temp/draft.md", "draft.md")).toBe("ignored:temp");
  });
});

describe("resolveWikiAutoIngestItemType", () => {
  it("识别 uploads 与 outputs 下的相对路径", () => {
    expect(resolveWikiAutoIngestItemType("uploads/2026-01-01/report.pdf")).toBe("upload");
    expect(resolveWikiAutoIngestItemType("outputs/未归类/thread-1/report.md")).toBe("output");
  });

  it("识别绝对路径（含 Windows 反斜杠）", () => {
    expect(
      resolveWikiAutoIngestItemType("C:\\Users\\me\\.lumii\\workspace\\uploads\\a.pdf"),
    ).toBe("upload");
    expect(resolveWikiAutoIngestItemType("/home/me/.lumii/workspace/outputs/a.md")).toBe("output");
  });

  it("拒绝 uploads/outputs 之外的目录", () => {
    expect(resolveWikiAutoIngestItemType("skills/my-skill/SKILL.md")).toBeNull();
    expect(resolveWikiAutoIngestItemType("workspace/skills/my-skill/SKILL.md")).toBeNull();
    expect(resolveWikiAutoIngestItemType("projects/demo/README.md")).toBeNull();
    expect(resolveWikiAutoIngestItemType("files/a.md")).toBeNull();
    expect(resolveWikiAutoIngestItemType("system/config.md")).toBeNull();
    expect(resolveWikiAutoIngestItemType("notes.md")).toBeNull();
  });

  it("uploads 优先于 outputs", () => {
    expect(resolveWikiAutoIngestItemType("outputs/uploads/a.md")).toBe("upload");
  });
});
