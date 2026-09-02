import { describe, expect, it } from "vitest";
import { shouldSkipWikiIngestPath } from "./wiki-ingest-filter.js";

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
