/**
 * WikiReclassifier 状态机：两轮制、断点续跑、部分接受
 * 计划：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p5-cataloging.md Task 3
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { PARKING_CATEGORY } from "./wiki-topic-tree.js";
import { WikiReclassifier } from "./wiki-reclassifier.js";
import { STRUCTURE_BATCH_SIZE } from "./wiki-catalog-prompt.js";

let seq = 0;
const mkId = (): string => `cand-${++seq}`;
const VAULT_ROOT = "C:/vault";

interface Decision {
  readonly category?: string | null;
  readonly subtopic?: string | null;
  readonly needContent?: boolean;
  readonly confidence?: number;
  readonly reason?: string;
}

/**
 * 按 prompt 里出现的 `[id=...]` 决定返回值：内容轮 prompt 含「摘要:」标记，
 * 结构轮/内容轮各自走一张决策表，未在表中的 id 直接漏答。
 */
function scriptedLLM(
  structureDecisions: Record<string, Decision>,
  contentDecisions: Record<string, Decision> = {},
) {
  return vi.fn(async (prompt: string) => {
    const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
    const isContent = prompt.includes("摘要:");
    const table = isContent ? contentDecisions : structureDecisions;
    const items = ids
      .map((id) => {
        const d = table[id];
        if (!d) return null;
        return {
          id,
          category: d.category ?? null,
          subtopic: d.subtopic ?? null,
          needContent: d.needContent ?? false,
          confidence: d.confidence ?? 0.9,
          reason: d.reason ?? "理由",
        };
      })
      .filter((x) => x !== null);
    return JSON.stringify({ items });
  });
}

function setup() {
  const repo = new WikiRepo(createMigratedTestDb());
  const mkFiled = (title: string, category = "工作", subtopic: string | null = "项目") => {
    const s = repo.createSource({ agentId: "ag", userId: "u", title, extractedText: "正文" });
    if (category) repo.updateSourceTopic("ag", "u", s.id, category, subtopic);
    return s;
  };
  return { repo, mkFiled };
}

beforeEach(() => {
  seq = 0;
});

