import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiCleanupScanner } from "./wiki-cleanup.js";
import { purgeBrokenWikiSources } from "./wiki-broken-source-purge.js";
import { WikiRepo } from "./wiki-repo.js";

describe("purgeBrokenWikiSources", () => {
  it("仅删除来源失效的资料", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const broken = repo.createSource({ agentId: "ag", userId: "u", title: "丢了", sourcePath: "/gone.md" });
    const ok = repo.createSource({ agentId: "ag", userId: "u", title: "还在", sourcePath: "/ok.md" });
    const scanner = new WikiCleanupScanner(repo);

    const result = purgeBrokenWikiSources(repo, scanner, "ag", "u", {
      sourceFileExists: (s) => s.id !== broken.id,
    });

    expect(result.deleted).toBe(1);
    expect(result.sources.map((s) => s.id)).toEqual([broken.id]);
    expect(repo.findSourceById(ok.id, "ag", "u")).not.toBeNull();
    expect(repo.findSourceById(broken.id, "ag", "u")).toBeNull();
  });
});
