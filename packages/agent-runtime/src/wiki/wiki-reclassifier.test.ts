/**
 * 重新编目：提示词、候选解析、状态机、部分接受
 * 计划：docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p2-implementation.md Task 4
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { LEGACY_TOPIC_TREE_V1, PARKING_CATEGORY } from "./wiki-topic-tree.js";
import {
  WikiReclassifier,
  buildReclassifyPrompt,
  parseReclassifyResponse,
} from "./wiki-reclassifier.js";

let seq = 0;
const mkId = (): string => `cand-${++seq}`;

/**
 * 建一套 repo + reclassifier。
 * 资料 id 是运行时生成的，测试无法预知，所以 mock 从提示词里抠出 `[id=...]`，
 * 按出现顺序套用 targets：每项给一个目标目录，undefined 表示保持原样不输出。
 */
function setup(targets: ReadonlyArray<{ category: string; subtopic: string; reason?: string } | null>) {
  const repo = new WikiRepo(createMigratedTestDb());
  const callLLM = vi.fn(async (prompt: string) => {
    const ids = [...prompt.matchAll(/\[id=([^\]]+)\]/g)].map((m) => m[1]!);
    const out = ids
      .map((id, i) => {
        const t = targets[i];
        return t ? { id, category: t.category, subtopic: t.subtopic, reason: t.reason ?? "更合适" } : null;
      })
      .filter((x) => x !== null);
    return JSON.stringify(out);
  });
  const reclassifier = new WikiReclassifier(repo, callLLM, mkId);
  /** 建一条已归档到 (category, subtopic) 的资料；默认落 v2 树的 工作/项目 */
  const mkFiled = (title: string, category = "工作", subtopic = "项目") => {
    const s = repo.createSource({ agentId: "ag", userId: "u", title, extractedText: "正文" });
    repo.updateSourceTopic("ag", "u", s.id, category, subtopic);
    return s;
  };
  return { repo, reclassifier, callLLM, mkFiled };
}

beforeEach(() => {
  seq = 0;
});

describe("buildReclassifyPrompt", () => {
  it("含口诀、当前树与当前所属目录，且不含临时存放", () => {
    const p = buildReclassifyPrompt(
      [
        {
          id: "i1",
          title: "2027年度OKR草案.docx",
          text: "未执行的规划",
          fromCategory: "做事记录",
          fromSubtopic: "项目/任务资料",
        },
      ],
      LEGACY_TOPIC_TREE_V1,
    );
    expect(p).toContain("事情做完留下的结果");
    expect(p).toContain("目标规划方案");
    expect(p).toContain("做事记录 / 项目/任务资料");
    expect(p).not.toContain(PARKING_CATEGORY);
  });
});

