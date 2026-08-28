/**
 * WikiEroExtractor 单测：LLM JSON 解析、实体关系 upsert、页面标题绑定
 */
import { describe, expect, it, vi } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiEroRepo } from "./wiki-ero.js";
import { WikiEroExtractor } from "./wiki-ero-extractor.js";

describe("WikiEroExtractor", () => {
  it("解析 LLM JSON 并 upsert 实体关系；绑定同名页面 page_id", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const page = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/x",
      title: "Lumii",
      contentMd: "Lumii 使用 TypeScript",
      editor: "ai",
    });
    const ero = new WikiEroRepo(repo.database);
    const extractor = new WikiEroExtractor(repo, ero, async () =>
      JSON.stringify({
        entities: [
          { name: "Lumii", type: "project" },
          { name: "TypeScript", type: "tool" },
        ],
        relations: [{ source: "Lumii", target: "TypeScript", type: "uses", strength: 0.5 }],
        observations: [{ entity: "Lumii", content: "桌面宠物应用" }],
      }),
    );
    const r = await extractor.extractRecent("ag", "u", { maxPages: 5 });
    expect(r.entitiesUpserted).toBeGreaterThanOrEqual(2);
    expect(r.relationsUpserted).toBeGreaterThanOrEqual(1);
    expect(r.observationsAdded).toBeGreaterThanOrEqual(1);
    const entities = ero.listEntities("ag", "u");
    expect(entities.find((e) => e.name === "Lumii")?.page_id).toBe(page.id);
    repo.database.close();
  });

  it("单页 LLM 失败时记录 errors 并继续处理其它页", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "页甲",
      contentMd: "内容甲",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/b",
      title: "页乙",
      contentMd: "内容乙",
      editor: "user",
    });
    const ero = new WikiEroRepo(repo.database);
    let callCount = 0;
    const extractor = new WikiEroExtractor(repo, ero, async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("模型超时");
      return JSON.stringify({
        entities: [{ name: "实体乙", type: "concept" }],
        relations: [],
        observations: [],
      });
    });
    const r = await extractor.extractRecent("ag", "u", { maxPages: 2 });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("页");
    expect(r.pagesProcessed).toBe(1);
    expect(r.entitiesUpserted).toBeGreaterThanOrEqual(1);
    repo.database.close();
  });

  it("JSON 解析失败时计入 errors", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/x",
      title: "无效页",
      contentMd: "正文",
      editor: "user",
    });
    const ero = new WikiEroRepo(repo.database);
    const extractor = new WikiEroExtractor(repo, ero, async () => "这不是 JSON");
    const r = await extractor.extractRecent("ag", "u", { maxPages: 1 });
    expect(r.errors.length).toBe(1);
    expect(r.pagesProcessed).toBe(0);
    repo.database.close();
  });

  it("关系端点引用已有 ERO 实体（本页 LLM 未列出）时仍能 upsert", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/x",
      title: "当前页",
      contentMd: "正文",
      editor: "user",
    });
    const ero = new WikiEroRepo(repo.database);
    ero.upsertEntity({
      agentId: "ag",
      userId: "u",
      name: "已有实体",
      entityType: "concept",
    });
    const extractor = new WikiEroExtractor(repo, ero, async () =>
      JSON.stringify({
        entities: [{ name: "新实体", type: "project" }],
        relations: [{ source: "新实体", target: "已有实体", type: "depends_on", strength: 0.6 }],
        observations: [],
      }),
    );
    const r = await extractor.extractRecent("ag", "u", { maxPages: 1 });
    expect(r.relationsUpserted).toBe(1);
    const relations = ero.listRelations("ag", "u");
    expect(relations.some((rel) => rel.relation_type === "depends_on")).toBe(true);
    repo.database.close();
  });

  it("maxPages 与 maxCharsPerPage 钳制到合理范围", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    for (let i = 0; i < 105; i += 1) {
      repo.savePage({
        agentId: "ag",
        userId: "u",
        path: `sources/p-${i}`,
        title: `页${i}`,
        contentMd: "y".repeat(25000),
        editor: "user",
      });
    }
    const ero = new WikiEroRepo(repo.database);
    const callLLM = vi.fn(async () =>
      JSON.stringify({ entities: [], relations: [], observations: [] }),
    );
    const extractor = new WikiEroExtractor(repo, ero, callLLM);
    await extractor.extractRecent("ag", "u", { maxPages: 999, maxCharsPerPage: 99999 });
    expect(callLLM).toHaveBeenCalledTimes(100);
    const prompt = callLLM.mock.calls[0]![0] as string;
    expect(prompt.includes("y".repeat(20000))).toBe(true);
    expect(prompt.includes("y".repeat(20001))).toBe(false);
    repo.database.close();
  });

  it("默认 maxPages=20、maxCharsPerPage=4000", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const ero = new WikiEroRepo(repo.database);
    const callLLM = vi.fn(async () =>
      JSON.stringify({ entities: [], relations: [], observations: [] }),
    );
    const extractor = new WikiEroExtractor(repo, ero, callLLM);
    await extractor.extractRecent("ag", "u");
    expect(callLLM).not.toHaveBeenCalled();
    for (let i = 0; i < 21; i += 1) {
      repo.savePage({
        agentId: "ag",
        userId: "u",
        path: `sources/p-${i}`,
        title: `页${i}`,
        contentMd: "x".repeat(5000),
        editor: "user",
      });
    }
    await extractor.extractRecent("ag", "u");
    expect(callLLM).toHaveBeenCalledTimes(20);
    const prompt = callLLM.mock.calls[0]![0] as string;
    expect(prompt.includes("x".repeat(4000))).toBe(true);
    expect(prompt.includes("x".repeat(4001))).toBe(false);
    repo.database.close();
  });
});

