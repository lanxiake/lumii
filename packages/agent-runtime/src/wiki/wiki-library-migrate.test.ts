/**
 * WikiLibraryMigrate 状态机：plan / cancel / discard / replan / updateMapping / apply / undo
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiSource } from "./types.js";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiLibraryMigrate } from "./wiki-library-migrate.js";
import { WikiReclassifier } from "./wiki-reclassifier.js";

const VAULT_ROOT = "E:/data";
const IMPORT_ROOT = "E:/data/outputs";
const WORKSPACE_ROOT = "E:/data";

let seq = 0;
const mkId = (): string => `mig-${++seq}`;

function setupInboxPair(repo: WikiRepo): { id1: string; id2: string } {
  const id1 = repo.ingestToInbox({
    agentId: "ag",
    userId: "u",
    itemType: "output",
    title: "a.md",
    sourcePath: `${IMPORT_ROOT}/proj/a.md`,
  }).id;
  const id2 = repo.ingestToInbox({
    agentId: "ag",
    userId: "u",
    itemType: "output",
    title: "b.md",
    sourcePath: `${IMPORT_ROOT}/proj/b.md`,
  }).id;
  return { id1, id2 };
}

function planOpts(inboxIds: readonly string[]) {
  return {
    agentId: "ag",
    userId: "u",
    importRoot: IMPORT_ROOT,
    inboxIds,
    workspaceRoot: WORKSPACE_ROOT,
    vaultRoot: VAULT_ROOT,
  };
}

beforeEach(() => {
  seq = 0;
});

describe("WikiLibraryMigrate.isBusy", () => {
  it("inventorying / planning / applying 为 busy", () => {
    const base = {
      id: "r1",
      agentId: "ag",
      userId: "u",
      importRoot: IMPORT_ROOT,
      inboxIds: [],
      mappings: [],
      appliedSourceIds: [],
      appliedInboxIds: [],
      cancelRequested: false,
      progress: {
        runId: "r1",
        phase: "inventorying" as const,
        phaseLabel: "",
        done: 0,
        total: 0,
        currentItem: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(WikiLibraryMigrate.isBusy({ ...base, phase: "inventorying" })).toBe(true);
    expect(WikiLibraryMigrate.isBusy({ ...base, phase: "planning" })).toBe(true);
    expect(WikiLibraryMigrate.isBusy({ ...base, phase: "applying" })).toBe(true);
    expect(WikiLibraryMigrate.isBusy({ ...base, phase: "review" })).toBe(false);
    expect(WikiLibraryMigrate.isBusy(null)).toBe(false);
  });
});

describe("WikiLibraryMigrate plan", () => {
  it("plan 结束后 phase=review，同夹映射一致且未 archive", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1, id2 } = setupInboxPair(repo);
    const llm = vi.fn(async () =>
      JSON.stringify([
        { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
      ]),
    );
    const mig = new WikiLibraryMigrate(repo, llm, mkId);
    const run = await mig.plan(planOpts([id1, id2]));

    expect(run.phase).toBe("review");
    expect(run.mappings).toHaveLength(1);
    expect(run.mappings[0]!.folderRel).toBe("proj");
    expect(run.mappings[0]!.inboxIds).toHaveLength(2);
    expect(run.mappings[0]!.category).toBe("工作");
    expect(repo.listSources("ag", "u").filter((s) => s.topic_category)).toHaveLength(0);
    expect(repo.findInboxById(id1)!.status).toBe("pending");
    expect(repo.findInboxById(id2)!.status).toBe("pending");
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("reclassify running 时拒绝 plan", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1 } = setupInboxPair(repo);
    repo.setReclassifyRun("ag", "u", {
      runId: "rc1",
      status: "running",
      scope: { kind: "all" },
      total: 0,
      processed: 0,
      droppedInvalid: 0,
      unchanged: 0,
      candidates: [],
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const mig = new WikiLibraryMigrate(repo, async () => "[]", mkId);
    await expect(mig.plan(planOpts([id1]))).rejects.toThrow(/重新编目/);
  });

  it("已有 busy migrate 时拒绝 plan", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1 } = setupInboxPair(repo);
    repo.setMigrateRun("ag", "u", {
      id: "existing",
      agentId: "ag",
      userId: "u",
      importRoot: IMPORT_ROOT,
      phase: "planning",
      inboxIds: [id1],
      mappings: [],
      appliedSourceIds: [],
      appliedInboxIds: [],
      cancelRequested: false,
      progress: {
        runId: "existing",
        phase: "planning",
        phaseLabel: "规划中",
        done: 0,
        total: 1,
        currentItem: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const mig = new WikiLibraryMigrate(repo, async () => "[]", mkId);
    await expect(mig.plan(planOpts([id1]))).rejects.toThrow(/迁移/);
  });
});

describe("WikiLibraryMigrate cancel", () => {
  it("planning 中 cancel → cancelled，可 replan", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1, id2 } = setupInboxPair(repo);
    let resolveLLM!: (value: string) => void;
    const llmGate = new Promise<string>((resolve) => {
      resolveLLM = resolve;
    });
    const mig = new WikiLibraryMigrate(repo, async () => {
      mig.cancel("ag", "u");
      return llmGate;
    }, mkId);

    const planPromise = mig.plan(planOpts([id1, id2]));
    resolveLLM(
      JSON.stringify([
        { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
      ]),
    );
    const cancelled = await planPromise;
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.cancelRequested).toBe(true);

    const llm2 = vi.fn(async () =>
      JSON.stringify([
        { folderRel: "proj", category: "学习", subtopic: "在学", confidence: 0.85, reason: "重规划" },
      ]),
    );
    const mig2 = new WikiLibraryMigrate(repo, llm2, mkId);
    const replanned = await mig2.replan("ag", "u", { vaultRoot: VAULT_ROOT, workspaceRoot: WORKSPACE_ROOT });
    expect(replanned.phase).toBe("review");
    expect(replanned.mappings[0]!.category).toBe("学习");
  });
});

describe("WikiLibraryMigrate discard", () => {
  it("discard 清除 run，inbox 仍 pending", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1, id2 } = setupInboxPair(repo);
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
        ]),
      mkId,
    );
    await mig.plan(planOpts([id1, id2]));
    expect(mig.get("ag", "u")).not.toBeNull();

    mig.discard("ag", "u");
    expect(mig.get("ag", "u")).toBeNull();
    expect(repo.findInboxById(id1)!.status).toBe("pending");
    expect(repo.findInboxById(id2)!.status).toBe("pending");
  });
});

describe("WikiLibraryMigrate updateMapping", () => {
  it("review 中可改单簇映射与批准 proposedSubtopic", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1 } = setupInboxPair(repo);
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          {
            folderRel: "proj",
            category: null,
            subtopic: null,
            confidence: 0.3,
            reason: "不确定",
            proposedSubtopic: "新项目",
          },
        ]),
      mkId,
    );
    await mig.plan(planOpts([id1]));
    const updated = mig.updateMapping("ag", "u", "proj", {
      category: "工作",
      subtopic: "项目",
      approvedProposedSubtopic: true,
    });
    expect(updated.phase).toBe("review");
    expect(updated.mappings[0]!.category).toBe("工作");
    expect(updated.mappings[0]!.approvedProposedSubtopic).toBe(true);
    expect(updated.mappings[0]!.status).toBe("ok");
  });

  it("可标记 ignored 跳过某簇", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1 } = setupInboxPair(repo);
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
        ]),
      mkId,
    );
    await mig.plan(planOpts([id1]));
    const updated = mig.updateMapping("ag", "u", "proj", { ignored: true });
    expect(updated.mappings[0]!.ignored).toBe(true);
  });
});

function setupTwoFolderInbox(repo: WikiRepo): { id1: string; id2: string } {
  const id1 = repo.ingestToInbox({
    agentId: "ag",
    userId: "u",
    itemType: "output",
    title: "a.md",
    sourcePath: `${IMPORT_ROOT}/proj/a.md`,
  }).id;
  const id2 = repo.ingestToInbox({
    agentId: "ag",
    userId: "u",
    itemType: "output",
    title: "b.md",
    sourcePath: `${IMPORT_ROOT}/other/b.md`,
  }).id;
  return { id1, id2 };
}

async function planTwoFoldersToReview(mig: WikiLibraryMigrate, id1: string, id2: string) {
  return mig.plan(planOpts([id1, id2]));
}

describe("WikiLibraryMigrate apply", () => {
  it("apply 按映射 archive，写入 appliedSourceIds", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1, id2 } = setupInboxPair(repo);
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
        ]),
      mkId,
    );
    await mig.plan(planOpts([id1, id2]));
    const run = await mig.apply("ag", "u");

    expect(run.phase).toBe("succeeded");
    expect(run.appliedSourceIds).toHaveLength(2);
    expect(run.appliedInboxIds).toEqual(expect.arrayContaining([id1, id2]));
    expect(repo.findSourceById(run.appliedSourceIds[0]!)!.topic_category).toBe("工作");
    expect(repo.findSourceById(run.appliedSourceIds[0]!)!.topic_subtopic).toBe("项目");
    expect(repo.findInboxById(id1)!.status).toBe("organized");
    expect(repo.findInboxById(id2)!.status).toBe("organized");
  });

  it("apply 中途 cancel：仅部分落位，phase=cancelled", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1, id2 } = setupTwoFolderInbox(repo);
    let mig!: WikiLibraryMigrate;
    mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "proj" },
          { folderRel: "other", category: "学习", subtopic: "在学", confidence: 0.9, reason: "other" },
        ]),
      mkId,
      (p) => {
        if (p.appliedCount === 1) mig.cancel("ag", "u");
      },
    );
    await planTwoFoldersToReview(mig, id1, id2);
    const run = await mig.apply("ag", "u");

    expect(run.phase).toBe("cancelled");
    expect(run.appliedSourceIds).toHaveLength(1);
    const remainingId = run.appliedInboxIds[0] === id1 ? id2 : id1;
    expect(repo.findInboxById(remainingId)!.status).toBe("pending");
  });

  it("apply 调用 onSourceCreated 钩子", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1 } = setupInboxPair(repo);
    const created: WikiSource[] = [];
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
        ]),
      mkId,
      undefined,
      { onSourceCreated: (s) => created.push(s) },
    );
    await mig.plan(planOpts([id1]));
    await mig.apply("ag", "u");
    expect(created).toHaveLength(1);
    expect(created[0]!.topic_category).toBe("工作");
  });

  it("非 review 阶段 apply 抛错", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.setMigrateRun("ag", "u", {
      id: "r1",
      agentId: "ag",
      userId: "u",
      importRoot: IMPORT_ROOT,
      phase: "planning",
      inboxIds: [],
      mappings: [],
      appliedSourceIds: [],
      appliedInboxIds: [],
      cancelRequested: false,
      progress: {
        runId: "r1",
        phase: "planning",
        phaseLabel: "规划中",
        done: 0,
        total: 0,
        currentItem: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const mig = new WikiLibraryMigrate(repo, async () => "[]", mkId);
    await expect(mig.apply("ag", "u")).rejects.toThrow(/预览/);
  });
});

describe("WikiLibraryMigrate undo", () => {
  it("undo 后 source 消失且 inbox 回 pending，可再 plan", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const { id1, id2 } = setupInboxPair(repo);
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
        ]),
      mkId,
    );
    await mig.plan(planOpts([id1, id2]));
    const applied = await mig.apply("ag", "u");
    const sourceIds = [...applied.appliedSourceIds];

    const undone = await mig.undo("ag", "u");
    expect(undone.phase).toBe("undone");
    expect(undone.appliedSourceIds).toHaveLength(0);
    expect(repo.findInboxById(id1)!.status).toBe("pending");
    expect(repo.findInboxById(id2)!.status).toBe("pending");
    for (const sid of sourceIds) {
      expect(repo.findSourceById(sid)).toBeNull();
    }

    mig.discard("ag", "u");
    const llm2 = vi.fn(async () =>
      JSON.stringify([
        { folderRel: "proj", category: "学习", subtopic: "在学", confidence: 0.85, reason: "重规划" },
      ]),
    );
    const mig2 = new WikiLibraryMigrate(repo, llm2, mkId);
    const replanned = await mig2.plan(planOpts([id1, id2]));
    expect(replanned.phase).toBe("review");
  });

  it("不修改本 run 之外已归档资料的 topic", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const preItem = repo.ingestToInbox({
      agentId: "ag",
      userId: "u",
      itemType: "output",
      title: "old.md",
      sourcePath: `${IMPORT_ROOT}/legacy/old.md`,
    });
    const preexisting = repo.archiveInboxItem(preItem, "学习", "参考");

    const { id1, id2 } = setupInboxPair(repo);
    const mig = new WikiLibraryMigrate(
      repo,
      async () =>
        JSON.stringify([
          { folderRel: "proj", category: "工作", subtopic: "项目", confidence: 0.9, reason: "同项目" },
        ]),
      mkId,
    );
    await mig.plan(planOpts([id1, id2]));
    await mig.apply("ag", "u");

    expect(repo.findSourceById(preexisting.id)!.topic_category).toBe("学习");
    expect(repo.findSourceById(preexisting.id)!.topic_subtopic).toBe("参考");
  });
});