describe("parseReclassifyResponse", () => {
  const items = [
    { id: "a", sourceId: "s1", title: "a", fromCategory: "做事记录", fromSubtopic: "项目/任务资料" },
    { id: "b", sourceId: "s2", title: "b", fromCategory: "学习资料", fromSubtopic: "读书摘抄整理" },
  ];

  it("自造节点计入 droppedInvalid；与原节点相同计入 unchanged", () => {
    const r = parseReclassifyResponse(
      JSON.stringify([
        { id: "a", category: "计划与复盘", subtopic: "自创小类", reason: "x" },
        { id: "b", category: "学习资料", subtopic: "读书摘抄整理", reason: "y" },
      ]),
      items,
      LEGACY_TOPIC_TREE_V1,
      mkId,
    );
    expect(r.droppedInvalid).toBe(1);
    expect(r.unchanged).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it("确有更好用途时产出候选，带 from/to 与理由", () => {
    const r = parseReclassifyResponse(
      JSON.stringify([{ id: "a", category: "计划与复盘", subtopic: "目标规划方案", reason: "尚未执行的规划" }]),
      items,
      LEGACY_TOPIC_TREE_V1,
      mkId,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({
      sourceId: "s1",
      fromCategory: "做事记录",
      fromSubtopic: "项目/任务资料",
      toCategory: "计划与复盘",
      toSubtopic: "目标规划方案",
      reason: "尚未执行的规划",
      decision: "pending",
    });
  });

  it("模型想改到临时存放时丢弃（AI 不可写临时存放）", () => {
    const r = parseReclassifyResponse(
      JSON.stringify([{ id: "a", category: PARKING_CATEGORY, subtopic: null, reason: "没用" }]),
      items,
      LEGACY_TOPIC_TREE_V1,
      mkId,
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.droppedInvalid).toBe(1);
  });

  it("模型漏答的条目算 unchanged，不产候选", () => {
    const r = parseReclassifyResponse("[]", items, LEGACY_TOPIC_TREE_V1, mkId);
    expect(r.candidates).toHaveLength(0);
    expect(r.unchanged).toBe(2);
  });

  it("回复不可解析时整批算 unchanged，不抛错", () => {
    const r = parseReclassifyResponse("模型今天不想输出 JSON", items, LEGACY_TOPIC_TREE_V1, mkId);
    expect(r.candidates).toHaveLength(0);
    expect(r.unchanged).toBe(2);
  });
});

describe("WikiReclassifier 状态机", () => {
  it("scope=all 只扫描正式归档，跳过临时存放与待补分", async () => {
    const { repo, reclassifier, mkFiled } = setup([null]);
    mkFiled("已归档.docx");
    const parked = repo.createSource({ agentId: "ag", userId: "u", title: "搁置.docx" });
    repo.updateSourceTopic("ag", "u", parked.id, PARKING_CATEGORY, null);
    repo.createSource({ agentId: "ag", userId: "u", title: "待补分.docx" });

    await reclassifier.run("ag", "u", { kind: "all" });
    const got = reclassifier.get("ag", "u")!;
    expect(got.total).toBe(1);
  });

  it("scope=subtopic 只扫描该小类", async () => {
    const { reclassifier, mkFiled } = setup([null, null]);
    mkFiled("甲.docx", "工作", "项目");
    mkFiled("乙.docx", "工作", "例行");

    await reclassifier.run("ag", "u", {
      kind: "subtopic",
      category: "工作",
      subtopic: "例行",
    });
    expect(reclassifier.get("ag", "u")!.total).toBe(1);
  });

  it("已有 running 时再 run 抛错；review 时需 force", async () => {
    const { reclassifier, mkFiled } = setup([{ category: "学习", subtopic: "在学" }]);
    mkFiled("技术白皮书");

    await reclassifier.run("ag", "u", { kind: "all" });
    expect(reclassifier.get("ag", "u")!.status).toBe("review");

    await expect(reclassifier.run("ag", "u", { kind: "all" })).rejects.toThrow(/已有/);
    await expect(reclassifier.run("ag", "u", { kind: "all" }, { force: true })).resolves.toBeTruthy();
  });

  it("run 成功后 status = review，含候选；apply 部分接受后写两列并标 applied", async () => {
    const { reclassifier, mkFiled, repo } = setup([
      { category: "学习", subtopic: "在学", reason: "技术调研" },
    ]);
    const s = mkFiled("技术白皮书");

    await reclassifier.run("ag", "u", { kind: "all" });
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

    const got2 = reclassifier.get("ag", "u");
    expect(got2).toBeNull(); // 全部接受后清空 run
  });

  it("apply 时目标小类已删则该条留 review 带 applyError", async () => {
    const { reclassifier, mkFiled, repo } = setup([
      { category: "学习", subtopic: "在学", reason: "技术调研" },
      { category: "工作", subtopic: "例行", reason: "内部汇报" },
    ]);
    mkFiled("白皮书");
    mkFiled("周报");

    await reclassifier.run("ag", "u", { kind: "all" });
    const got = reclassifier.get("ag", "u")!;
    expect(got.candidates).toHaveLength(2);

    repo.applyTopicMutation({
      op: "deleteSubtopic",
      category: "学习",
      name: "在学",
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
    const { reclassifier, mkFiled } = setup([
      { category: "学习", subtopic: "在学" },
      { category: "学习", subtopic: "在学" },
    ]);
    mkFiled("白皮书");
    mkFiled("材料");

    await reclassifier.run("ag", "u", { kind: "all" });
    const got = reclassifier.get("ag", "u")!;
    reclassifier.apply("ag", "u", [got.candidates[0]!.id]);
    expect(reclassifier.get("ag", "u")).not.toBeNull();

    reclassifier.ignore("ag", "u", got.candidates[1]!.id);
    expect(reclassifier.get("ag", "u")).toBeNull();
  });

  it("discard 清空 run", async () => {
    const { reclassifier, mkFiled } = setup([{ category: "学习", subtopic: "在学" }]);
    mkFiled("白皮书");

    await reclassifier.run("ag", "u", { kind: "all" });
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

    await expect(reclassifier.run("ag", "u", { kind: "all" })).rejects.toThrow(/模型不可用/);
    const got = reclassifier.get("ag", "u")!;
    expect(got.status).toBe("failed");
    expect(got.error).toMatch(/模型不可用/);
    expect(got.scope).toEqual({ kind: "all" });
  });

  it("apply 空数组不改动任何内容", async () => {
    const { reclassifier, mkFiled } = setup([{ category: "学习", subtopic: "在学" }]);
    mkFiled("白皮书");
    await reclassifier.run("ag", "u", { kind: "all" });
    expect(reclassifier.apply("ag", "u", [])).toEqual({ applied: 0, failed: 0 });
    expect(reclassifier.get("ag", "u")!.candidates).toHaveLength(1);
  });

  it("isRunning 判定 running 状态", () => {
    expect(WikiReclassifier.isRunning(null)).toBe(false);
    expect(WikiReclassifier.isRunning({ status: "review" } as never)).toBe(false);
    expect(WikiReclassifier.isRunning({ status: "running" } as never)).toBe(true);
  });
});
