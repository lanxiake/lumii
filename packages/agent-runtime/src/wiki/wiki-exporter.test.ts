import { describe, expect, it } from "vitest";
import { WikiExporter, sanitizeFilenameSegment, isPathTraversalSafe } from "./wiki-exporter.js";
import type { WikiExporterDeps } from "./wiki-exporter.js";
import type { WikiPage, WikiSource } from "./types.js";

function makeFakeFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const copied: { src: string; dest: string }[] = [];
  const join = (...segments: string[]) => segments.join("/");
  const deps: WikiExporterDeps = {
    mkdir: async (dirPath) => {
      dirs.add(dirPath);
    },
    writeFile: async (filePath, content) => {
      files.set(filePath, content);
    },
    copyFile: async (src, dest) => {
      copied.push({ src, dest });
    },
    joinPath: join,
  };
  return { deps, files, dirs, copied };
}

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id: "p1",
    agent_id: "ag",
    user_id: "u",
    path: "sources/doc",
    category: "sources",
    title: "文档",
    content_md: "正文内容",
    version: 1,
    last_used: null,
    use_count: 0,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    status: "active",
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

describe("WikiExporter", () => {
  it("按路径结构生成目录树，写出 md 与 frontmatter", async () => {
    const { deps, files, dirs } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const page = makePage({ path: "sources/subdir/doc", title: "我的文档" });

    const result = await exporter.exportPages("/out", [page]);

    expect(result).toEqual({ exported: 1, failed: [] });
    expect(dirs.has("/out/sources/subdir")).toBe(true);
    const written = files.get("/out/sources/subdir/我的文档.md")!;
    expect(written).toContain("title: 我的文档");
    expect(written).toContain("category: sources");
    expect(written).toContain("正文内容");
  });

  it("非法文件名字符被替换", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const page = makePage({ path: "sources/doc", title: 'a<b>c' });

    await exporter.exportPages("/out", [page]);
    expect(files.has("/out/sources/a_b_c.md")).toBe(true);
  });

  it("文件名冲突时追加序号，不覆盖", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const pages = [
      makePage({ id: "p1", path: "sources/a", title: "同名", content_md: "第一份" }),
      makePage({ id: "p2", path: "sources/b", title: "同名", content_md: "第二份" }),
    ];

    const result = await exporter.exportPages("/out", pages);
    expect(result.exported).toBe(2);
    expect(files.get("/out/sources/同名.md")).toContain("第一份");
    expect(files.get("/out/sources/同名-1.md")).toContain("第二份");
  });

  it("路径逃逸被拒绝，计入失败清单", async () => {
    const { deps } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const page = makePage({ path: "sources/../../etc/passwd", title: "恶意" });

    const result = await exporter.exportPages("/out", [page]);
    expect(result.exported).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("路径逃逸");
  });

  it("逐页失败不影响其他页导出，失败清单完整", async () => {
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
    const pages = [
      makePage({ id: "p1", path: "sources/a", title: "失败页" }),
      makePage({ id: "p2", path: "sources/b", title: "成功页" }),
    ];

    const result = await exporter.exportPages("/out", pages);
    expect(result.exported).toBe(1);
    expect(result.failed).toEqual([{ path: "sources/a", error: "磁盘写满" }]);
  });

  it("写入导出清单 _export-manifest.json", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const page = makePage();

    await exporter.exportPages("/out", [page]);
    const manifestRaw = files.get("/out/_export-manifest.json")!;
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.exported).toEqual([{ path: "sources/doc", title: "文档", version: 1 }]);
    expect(manifest.failed).toEqual([]);
  });

  it("可选携带附件文件（复制到 _attachments 子目录）", async () => {
    const { deps, copied } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const page = makePage({ id: "p1", path: "media/pic", title: "图片页" });
    const attachmentsByPageId = new Map([
      ["p1", [{ filePath: "/tmp/a.png", displayName: "a.png" }]],
    ]);

    await exporter.exportPages("/out", [page], { includeAttachments: true }, { attachmentsByPageId });
    expect(copied).toEqual([{ src: "/tmp/a.png", dest: "/out/media/_attachments/a.png" }]);
  });

  it("可选携带资料原文到 _sources 子目录", async () => {
    const { deps, files } = makeFakeFs();
    const exporter = new WikiExporter(deps);
    const page = makePage();
    const sources: WikiSource[] = [
      {
        id: "s1",
        agent_id: "ag",
        user_id: "u",
        title: "原始资料",
        source_path: null,
        content_md: "资料原文",
        content_hash: null,
        mime_type: null,
        media_type: "document",
        extracted_text: null,
        media_meta: null,
        preview_path: null,
        origin_context: null,
        archived_at: null,
        created_at: "2026-08-26T00:00:00.000Z",
      },
    ];

    await exporter.exportPages("/out", [page], { includeSources: true }, { sources });
    expect(files.get("/out/_sources/原始资料.md")).toBe("资料原文");
  });
});