describe("WikiReclassifier 两轮制", () => {
  it("结构轮判定的不进内容轮：只调用一次 LLM", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书", "工作", "项目");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    expect(callLLM).toHaveBeenCalledTimes(1);
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]!.decidedBy).toBe("structure");
  });

  it("needContent 进内容轮并补摘要", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("模糊标题", "工作", "项目");
    const callLLM = scriptedLLM(
      { [s.id]: { needContent: true } },
      { [s.id]: { category: "学习", subtopic: "在学" } },
    );
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    expect(callLLM).toHaveBeenCalledTimes(2);
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]!.decidedBy).toBe("content");
  });

  it("无正文的 needContent 不进内容轮，留收件箱不产候选", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "IMG_1.jpg", mediaType: "image" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");
    const callLLM = scriptedLLM({ [s.id]: { needContent: true, reason: "无正文判不了" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    // 无正文，不该触发内容轮调用
    expect(callLLM).toHaveBeenCalledTimes(1);
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(0);
  });

  it("enableRename=true 时内容轮候选携带校验通过的 renameTitle", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "IMG_1234.jpg",
      extractedText: "正文",
      storageMode: "materialized",
    });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");
    const callLLM = vi.fn(async (prompt: string) => {
      const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
      const isContent = prompt.includes("摘要:");
      if (!isContent) {
        return JSON.stringify({ items: ids.map((id) => ({ id, needContent: true })) });
      }
      return JSON.stringify({
        items: ids.map((id) => ({
          id,
          category: "学习",
          subtopic: "在学",
          confidence: 0.9,
          reason: "技术调研",
          renameTitle: "2026年Q3技术调研报告",
        })),
      });
    });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT, enableRename: true });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]!.renameTitle).toBe("2026年Q3技术调研报告");
    void s;
  });

  it("enableRename=true 但标题已锁定时丢弃 renameTitle", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("IMG_1234.jpg", "工作", "项目");
    repo.renameSource("ag", "u", s.id, "IMG_1234.jpg"); // 手动改名（哪怕同名）即锁定
    const callLLM = vi.fn(async (prompt: string) => {
      const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
      const isContent = prompt.includes("摘要:");
      if (!isContent) {
        return JSON.stringify({ items: ids.map((id) => ({ id, needContent: true })) });
      }
      return JSON.stringify({
        items: ids.map((id) => ({
          id,
          category: "学习",
          subtopic: "在学",
          confidence: 0.9,
          reason: "技术调研",
          renameTitle: "2026年Q3技术调研报告",
        })),
      });
    });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT, enableRename: true });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates[0]!.renameTitle).toBeUndefined();
  });

  it("enableRename 默认 false 时不产出 renameTitle 字段", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("IMG_1234.jpg", "工作", "项目");
    const callLLM = vi.fn(async (prompt: string) => {
      const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
      const isContent = prompt.includes("摘要:");
      if (!isContent) {
        return JSON.stringify({ items: ids.map((id) => ({ id, needContent: true })) });
      }
      return JSON.stringify({
        items: ids.map((id) => ({
          id,
          category: "学习",
          subtopic: "在学",
          confidence: 0.9,
          reason: "技术调研",
          renameTitle: "2026年Q3技术调研报告",
        })),
      });
    });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates[0]!.renameTitle).toBeUndefined();
    void s;
  });

  it("confidence < 0.6 不产候选", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书", "工作", "项目");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学", confidence: 0.3 } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(0);
    expect(got.unchanged).toBe(1);
  });

  it("目标 == 当前不产候选", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书", "工作", "项目");
    const callLLM = scriptedLLM({ [s.id]: { category: "工作", subtopic: "项目" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(0);
    expect(got.unchanged).toBe(1);
  });

  it("候选 fromCategory 可为 null（收件箱资料）", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "未分类.docx", extractedText: "正文" });
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates[0]).toMatchObject({ fromCategory: null, fromSubtopic: null });
  });

  it("候选 toSubtopic 可为 null（只定大类）", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书", "工作", "项目");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: null } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates[0]).toMatchObject({ toCategory: "学习", toSubtopic: null });
  });

  it("调用数符合预期：全部结构轮判定 = 1 次", async () => {
    const { repo, mkFiled } = setup();
    const sources = Array.from({ length: STRUCTURE_BATCH_SIZE }, (_, i) => mkFiled(`文档${i}.docx`));
    const decisions: Record<string, Decision> = {};
    for (const s of sources) decisions[s.id] = { category: "学习", subtopic: "在学" };
    const callLLM = scriptedLLM(decisions);
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    expect(callLLM).toHaveBeenCalledTimes(1);
  });

  it("断点续跑：已产候选不重复生成，续跑跳过已完成批次", async () => {
    const { repo, mkFiled } = setup();
    // 两批：第一批成功产出候选，第二批模拟失败
    const batch1 = Array.from({ length: STRUCTURE_BATCH_SIZE }, (_, i) => mkFiled(`一批${i}.docx`));
    const batch2 = mkFiled("二批.docx");

    let call = 0;
    const failThenSucceed = vi.fn(async (prompt: string) => {
      call++;
      const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
      if (call === 2) throw new Error("模型不可用");
      const items = ids.map((id) => ({ id, category: "学习", subtopic: "在学", confidence: 0.9 }));
      return JSON.stringify({ items });
    });
    const reclassifier = new WikiReclassifier(repo, failThenSucceed, mkId);

    await expect(
      reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT }),
    ).rejects.toThrow(/模型不可用/);

    const failed = reclassifier.get("ag", "u")!;
    expect(failed.status).toBe("failed");
    expect(failed.candidates).toHaveLength(batch1.length); // 第一批已产出的候选保留

    // 续跑：第三次调用应成功处理第二批，不重复处理第一批
    const resumeLLM = vi.fn(async (prompt: string) => {
      const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
      const items = ids.map((id) => ({ id, category: "生活", subtopic: "自留", confidence: 0.9 }));
      return JSON.stringify({ items });
    });
    const resumed = new WikiReclassifier(repo, resumeLLM, mkId);
    await resumed.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT, force: true });

    expect(resumeLLM).toHaveBeenCalledTimes(1); // 只处理了第二批
    const done = resumed.get("ag", "u")!;
    expect(done.status).toBe("review");
    expect(done.candidates).toHaveLength(batch1.length + 1);
    void batch2;
  });


  it("running 时再次 run 被拒；review 时需 force", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书", "工作", "项目");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    expect(reclassifier.get("ag", "u")!.status).toBe("review");

    await expect(
      reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT }),
    ).rejects.toThrow(/已有/);
    await expect(
      reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT, force: true }),
    ).resolves.toBeTruthy();
  });
});

