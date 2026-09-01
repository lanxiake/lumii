/**
 * WikiSummarizer.getOrBuildSummary：三层降级、缓存判据、LLM 失败降级、不写回正文
 */
import { describe, expect, it, vi } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import { WikiSummarizer } from "./wiki-summary.js";
import type { WikiSource } from "./types.js";

function makeSource(repo: WikiRepo, overrides: Partial<Parameters<WikiRepo["createSource"]>[0]> = {}): WikiSource {
  return repo.createSource({
    agentId: "a",
    userId: "u",
    title: "t",
    ...overrides,
  });
}

describe("WikiSummarizer.getOrBuildSummary", () => {
  it("缓存命中不重算", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = makeSource(repo, { contentMd: "本周完成了登录改造。", contentHash: "h1" });
    repo.updateSourceSummary(source.id, "已有摘要", "h1", "heuristic");
    const cached = repo.findSourceById(source.id)!;

    const callLLM = vi.fn();
    const summarizer = new WikiSummarizer(repo, callLLM);
    const r = await summarizer.getOrBuildSummary(cached, { allowLlm: true });

    expect(r?.summary).toBe("已有摘要");
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("content_hash 变化则重算", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = makeSource(repo, { contentMd: "本周完成了登录改造。", contentHash: "h2" });
    repo.updateSourceSummary(source.id, "旧摘要", "h1", "heuristic");
    const stale = repo.findSourceById(source.id)!;

    const summarizer = new WikiSummarizer(repo, null);
    const r = await summarizer.getOrBuildSummary(stale, { allowLlm: false });

    expect(r?.summary).not.toBe("旧摘要");
    expect(r?.summary).toBe("本周完成了登录改造。");
  });

  it("allowLlm=false 时长正文降级到 extractive，不调 LLM", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const longText = Array.from({ length: 10 }, (_, i) => `第${i}句内容足够长用于占位测试提取逻辑。`).join(
      "",
    ).repeat(12);
    const source = makeSource(repo, { contentMd: longText, contentHash: "h3" });

    const callLLM = vi.fn();
    const summarizer = new WikiSummarizer(repo, callLLM);
    const r = await summarizer.getOrBuildSummary(source, { allowLlm: false });

    expect(callLLM).not.toHaveBeenCalled();
    expect(r?.level).toBe("extractive");
  });

  it("LLM 调用失败降级 extractive 而非抛错", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const longText = Array.from({ length: 10 }, (_, i) => `第${i}句内容足够长用于占位测试提取逻辑。`).join(
      "",
    ).repeat(12);
    const source = makeSource(repo, { contentMd: longText, contentHash: "h4" });

    const callLLM = vi.fn().mockRejectedValue(new Error("timeout"));
    const summarizer = new WikiSummarizer(repo, callLLM);
    const r = await summarizer.getOrBuildSummary(source, { allowLlm: true });

    expect(callLLM).toHaveBeenCalled();
    expect(r?.level).toBe("extractive");
  });

  it("超长正文 allowLlm=true 时走 llm 层", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const longText = Array.from({ length: 10 }, (_, i) => `第${i}句内容足够长用于占位测试提取逻辑。`).join(
      "",
    ).repeat(12);
    const source = makeSource(repo, { contentMd: longText, contentHash: "h5" });

    const callLLM = vi.fn().mockResolvedValue("这是一句 LLM 生成的摘要。");
    const summarizer = new WikiSummarizer(repo, callLLM);
    const r = await summarizer.getOrBuildSummary(source, { allowLlm: true });

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(r?.level).toBe("llm");
    expect(r?.summary).toBe("这是一句 LLM 生成的摘要。");
  });

  it("无正文返回 null 且不写库", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = makeSource(repo, { mediaType: "image" });

    const summarizer = new WikiSummarizer(repo, null);
    const r = await summarizer.getOrBuildSummary(source, { allowLlm: true });

    expect(r).toBeNull();
    const after = repo.findSourceById(source.id)!;
    expect(after.summary).toBeNull();
  });

  it("摘要不写回正文", async () => {
    const repo = new WikiRepo(createMigratedTestDb());
    const source = makeSource(repo, { contentMd: "本周完成了登录改造。", contentHash: "h6" });

    const summarizer = new WikiSummarizer(repo, null);
    await summarizer.getOrBuildSummary(source, { allowLlm: true });

    const after = repo.findSourceById(source.id)!;
    expect(after.content_md).toBe(source.content_md);
    expect(after.extracted_text).toBe(source.extracted_text);
  });
});
