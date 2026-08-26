/**
 * Wiki 自动综述单测：选页过滤/截断、稳定路径、分类成页。
 */
import { describe, expect, it, vi } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiSynthesizer } from "./wiki-synthesizer.js";
import {
  WikiAutoSynthesisRunner,
  autoSynthesisPath,
  selectPagesForAutoSynthesis,
} from "./wiki-auto-synthesis.js";
import type { WikiPage } from "./types.js";

/** 构造测试用 WikiPage */
function page(partial: Partial<WikiPage> & { id: string; title: string }): WikiPage {
  return {
    agent_id: "ag",
    user_id: "u",
    path: `sources/${partial.id}`,
    category: "sources",
    content_md: "x".repeat(100),
    version: 1,
    last_used: null,
    use_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    status: "active",
    ...partial,
  } as WikiPage;
}

/** 创建 synthesizer 测试 harness（内存 fs + mock LLM） */
function createSynthHarness(callLLM?: (prompt: string) => Promise<string>) {
  const repo = new WikiRepo(createMigratedTestDb());
  const files = new Map<string, string>();
  const dirs = new Map<string, Set<string>>();
  const fs = {
    mkdir: async (dir: string) => {
      if (!dirs.has(dir)) dirs.set(dir, new Set());
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
      const parts = path.replace(/\\/g, "/").split("/");
      const file = parts.pop()!;
      const dir = parts.join("/");
      const set = dirs.get(dir) ?? new Set();
      set.add(file);
      dirs.set(dir, set);
    },
    joinPath: (...segs: string[]) => segs.join("/"),
    listDir: async (dir: string) => [...(dirs.get(dir) ?? [])],
  };
  const llm =
    callLLM ??
    vi.fn(async (prompt: string) => {
      if (prompt.includes("合并为一篇")) return "综合摘要正文";
      return "块归纳";
    });
  const synth = new WikiSynthesizer(repo, llm, fs);
  return { repo, synth, files };
}

describe("selectPagesForAutoSynthesis", () => {
  it("排除 archived/outdated，并按遗忘分数截断到 maxPages", () => {
    const pages = [
      page({ id: "a", title: "A", status: "active", use_count: 10 }),
      page({ id: "b", title: "B", status: "archived" }),
      page({ id: "c", title: "C", status: "outdated" }),
      page({ id: "d", title: "D", status: "active", use_count: 0 }),
    ];
    const selected = selectPagesForAutoSynthesis(pages, { maxPages: 1 });
    expect(selected).toHaveLength(1);
    expect(selected[0]!.id).toBe("a");
  });

  it("autoSynthesisPath 稳定", () => {
    expect(autoSynthesisPath("sources")).toBe("syntheses/overview-sources");
    expect(autoSynthesisPath("media")).toBe("syntheses/overview-media");
  });
});

describe("WikiAutoSynthesisRunner", () => {
  it("autoSynthesizeCategory 空分类 skipped；有页则直接 savePage 到稳定路径", async () => {
    const { repo, synth } = createSynthHarness();
    const runner = new WikiAutoSynthesisRunner(synth, repo);

    const empty = await runner.autoSynthesizeCategory("ag", "u", "media");
    expect(empty.skipped).toBe(true);

    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/doc1",
      title: "资料一",
      contentMd: "内容甲\n\n内容乙",
      editor: "user",
    });
    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/doc2",
      title: "资料二",
      contentMd: "内容丙",
      editor: "user",
    });

    const r = await runner.autoSynthesizeCategory("ag", "u", "sources");
    expect(r.path).toBe("syntheses/overview-sources");
    const savedPage = repo.findPageByPath("ag", "u", r.path);
    expect(savedPage?.content_md).toContain("综合摘要正文");
    expect(savedPage?.content_md).toContain("AI");

    const r2 = await runner.autoSynthesizeCategory("ag", "u", "sources");
    expect(r2.path).toBe(r.path);
    expect(repo.findPageByPath("ag", "u", r.path)!.version).toBeGreaterThan(savedPage!.version);
  });

  it("autoSynthesizeAll：sources 成功且 media 跳过时 results 长度为 2", async () => {
    const { repo, synth } = createSynthHarness();
    const runner = new WikiAutoSynthesisRunner(synth, repo);

    repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/doc1",
      title: "资料一",
      contentMd: "内容甲",
      editor: "user",
    });

    const { results } = await runner.autoSynthesizeAll("ag", "u");
    expect(results).toHaveLength(2);

    const sources = results.find((r) => r.category === "sources");
    const media = results.find((r) => r.category === "media");
    expect(sources?.path).toBe("syntheses/overview-sources");
    expect(sources?.skipped).toBeUndefined();
    expect(sources?.pageId).toBeTruthy();
    expect(media?.skipped).toBe(true);
    expect(media?.path).toBe("syntheses/overview-media");
  });
});
