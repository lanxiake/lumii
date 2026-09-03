import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { listInvalidWikiFiles, purgeInvalidWikiFiles } from "./wiki-invalid-file-purge.js";
import { WikiRepo } from "./wiki-repo.js";

describe("purgeInvalidWikiFiles", () => {
  it("仅删除代码/脚本类资料，保留文档", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const script = repo.createSource({ agentId: "ag", userId: "u", title: "部署脚本", sourcePath: "/w/deploy.sh" });
    const code = repo.createSource({ agentId: "ag", userId: "u", title: "工具函数", sourcePath: "/w/helper.ts" });
    const doc = repo.createSource({ agentId: "ag", userId: "u", title: "周报", sourcePath: "/w/report.md" });

    const result = purgeInvalidWikiFiles(repo, "ag", "u");

    expect(result.deleted).toBe(2);
    expect(result.sources.map((s) => s.id).sort()).toEqual([script.id, code.id].sort());
    expect(repo.findSourceById(doc.id, "ag", "u")).not.toBeNull();
    expect(repo.findSourceById(script.id, "ag", "u")).toBeNull();
    expect(repo.findSourceById(code.id, "ag", "u")).toBeNull();
  });

  it("按 source_path 判定，不被展示标题误导", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    // 标题带 .ts 但实际是文档：不能删
    const doc = repo.createSource({ agentId: "ag", userId: "u", title: "关于 index.ts 的评审", sourcePath: "/w/review.md" });
    // 标题是干净中文但实际是脚本：要删
    const script = repo.createSource({ agentId: "ag", userId: "u", title: "数据清洗", sourcePath: "/w/clean.py" });

    const invalid = listInvalidWikiFiles(repo, "ag", "u");

    expect(invalid.map((s) => s.id)).toEqual([script.id]);
    expect(repo.findSourceById(doc.id, "ag", "u")).not.toBeNull();
  });

  it("跳过 URL 来源与无路径资料", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag", userId: "u", title: "网页剪藏", sourcePath: "/w/a.ts", originUrl: "https://e.com/a" });
    repo.createSource({ agentId: "ag", userId: "u", title: "纯笔记" });

    expect(listInvalidWikiFiles(repo, "ag", "u")).toHaveLength(0);
  });

  it("无不合规文件时不触发删除回调", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag", userId: "u", title: "周报", sourcePath: "/w/report.md" });
    let called = false;

    const result = purgeInvalidWikiFiles(repo, "ag", "u", () => { called = true; });

    expect(result.deleted).toBe(0);
    expect(called).toBe(false);
  });

  it("删除前先清理 vault 侧车", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.createSource({ agentId: "ag", userId: "u", title: "脚本", sourcePath: "/w/x.sh" });
    const seen: string[] = [];

    purgeInvalidWikiFiles(repo, "ag", "u", (sources) => {
      // 回调必须在删库之前拿到记录，否则宿主无法定位侧车文件
      for (const s of sources) {
        expect(repo.findSourceById(s.id, "ag", "u")).not.toBeNull();
        seen.push(s.source_path ?? "");
      }
    });

    expect(seen).toEqual(["/w/x.sh"]);
  });
});
