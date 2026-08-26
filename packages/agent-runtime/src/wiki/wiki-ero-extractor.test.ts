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
