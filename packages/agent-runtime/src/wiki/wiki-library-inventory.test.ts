/**
 * LibraryInventory 全局盘点：排除规则、叶子占用、聚簇、scope 过滤
 * 计划：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p5-cataloging.md Task 1
 */

import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { PARKING_CATEGORY } from "./wiki-topic-tree.js";
import { buildLibraryInventory } from "./wiki-library-inventory.js";

const VAULT_ROOT = "C:/vault";

function setup() {
  return new WikiRepo(createMigratedTestDb());
}

describe("buildLibraryInventory", () => {
  it("盘点排除 archived 与 parking", () => {
    const repo = setup();
    const archived = repo.createSource({ agentId: "ag", userId: "u", title: "已归档.docx" });
    repo.updateSourceTopic("ag", "u", archived.id, "工作", "项目");
    repo.archiveSources("ag", "u", [archived.id]);

    const parked = repo.createSource({ agentId: "ag", userId: "u", title: "搁置.docx" });
    repo.updateSourceTopic("ag", "u", parked.id, PARKING_CATEGORY, null);

    const kept = repo.createSource({ agentId: "ag", userId: "u", title: "保留.docx" });
    repo.updateSourceTopic("ag", "u", kept.id, "工作", "项目");

    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    expect(inv.files).toHaveLength(1);
    expect(inv.files[0]!.id).toBe(kept.id);
  });

  it("leaves 含每大类的「未细分」槽位", () => {
    const repo = setup();
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "未细分.docx" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", null);

    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    expect(inv.leaves).toContainEqual(
      expect.objectContaining({ category: "工作", subtopic: null, count: 1 }),
    );
  });

  it("anchors 每叶子最多 3 条", () => {
    const repo = setup();
    for (let i = 0; i < 5; i++) {
      const s = repo.createSource({ agentId: "ag", userId: "u", title: `文档${i}.docx` });
      repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");
    }
    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    const leaf = inv.leaves.find((l) => l.category === "工作" && l.subtopic === "项目")!;
    expect(leaf.count).toBe(5);
    expect(leaf.anchors.length).toBeLessThanOrEqual(3);
  });

  it("files 按目录聚簇：同目录文件相邻", () => {
    const repo = setup();
    const a = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "a.docx",
      sourcePath: `${VAULT_ROOT}/工作/项目/a.docx`,
    });
    repo.updateSourceTopic("ag", "u", a.id, "工作", "项目");
    const other = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "x.docx",
      sourcePath: `${VAULT_ROOT}/生活/凭据/x.docx`,
    });
    repo.updateSourceTopic("ag", "u", other.id, "生活", "凭据");
    const b = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "b.docx",
      sourcePath: `${VAULT_ROOT}/工作/项目/b.docx`,
    });
    repo.updateSourceTopic("ag", "u", b.id, "工作", "项目");

    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    const clusterKeys = inv.files.map((f) => f.clusterKey);
    const idxA = clusterKeys.indexOf("工作/项目");
    const idxB = clusterKeys.lastIndexOf("工作/项目");
    expect(idxB - idxA).toBe(1);
  });

  it("大簇优先", () => {
    const repo = setup();
    for (let i = 0; i < 3; i++) {
      const s = repo.createSource({
        agentId: "ag",
        userId: "u",
        title: `big${i}.docx`,
        sourcePath: `${VAULT_ROOT}/工作/项目/big${i}.docx`,
      });
      repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");
    }
    const small = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "small.docx",
      sourcePath: `${VAULT_ROOT}/生活/凭据/small.docx`,
    });
    repo.updateSourceTopic("ag", "u", small.id, "生活", "凭据");

    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    expect(inv.files[0]!.clusterKey).toBe("工作/项目");
  });

  it("scope=subtopic 只含该小类", () => {
    const repo = setup();
    const a = repo.createSource({ agentId: "ag", userId: "u", title: "a.docx" });
    repo.updateSourceTopic("ag", "u", a.id, "工作", "项目");
    const b = repo.createSource({ agentId: "ag", userId: "u", title: "b.docx" });
    repo.updateSourceTopic("ag", "u", b.id, "工作", "例行");

    const inv = buildLibraryInventory(
      repo,
      "ag",
      "u",
      { kind: "subtopic", category: "工作", subtopic: "项目" },
      VAULT_ROOT,
    );
    expect(inv.files).toHaveLength(1);
    expect(inv.files[0]!.id).toBe(a.id);
  });

  it("inboxCount 统计未分类", () => {
    const repo = setup();
    repo.createSource({ agentId: "ag", userId: "u", title: "未分类.docx" });
    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    expect(inv.inboxCount).toBe(1);
  });

  it("scope=all 纳入收件箱资料本身", () => {
    const repo = setup();
    const inbox = repo.createSource({ agentId: "ag", userId: "u", title: "未分类.docx" });
    const inv = buildLibraryInventory(repo, "ag", "u", { kind: "all" }, VAULT_ROOT);
    expect(inv.files.map((f) => f.id)).toContain(inbox.id);
  });
});
