import { describe, expect, it } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiConceptCandidateScanner } from "./wiki-concept-candidate.js";

function makeSources(repo: WikiRepo, agentId: string, userId: string, n: number) {
  return Array.from({ length: n }, (_, i) =>
    repo.createSource({ agentId, userId, title: `资料${i}`, contentMd: `提到微信语音的处理逻辑 ${i}` }),
  );
}

describe("WikiConceptCandidateScanner", () => {
  it("复现计数达到门槛（默认 N=3）才产生候选", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 3);

    const callLLM = async () =>
      JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: sources.map((s) => s.id) }]);

    const candidates = await scanner.scan("ag", "u", sources, callLLM);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "微信语音", type: "concept" });
    expect(candidates[0]!.evidenceSourceIds.sort()).toEqual(sources.map((s) => s.id).sort());
  });

  it("未达复现门槛的候选被丢弃，不写入", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 2);

    const callLLM = async () =>
      JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: sources.map((s) => s.id) }]);

    const candidates = await scanner.scan("ag", "u", sources, callLLM);
    expect(candidates).toHaveLength(0);
    expect(scanner.listCandidates()).toHaveLength(0);
  });

  it("同一资料被模型重复列出只算一次证据（按资料 id 去重）", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 3);
    const dupIds = [sources[0]!.id, sources[0]!.id, sources[1]!.id, sources[2]!.id];

    const callLLM = async () => JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: dupIds }]);

    const candidates = await scanner.scan("ag", "u", sources, callLLM);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceSourceIds).toHaveLength(3);
  });

  it("可自定义复现门槛 N", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    scanner.setThresholdN("ag", "u", 2);
    const sources = makeSources(repo, "ag", "u", 2);

    const callLLM = async () =>
      JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: sources.map((s) => s.id) }]);

    const candidates = await scanner.scan("ag", "u", sources, callLLM);
    expect(candidates).toHaveLength(1);
  });

  it("LLM 异常时扫描返回空数组，不抛错", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 3);

    const candidates = await scanner.scan("ag", "u", sources, async () => {
      throw new Error("模型不可用");
    });
    expect(candidates).toEqual([]);
  });

  it("确认候选：落点合法（concepts/ 或 entities/），确认后从候选存储清除", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 3);
    await scanner.scan("ag", "u", sources, async () =>
      JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: sources.map((s) => s.id) }]),
    );

    const page = scanner.confirm("ag", "u", "微信语音", "concept");
    expect(page.path).toBe("concepts/微信语音");
    expect(page.category).toBe("concepts");
    expect(scanner.listCandidates()).toHaveLength(0);
  });

  it("确认候选后相关资料摘要页出现反链", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 3);
    // 建对应的摘要页（source_ref 指向资料），模拟 P0 摄入落库
    const summaryPages = sources.map((s) =>
      repo.savePage({
        agentId: "ag",
        userId: "u",
        path: `sources/${s.id}`,
        title: s.title,
        contentMd: `提到微信语音`,
        editor: "ai",
        sourceRef: s.id,
      }),
    );

    await scanner.scan("ag", "u", sources, async () =>
      JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: sources.map((s) => s.id) }]),
    );
    const conceptPage = scanner.confirm("ag", "u", "微信语音", "concept");

    const backlinks = repo.listBacklinks("ag", "u", conceptPage.id);
    expect(backlinks).toHaveLength(3);
    expect(backlinks.map((b) => b.sourcePageId).sort()).toEqual(summaryPages.map((p) => p.id).sort());
  });

  it("拒绝候选不产生任何写入", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    const sources = makeSources(repo, "ag", "u", 3);
    await scanner.scan("ag", "u", sources, async () =>
      JSON.stringify([{ name: "微信语音", type: "concept", sourceIds: sources.map((s) => s.id) }]),
    );

    scanner.reject("微信语音", "concept");
    expect(scanner.listCandidates()).toHaveLength(0);
    expect(repo.listPages("ag", "u")).toHaveLength(0);
  });

  it("确认不存在的候选抛错", () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const scanner = new WikiConceptCandidateScanner(repo);
    expect(() => scanner.confirm("ag", "u", "不存在", "concept")).toThrow();
  });
});
