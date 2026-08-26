/**
 * WikiSynthesizer 单测：分块、截断、slug 冲突、空输入、接受/拒绝状态流转。
 */
import { describe, expect, it, vi } from "vitest";
import { createMigratedTestDb } from "../__tests__/helpers/sqlite-test-db.js";
import { WikiRepo } from "./wiki-repo.js";
import {
  WikiSynthesizer,
  buildAcceptedSynthesisPageMd,
  buildSynthesisFilename,
  chunkByParagraphs,
  parseSynthesisProgress,
  resolveUniqueFilename,
  truncateSynthesis,
  SYNTHESIS_CHUNK_SIZE,
  SYNTHESIS_MAX_OUTPUT_CHARS,
} from "./wiki-synthesizer.js";

describe("chunkByParagraphs", () => {
  it("空输入返回空数组", () => {
    expect(chunkByParagraphs("")).toEqual([]);
    expect(chunkByParagraphs("   ")).toEqual([]);
  });

  it("短文本单块返回", () => {
    expect(chunkByParagraphs("hello")).toEqual(["hello"]);
  });

  it("优先在段落边界断开且不超上限", () => {
    const a = "A".repeat(100);
    const b = "B".repeat(100);
    const chunks = chunkByParagraphs(`${a}\n\n${b}`, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
    expect(chunks.every((c) => c.length <= 150)).toBe(true);
  });

  it("默认可装入 SYNTHESIS_CHUNK_SIZE", () => {
    const text = "x".repeat(SYNTHESIS_CHUNK_SIZE);
    expect(chunkByParagraphs(text)).toHaveLength(1);
    expect(chunkByParagraphs(text + "y")).toHaveLength(2);
  });
});

describe("truncateSynthesis", () => {
  it("超限截断并标记 truncated", () => {
    const long = "字".repeat(SYNTHESIS_MAX_OUTPUT_CHARS + 10);
    const { text, truncated } = truncateSynthesis(long);
    expect(truncated).toBe(true);
    expect(text.length).toBe(SYNTHESIS_MAX_OUTPUT_CHARS);
  });

  it("未超限不截断", () => {
    const { text, truncated } = truncateSynthesis("短");
    expect(truncated).toBe(false);
    expect(text).toBe("短");
  });
});

describe("resolveUniqueFilename", () => {
  it("冲突时追加序号不覆盖", () => {
    const existing = new Set(["a-题.md"]);
    expect(resolveUniqueFilename("a-题.md", existing)).toBe("a-题-2.md");
    existing.add("a-题-2.md");
    expect(resolveUniqueFilename("a-题.md", existing)).toBe("a-题-3.md");
  });

  it("无冲突原样返回", () => {
    expect(resolveUniqueFilename("x.md", new Set())).toBe("x.md");
  });
});

describe("buildSynthesisFilename / buildAcceptedSynthesisPageMd", () => {
  it("文件名含短 id 与清洗标题", () => {
    const name = buildSynthesisFilename("微信语音", "abcd1234");
    expect(name).toMatch(/^abcd1234-/);
    expect(name.endsWith(".md")).toBe(true);
  });

  it("接受页正文含源文件链接与来源双链", () => {
    const md = buildAcceptedSynthesisPageMd({
      title: "综述",
      sourceCount: 2,
      outputRelPath: "outputs/wiki-syntheses/2026-08-26/x.md",
      bodyMd: "归纳正文",
      sourcePages: [{ title: "页A" }, { title: "页B" }],
    });
    expect(md).toContain("[查看完整文档](outputs/wiki-syntheses/2026-08-26/x.md)");
    expect(md).toContain("[[页A]]");
    expect(md).toContain("归纳正文");
  });
});

describe("parseSynthesisProgress", () => {
  it("解析 progress 标记", () => {
    expect(parseSynthesisProgress("progress:2/5")).toEqual({ chunk: 2, total: 5 });
    expect(parseSynthesisProgress("truncated")).toBeNull();
  });
});

describe("WikiSynthesizer 集成", () => {
  function createHarness() {
    let repo: WikiRepo;
    try {
      repo = new WikiRepo(createMigratedTestDb());
    } catch {
      return null;
    }
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
    const callLLM = vi.fn(async (prompt: string) => {
      if (prompt.includes("合并为一篇")) return "最终综述正文";
      return "块归纳";
    });
    const synth = new WikiSynthesizer(repo, callLLM, fs);
    return { repo, synth, files, callLLM };
  }

  it("空页面列表拒绝", async () => {
    await expect(
      new WikiSynthesizer(
        {} as WikiRepo,
        async () => "",
        { mkdir: async () => {}, writeFile: async () => {}, joinPath: (...s) => s.join("/") },
      ).synthesize("ag", "u", []),
    ).rejects.toThrow("合成至少需要一个页面 id");
  });

  it("合成写入 candidate 并落盘，接受建 syntheses 页，拒绝不建页", async () => {
    const harness = createHarness();
    if (!harness) return;
    const { repo, synth, files } = harness;
    const p1 = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/a",
      title: "资料A",
      contentMd: "内容甲\n\n内容乙",
      editor: "user",
    });
    const p2 = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/b",
      title: "资料B",
      contentMd: "内容丙",
      editor: "user",
    });

    const id = await synth.synthesize("ag", "u", [p1.id, p2.id], { title: "主题综述" });
    const row = repo.findSynthesisById(id)!;
    expect(row.status).toBe("candidate");
    expect(row.candidate_md).toBe("最终综述正文");
    expect(row.output_path).toMatch(/^outputs\/wiki-syntheses\//);
    expect(files.has(row.output_path!)).toBe(true);

    const page = synth.accept("ag", "u", id);
    expect(page.path.startsWith("syntheses/")).toBe(true);
    expect(page.content_md).toContain("查看完整文档");
    expect(repo.findSynthesisById(id)?.status).toBe("accepted");
    expect(repo.findSynthesisById(id)?.page_id).toBe(page.id);

    const id2 = await synth.synthesize("ag", "u", [p1.id], { title: "另一篇" });
    synth.reject("ag", "u", id2);
    expect(repo.findSynthesisById(id2)?.status).toBe("rejected");
    expect(repo.listPages("ag", "u", "syntheses")).toHaveLength(1);
  });

  it("超 5000 字截断并标记 error=truncated", async () => {
    const harness = createHarness();
    if (!harness) return;
    const { repo, synth, callLLM } = harness;
    callLLM.mockImplementation(async (prompt: string) => {
      if (prompt.includes("合并为一篇")) return "长".repeat(SYNTHESIS_MAX_OUTPUT_CHARS + 20);
      return "块";
    });
    const p = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/c",
      title: "长文",
      contentMd: "正文",
      editor: "user",
    });
    const id = await synth.synthesize("ag", "u", [p.id]);
    const row = repo.findSynthesisById(id)!;
    expect(row.candidate_md.length).toBe(SYNTHESIS_MAX_OUTPUT_CHARS);
    expect(row.error).toBe("truncated");
  });

  it("slug 冲突追加序号", async () => {
    const harness = createHarness();
    if (!harness) return;
    const { repo, synth, files } = harness;
    const p = repo.savePage({
      agentId: "ag",
      userId: "u",
      path: "sources/d",
      title: "同题",
      contentMd: "x",
      editor: "user",
    });
    const id1 = await synth.synthesize("ag", "u", [p.id], { title: "同题综述" });
    const id2 = await synth.synthesize("ag", "u", [p.id], { title: "同题综述" });
    const path1 = repo.findSynthesisById(id1)!.output_path!;
    const path2 = repo.findSynthesisById(id2)!.output_path!;
    expect(path1).not.toBe(path2);
    expect(files.has(path1)).toBe(true);
    expect(files.has(path2)).toBe(true);
  });
});
