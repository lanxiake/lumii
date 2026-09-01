import { describe, expect, it } from "vitest";
import { WikiExporter, sanitizeFilenameSegment, isPathTraversalSafe } from "./wiki-exporter.js";
import type { WikiExporterDeps } from "./wiki-exporter.js";
import type { WikiSource } from "./types.js";

function makeFakeFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const join = (...segments: string[]) => segments.join("/");
  const deps: WikiExporterDeps = {
    mkdir: async (dirPath) => {
      dirs.add(dirPath);
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    joinPath: join,
  };
  return { deps, files, dirs };
}

function makeSource(overrides: Partial<WikiSource> = {}): WikiSource {
  return {
    id: "s1",
    agent_id: "ag",
    user_id: "u",
    title: "资料",
    source_path: null,
    content_md: "正文内容",
    content_hash: null,
    mime_type: null,
    media_type: "document",
    extracted_text: null,
    media_meta: null,
    preview_path: null,
    origin_context: null,
    archived_at: null,
    created_at: "2026-08-26T00:00:00.000Z",
    topic_category: null,
    topic_subtopic: null,
    last_used: null,
    use_count: 0,
    origin_url: null,
    storage_mode: "native",
    legacy_subtopic: null,
    title_locked: 0,
    summary: null,
    summary_hash: null,
    summary_level: null,
    ...overrides,
  };
}

describe("sanitizeFilenameSegment", () => {
  it("替换 Windows 非法字符", () => {
    expect(sanitizeFilenameSegment('a<b>c:d"e|f?g*h')).toBe("a_b_c_d_e_f_g_h");
  });

  it("去除首尾空白与尾部的点", () => {
    expect(sanitizeFilenameSegment("  标题.  ")).toBe("标题");
  });

  it("全非法字符时兜底为下划线", () => {
    expect(sanitizeFilenameSegment("...")).toBe("_");
  });
});

describe("isPathTraversalSafe", () => {
  it("接受普通相对路径", () => {
    expect(isPathTraversalSafe("sources/doc")).toBe(true);
  });

  it("拒绝 .. 、绝对路径、空段", () => {
    expect(isPathTraversalSafe("../etc/passwd")).toBe(false);
    expect(isPathTraversalSafe("sources/../etc")).toBe(false);
    expect(isPathTraversalSafe("/etc/passwd")).toBe(false);
    expect(isPathTraversalSafe("sources//doc")).toBe(false);
  });
});

describe("WikiExporter.exportSources", () => {
  it("按大类/小类生成目录树，正文含标题+摘要+原文", async () => {
    const { deps, files, dirs } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({
      title: "我的资料",
      topic_category: "工作",
      topic_subtopic: "例行",
      summary: "一句话摘要",
      content_md: "正文内容",
    });

    const result = await exporter.exportSources("/out", [source]);

    expect(result).toEqual({ exported: 1, failed: [] });
    expect(dirs.has("/out/工作/例行")).toBe(true);
    const written = files.get("/out/工作/例行/我的资料.md")!;
    expect(written).toContain("# 我的资料");
    expect(written).toContain("一句话摘要");
    expect(written).toContain("正文内容");
  });

  it("收件箱资料（无主题）落到根目录", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({ title: "未分类", topic_category: null, topic_subtopic: null });

    await exporter.exportSources("/out", [source]);
    expect(files.has("/out/未分类.md")).toBe(true);
  });

  it("只有大类没有小类时落到大类目录", async () => {
    const { deps, files, dirs } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({ title: "资料", topic_category: "工作", topic_subtopic: null });

    await exporter.exportSources("/out", [source]);
    expect(dirs.has("/out/工作")).toBe(true);
    expect(files.has("/out/工作/资料.md")).toBe(true);
  });

  it("有 origin_url 时写入原文链接，没有摘要时省略摘要行", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({ title: "网页剪藏", summary: null, origin_url: "https://example.com/a" });

    await exporter.exportSources("/out", [source]);
    const written = files.get("/out/网页剪藏.md")!;
    expect(written).toContain("原文链接: https://example.com/a");
  });

  it("有 source_path 无 origin_url 时写入原始文件路径", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({ title: "本地文件", summary: null, source_path: "C:/files/a.pdf" });

    await exporter.exportSources("/out", [source]);
    const written = files.get("/out/本地文件.md")!;
    expect(written).toContain("原始文件: C:/files/a.pdf");
  });

  it("非法文件名字符被替换", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({ title: 'a<b>c' });

    await exporter.exportSources("/out", [source]);
    expect(files.has("/out/a_b_c.md")).toBe(true);
  });

  it("文件名冲突时追加序号，不覆盖", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const sources = [
      makeSource({ id: "s1", title: "同名", content_md: "第一份" }),
      makeSource({ id: "s2", title: "同名", content_md: "第二份" }),
    ];

    const result = await exporter.exportSources("/out", sources);
    expect(result.exported).toBe(2);
    expect(files.get("/out/同名.md")).toContain("第一份");
    expect(files.get("/out/同名-1.md")).toContain("第二份");
  });

  it("逐条失败不影响其他资料导出，失败清单完整", async () => {
    const { deps } = makeFakeFs();
    let callCount = 0;
    const failingDeps: WikiExporterDeps = {
      ...deps,
      writeFile: async (filePath, content) => {
        callCount += 1;
        if (callCount === 1) throw new Error("磁盘写满");
        return deps.writeFile(filePath, content);
      },
    };
    const exporter = new WikiExporter(failingDeps);
    const sources = [
      makeSource({ id: "s1", title: "失败项" }),
      makeSource({ id: "s2", title: "成功项" }),
    ];

    const result = await exporter.exportSources("/out", sources);
    expect(result.exported).toBe(1);
    expect(result.failed).toEqual([{ path: "失败项", error: "磁盘写满" }]);
  });

  it("写入导出清单 _export-manifest.json", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const source = makeSource({ title: "资料", topic_category: "工作", topic_subtopic: "例行" });

    await exporter.exportSources("/out", [source]);
    const manifestRaw = files.get("/out/_export-manifest.json")!;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.exported).toEqual([{ title: "资料", category: "工作", subtopic: "例行" }]);
    expect(manifest.failed).toEqual([]);
  });
});
