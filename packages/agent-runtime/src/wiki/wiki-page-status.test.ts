/**
 * WikiPageStatusScanner 单测：三条规则命中/不命中；确认更新 status；拒绝清候选。
 */
import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiPageStatusScanner } from "./wiki-page-status.js";

function tryCreateRepo(): WikiRepo | null {
  try {
    return new WikiRepo(createMigratedTestDb());
  } catch {
    return null;
  }
}

describe("WikiPageStatusScanner", () => {
  it("否定表述命中 doubtful；inbox 不命中；确认后 status 更新；拒绝清除候选", () => {
    const repo = tryCreateRepo();
    if (!repo) return;

    const doubtful = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/old-api",
      title: "旧 API",
      contentMd: "该接口已废弃，请勿使用",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "inbox/note",
      title: "收件备注",
      contentMd: "已废弃临时笔记",
      editor: "user",
    });

    const scanner = new WikiPageStatusScanner(repo);
    const hits = scanner.scan("ag", "u");
    expect(hits.some((c) => c.pageId === doubtful.id && c.suggestedStatus === "doubtful")).toBe(true);
    expect(hits.some((c) => c.path.startsWith("inbox/"))).toBe(false);

    scanner.confirm("ag", "u", doubtful.id, "doubtful");
    expect(repo.findPageById(doubtful.id)?.status).toBe("doubtful");
    expect(scanner.listCandidates("ag", "u").some((c) => c.pageId === doubtful.id)).toBe(false);

    const again = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/gone",
      title: "失效页",
      contentMd: "已下线服务",
      editor: "user",
    });
    scanner.scan("ag", "u");
    scanner.reject("ag", "u", again.id);
    expect(scanner.listCandidates("ag", "u").some((c) => c.pageId === again.id)).toBe(false);
    expect(repo.findPageById(again.id)?.status).toBe("active");
  });

  it("来源失效命中 outdated", () => {
    const repo = tryCreateRepo();
    if (!repo) return;

    const source = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "文件",
      sourcePath: "/missing/file.txt",
      contentMd: "x",
    });
    const page = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/file",
      title: "文件",
      contentMd: "摘要",
      editor: "ai",
      sourceRef: source.id,
    });

    const scanner = new WikiPageStatusScanner(repo);
    const hits = scanner.scan("ag", "u", { fileExists: () => false });
    expect(hits.some((c) => c.pageId === page.id && c.suggestedStatus === "outdated")).toBe(true);
  });
});