/** 三期：按资料抽取 */
function seedSource(
  repo: WikiRepo,
  title: string,
  extractedText: string | null,
  topic?: { category: string; subtopic: string },
) {
  const source = repo.createSource({
    agentId: "ag",
    userId: "u",
    title,
    extractedText: extractedText ?? undefined,
    contentHash: extractedText ? `hash-${extractedText.length}-${title}` : undefined,
  });
  if (topic) {
    repo.updateSourceTopic("ag", "u", source.id, topic.category, topic.subtopic);
  }
  return source;
}

const ERO_JSON = JSON.stringify({
  entities: [
    { name: "Lumii", type: "project" },
    { name: "SQLite", type: "tool" },
  ],
  relations: [{ source: "Lumii", target: "SQLite", type: "uses", strength: 0.5 }],
  observations: [{ entity: "Lumii", content: "本地优先存储" }],
});

describe("WikiEroExtractor.extractFromSources（三期）", () => {
  it("按小类抽取：写 source_id，返回统计", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    repo.getOrCreateTopicTree();
    const s1 = seedSource(repo, "调研A.pdf", "Lumii 用 SQLite 存数据", {
      category: "学习资料",
      subtopic: "调研搜集材料",
    });
    const s2 = seedSource(repo, "调研B.pdf", "另一份调研正文", {
      category: "学习资料",
      subtopic: "调研搜集材料",
    });
    const ero = new WikiEroRepo(repo.database);
    const extractor = new WikiEroExtractor(repo, ero, async () => ERO_JSON);

    const result = await extractor.extractFromSources("ag", "u", {
      category: "学习资料",
      subtopic: "调研搜集材料",
    });

    expect(result.sourcesScanned).toBe(2);
    expect(result.sourcesSkipped).toBe(0);
    expect(result.sourcesFailed).toBe(0);
    expect(result.entitiesUpserted).toBeGreaterThan(0);
    // 观察写到了这两条资料上
    const pairs = ero.listEntitiesBySources("ag", "u", [s1.id, s2.id]);
    expect(pairs.length).toBeGreaterThan(0);
    expect(new Set(pairs.map((p) => p.sourceId))).toEqual(new Set([s1.id, s2.id]));
    repo.database.close();
  });

  it("正文未变的资料第二次抽取被跳过", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s1 = seedSource(repo, "a.md", "内容甲");
    const ero = new WikiEroRepo(repo.database);
    const callLLM = vi.fn(async () => ERO_JSON);
    const extractor = new WikiEroExtractor(repo, ero, callLLM);

    const first = await extractor.extractFromSources("ag", "u", { sourceIds: [s1.id] });
    expect(first.sourcesScanned).toBe(1);
    expect(callLLM).toHaveBeenCalledTimes(1);

    const second = await extractor.extractFromSources("ag", "u", { sourceIds: [s1.id] });
    expect(second.sourcesScanned).toBe(0);
    expect(second.sourcesSkipped).toBe(1);
    expect(callLLM).toHaveBeenCalledTimes(1); // 没有再调 LLM
    repo.database.close();
  });

  it("正文变化后重新抽取", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s1 = seedSource(repo, "a.md", "内容甲");
    const ero = new WikiEroRepo(repo.database);
    const extractor = new WikiEroExtractor(repo, ero, async () => ERO_JSON);

    await extractor.extractFromSources("ag", "u", { sourceIds: [s1.id] });
    // 改正文与哈希
    repo.database
      .prepare("UPDATE wiki_sources SET extracted_text = ?, content_hash = ? WHERE id = ?")
      .run("内容乙不同了", "hash-changed", s1.id);

    const again = await extractor.extractFromSources("ag", "u", { sourceIds: [s1.id] });
    expect(again.sourcesScanned).toBe(1);
    expect(again.sourcesSkipped).toBe(0);
    repo.database.close();
  });

  it("单个资料 LLM 失败不影响其余，也不回滚已成功实体，失败项不进游标", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s1 = seedSource(repo, "坏的.md", "会失败");
    const s2 = seedSource(repo, "好的.md", "会成功");
    const ero = new WikiEroRepo(repo.database);
    const callLLM = vi.fn(async (prompt: string) => {
      if (prompt.includes("会失败")) throw new Error("模型超时");
      return ERO_JSON;
    });
    const extractor = new WikiEroExtractor(repo, ero, callLLM);

    const result = await extractor.extractFromSources("ag", "u", { sourceIds: [s1.id, s2.id] });

    expect(result.sourcesFailed).toBe(1);
    expect(result.sourcesScanned).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.sourceId).toBe(s1.id);
    expect(result.errors[0]!.title).toBe("坏的.md");
    // 成功的实体已落库，未被回滚
    expect(ero.listEntitiesBySources("ag", "u", [s2.id]).length).toBeGreaterThan(0);
    // 失败项不进游标 → 下次仍会重试
    const cursor = repo.getGraphExtractCursor("ag", "u");
    expect(cursor[s1.id]).toBeUndefined();
    expect(cursor[s2.id]).toBeDefined();
    repo.database.close();
  });

  it("无 extracted_text 的资料用 title + media_meta 兜底", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const video = repo.createSource({
      agentId: "ag",
      userId: "u",
      title: "竞品调研录屏.mp4",
      mediaType: "video",
      mediaMeta: JSON.stringify({ duration: 320, resolution: "1920x1080" }),
      originContext: "2026-08 竞品调研任务产出",
    });
    const ero = new WikiEroRepo(repo.database);
    const callLLM = vi.fn(async () => ERO_JSON);
    const extractor = new WikiEroExtractor(repo, ero, callLLM);

    const result = await extractor.extractFromSources("ag", "u", { sourceIds: [video.id] });

    expect(result.sourcesScanned).toBe(1);
    const prompt = callLLM.mock.calls[0]![0];
    expect(prompt).toContain("竞品调研录屏.mp4");
    expect(prompt).toContain("1920x1080");
    repo.database.close();
  });

  it("scope 无 sourceIds 也无目录时抛中文错误", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const ero = new WikiEroRepo(repo.database);
    const extractor = new WikiEroExtractor(repo, ero, async () => ERO_JSON);
    await expect(extractor.extractFromSources("ag", "u", {})).rejects.toThrow(
      /请先选择要抽取的目录或文件/,
    );
    repo.database.close();
  });

  it("onProgress 回调按处理进度递增（含跳过项）", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const s1 = seedSource(repo, "a.md", "甲");
    const s2 = seedSource(repo, "b.md", "乙");
    const ero = new WikiEroRepo(repo.database);
    const extractor = new WikiEroExtractor(repo, ero, async () => ERO_JSON);

    const progress: Array<[number, number]> = [];
    await extractor.extractFromSources(
      "ag",
      "u",
      { sourceIds: [s1.id, s2.id] },
      (done, total) => progress.push([done, total]),
    );
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    repo.database.close();
  });
});