describe("WikiReclassifier 状态机（scope/apply/discard）", () => {
  it("scope=all 纳入收件箱，跳过临时存放与已归档", async () => {
    const { repo, mkFiled } = setup();
    mkFiled("已归档.docx");
    const parked = repo.createSource({ agentId: "ag", userId: "u", title: "搁置.docx" });
    repo.updateSourceTopic("ag", "u", parked.id, PARKING_CATEGORY, null);
    const inbox = repo.createSource({ agentId: "ag", userId: "u", title: "待补分.docx" });

    const callLLM = scriptedLLM({});
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);
    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    // 已归档 1 条 + 收件箱 1 条 = 2；搁置（临时存放）被排除
    expect(got.total).toBe(2);
    void inbox;
  });

  it("scope=subtopic 只扫描该小类", async () => {
    const { repo, mkFiled } = setup();
    mkFiled("甲.docx", "工作", "项目");
    mkFiled("乙.docx", "工作", "例行");

    const callLLM = scriptedLLM({});
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);
    await reclassifier.run(
      "ag",
      "u",
      { kind: "subtopic", category: "工作", subtopic: "例行" },
      { vaultRoot: VAULT_ROOT },
    );
    expect(reclassifier.get("ag", "u")!.total).toBe(1);
  });

  it("run 成功后 status = review；apply 部分接受后写两列并标 applied", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("技术白皮书");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学", reason: "技术调研" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.status).toBe("review");
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]!.decision).toBe("pending");

    const r = reclassifier.apply("ag", "u", [got.candidates[0]!.id]);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(0);

    const after = repo.findSourceById(s.id)!;
    expect(after.topic_category).toBe("学习");
    expect(after.topic_subtopic).toBe("在学");

    expect(reclassifier.get("ag", "u")).toBeNull();
  });

  it("apply 时目标小类已删则该条留 review 带 applyError", async () => {
    const { repo, mkFiled } = setup();
    repo.getOrCreateTopicTree();
    repo.applyTopicMutation({
      op: "addSubtopic",
      category: "学习",
      name: "编目实验",
    });
    mkFiled("白皮书");
    mkFiled("周报");
    const callLLM = vi.fn(async (prompt: string) => {
      const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
      const items = ids.map((id, i) =>
        i === 0
          ? { id, category: "学习", subtopic: "编目实验", confidence: 0.9 }
          : { id, category: "工作", subtopic: "例行", confidence: 0.9 },
      );
      return JSON.stringify({ items });
    });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(2);

    repo.applyTopicMutation({
      op: "deleteSubtopic",
      category: "学习",
      name: "编目实验",
      disposition: { type: "parking" },
    });

    const r = reclassifier.apply("ag", "u", [got.candidates[0]!.id, got.candidates[1]!.id]);
    expect(r.applied).toBe(1);
    expect(r.failed).toBe(1);

    const got2 = reclassifier.get("ag", "u")!;
    expect(got2.status).toBe("review");
    expect(got2.candidates).toHaveLength(1);
    expect(got2.candidates[0]!.applyError).toMatch(/目录/);
  });

  it("全部 applied/ignored 后 run 被清空", async () => {
    const { repo, mkFiled } = setup();
    const a = mkFiled("白皮书");
    const b = mkFiled("材料");
    const callLLM = scriptedLLM({
      [a.id]: { category: "学习", subtopic: "在学" },
      [b.id]: { category: "学习", subtopic: "在学" },
    });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    const got = reclassifier.get("ag", "u")!;
    reclassifier.apply("ag", "u", [got.candidates[0]!.id]);
    expect(reclassifier.get("ag", "u")).not.toBeNull();

    reclassifier.ignore("ag", "u", got.candidates[1]!.id);
    expect(reclassifier.get("ag", "u")).toBeNull();
  });

  it("discard 清空 run", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);

    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    expect(reclassifier.get("ag", "u")).not.toBeNull();

    reclassifier.discard("ag", "u");
    expect(reclassifier.get("ag", "u")).toBeNull();
  });

  it("LLM 抛错时批次落 failed 并保留 scope 供重试", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s = repo.createSource({ agentId: "ag", userId: "u", title: "白皮书" });
    repo.updateSourceTopic("ag", "u", s.id, "工作", "项目");
    const reclassifier = new WikiReclassifier(
      repo,
      vi.fn().mockRejectedValue(new Error("模型不可用")),
      mkId,
    );

    await expect(
      reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT }),
    ).rejects.toThrow(/模型不可用/);
    const got = reclassifier.get("ag", "u")!;
    expect(got.status).toBe("failed");
    expect(got.error).toMatch(/模型不可用/);
    expect(got.scope).toEqual({ kind: "all" });
  });

  it("apply 空数组不改动任何内容", async () => {
    const { repo, mkFiled } = setup();
    const s = mkFiled("白皮书");
    const callLLM = scriptedLLM({ [s.id]: { category: "学习", subtopic: "在学" } });
    const reclassifier = new WikiReclassifier(repo, callLLM, mkId);
    await reclassifier.run("ag", "u", { kind: "all" }, { vaultRoot: VAULT_ROOT });
    expect(reclassifier.apply("ag", "u", [])).toEqual({ applied: 0, failed: 0, appliedSourceIds: [] });
    expect(reclassifier.get("ag", "u")!.candidates).toHaveLength(1);
  });

  it("isRunning 判定 running 状态", () => {
    expect(WikiReclassifier.isRunning(null)).toBe(false);
    expect(WikiReclassifier.isRunning({ status: "review" } as never)).toBe(false);
    expect(WikiReclassifier.isRunning({ status: "running" } as never)).toBe(true);
  });
});
