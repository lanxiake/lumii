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
import { PARKING_CATEGORY } from "./wiki-topic-tree.js";

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

describe("WikiSynthesizer 以资料为输入（二期）", () => {
  function createHarness() {
    const repo = new WikiRepo(createMigratedTestDb());
    const files = new Map<string, string>();
    const dirs = new Map<string, Set<string>>();
    const fs = {
      mkdir: async (dir: string) => {
        if (!dirs.has(dir)) dirs.set(dir, new Set());
      },
      writeFile: async (p: string, content: string) => {
        files.set(p, content);
        const parts = p.replace(/\\/g, "/").split("/");
        const file = parts.pop()!;
        const dir = parts.join("/");
        const set = dirs.get(dir) ?? new Set();
        set.add(file);
        dirs.set(dir, set);
      },
      joinPath: (...segs: string[]) => segs.join("/"),
      listDir: async (dir: string) => [...(dirs.get(dir) ?? [])],
    };
    const callLLM = vi.fn(async (prompt: string) =>
      prompt.includes("合并为一篇") ? "最终综述正文" : "块归纳",
    );
    const synth = new WikiSynthesizer(repo, callLLM, fs);
    const mkFiled = (title: string, text = "调研正文内容") => {
      const s = repo.createSource({ agentId: "ag", userId: "u", title, extractedText: text });
      repo.updateSourceTopic("ag", "u", s.id, "学习资料", "调研搜集材料");
      return s;
    };
    return { repo, synth, files, callLLM, mkFiled };
  }

  it("synthesizeSources 用 extracted_text 分块落盘，记录 source_ids 且不占 source_page_ids", async () => {
    const { repo, synth, mkFiled } = createHarness();
    const a = mkFiled("调研A.pdf");
    const id = await synth.synthesizeSources("ag", "u", [a.id]);

    const row = repo.findSynthesisById(id)!;
    expect(row.status).toBe("candidate");
    expect(row.output_path).toMatch(/^outputs\/wiki-syntheses\//);
    expect(row.source_ids).toContain(a.id);
    expect(row.source_page_ids).toEqual([]);
    expect(row.candidate_md).toBe("最终综述正文");
  });

  it("正文末尾列来源文件名，不生成双链", async () => {
    const { synth, files, mkFiled } = createHarness();
    mkFiled("调研A.pdf");
    const a = mkFiled("调研B.pdf");
    await synth.synthesizeSources("ag", "u", [a.id]);
    const body = [...files.values()][0]!;
    expect(body).toContain("调研B.pdf");
    expect(body).not.toContain("[[");
  });

  it("无正文的媒体退化为标题 + media_meta，不抛错", async () => {
    const { repo, synth } = createHarness();
    const v = repo.createSource({
      agentId: "ag", userId: "u", title: "演示.mp4",
      mediaType: "video", mediaMeta: '{"duration":120}',
    });
    repo.updateSourceTopic("ag", "u", v.id, "学习资料", "调研搜集材料");
    await expect(synth.synthesizeSources("ag", "u", [v.id])).resolves.toBeTruthy();
  });

  it("acceptAsSource 产出带主题的 source，不新建 wiki_pages，page_id 留空", async () => {
    const { repo, synth, mkFiled } = createHarness();
    const a = mkFiled("调研A.pdf");
    const id = await synth.synthesizeSources("ag", "u", [a.id]);
    const pagesBefore = repo.listPages("ag", "u").length;

    const s = synth.acceptAsSource("ag", "u", id, { category: "做事记录", subtopic: "汇报总结文稿" });
    expect(s.topic_category).toBe("做事记录");
    expect(s.topic_subtopic).toBe("汇报总结文稿");
    expect(s.mime_type).toBe("text/markdown");
    expect(repo.listPages("ag", "u")).toHaveLength(pagesBefore);
    expect(repo.findSynthesisById(id)!.status).toBe("accepted");
    expect(repo.findSynthesisById(id)!.page_id).toBeNull();
  });

  it("接受后的综述能被资料层检索命中", async () => {
    const { repo, synth, mkFiled } = createHarness();
    const a = mkFiled("调研A.pdf");
    const id = await synth.synthesizeSources("ag", "u", [a.id]);
    const s = synth.acceptAsSource("ag", "u", id, { category: "做事记录", subtopic: "汇报总结文稿" });
    expect(repo.searchSources("ag", "u", "最终综述").map((h) => h.source.id)).toContain(s.id);
  });

  it("空输入、越权资料、重复接受都拒绝", async () => {
    const { repo, synth, mkFiled } = createHarness();
    await expect(synth.synthesizeSources("ag", "u", [])).rejects.toThrow(/至少需要一个/);

    const other = repo.createSource({ agentId: "other", userId: "u2", title: "别人的" });
    await expect(synth.synthesizeSources("ag", "u", [other.id])).rejects.toThrow(/不存在或无权/);

    const a = mkFiled("调研A.pdf");
    const id = await synth.synthesizeSources("ag", "u", [a.id]);
    const topic = { category: "做事记录", subtopic: "汇报总结文稿" };
    synth.acceptAsSource("ag", "u", id, topic);
    expect(() => synth.acceptAsSource("ag", "u", id, topic)).toThrow(/candidate/);
  });

  it("acceptAsSource 拒绝临时存放与不存在的小类（AI 产物必须落正式目录）", async () => {
    const { synth, mkFiled } = createHarness();
    const a = mkFiled("调研A.pdf");
    const id = await synth.synthesizeSources("ag", "u", [a.id]);

    expect(() =>
      synth.acceptAsSource("ag", "u", id, { category: PARKING_CATEGORY, subtopic: "x" }),
    ).toThrow();
    expect(() =>
      synth.acceptAsSource("ag", "u", id, { category: "学习资料", subtopic: "不存在" }),
    ).toThrow(/小类不存在/);
  });

  it("consolidate 模式标题带 [整合] 前缀，acceptAsSource 可归档原短文", async () => {
    const { repo, synth, mkFiled } = createHarness();
    const a = mkFiled("之怎么读", "短甲");
    const b = mkFiled("之的用法", "短乙");
    const id = await synth.synthesizeSources("ag", "u", [a.id, b.id], {
      title: "之字整合",
      mode: "consolidate",
    });
    const row = repo.findSynthesisById(id)!;
    expect(row.title).toBe("[整合] 之字整合");

    synth.acceptAsSource("ag", "u", id, { category: "学习资料", subtopic: "调研搜集材料" }, {
      archiveSources: true,
    });
    expect(repo.findSourceById(a.id, "ag", "u")?.archived_at).toBeTruthy();
    expect(repo.findSourceById(b.id, "ag", "u")?.archived_at).toBeTruthy();
  });

  it("输入超块数上限时拒绝并提示分批，不留半成品", async () => {
    const { repo, synth, mkFiled } = createHarness();
    const huge = mkFiled("超大调研.pdf", "长".repeat(SYNTHESIS_CHUNK_SIZE * 25));
    await expect(synth.synthesizeSources("ag", "u", [huge.id])).rejects.toThrow(/分批/);
    const rows = repo.listSyntheses("ag", "u");
    expect(rows[0]!.output_path).toBeNull();
    expect(rows[0]!.candidate_md).toBe("");
  });
});
