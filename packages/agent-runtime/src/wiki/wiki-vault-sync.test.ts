import { describe, expect, it } from "vitest";
import { removeSourceVaultArtifacts, syncSourceToVault } from "./wiki-vault-sync.js";
import type { WikiSource } from "./types.js";

function mockVaultFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    joinPath: (...parts: string[]) => parts.join("/"),
    exists: (p: string) => dirs.has(p) || files.has(p),
    mkdir: (p: string) => dirs.add(p),
    writeFile: (p: string, c: string) => files.set(p, c),
    readFile: (p: string) => files.get(p) ?? "",
    rename: (from: string, to: string) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    unlink: (p: string) => files.delete(p),
  };
}

function sampleSource(overrides: Partial<WikiSource> = {}): WikiSource {
  return {
    id: "s1",
    agent_id: "ag",
    user_id: "u",
    title: "Q3报告",
    source_path: "outputs/q3.pdf",
    content_md: null,
    content_hash: null,
    mime_type: null,
    media_type: "document",
    extracted_text: null,
    media_meta: null,
    preview_path: null,
    origin_context: null,
    archived_at: null,
    created_at: "2026-01-01",
    topic_category: null,
    topic_subtopic: null,
    last_used: null,
    use_count: 0,
    origin_url: null,
    storage_mode: "ref",
    ...overrides,
  };
}

describe("syncSourceToVault", () => {
  it("未分类文件写入收件箱 ref", () => {
    const fs = mockVaultFs();
    const deps = {
      vaultRoot: "/ws/wiki",
      workspaceRoot: "/ws",
      fs,
      toRelPath: (abs: string) => abs.replace("/ws/", ""),
      toAbsPath: (rel: string) => `/ws/${rel}`,
    };
    const result = syncSourceToVault(deps, sampleSource());
    // v1.1：收件箱目录不带序号前缀
    expect(result?.relPath).toMatch(/^wiki\/收件箱\/.+\.lumii-ref$/);
    expect(fs.files.size).toBeGreaterThan(0);
  });

  it("链接资料写入 url ref", () => {
    const fs = mockVaultFs();
    const deps = {
      vaultRoot: "/ws/wiki",
      workspaceRoot: "/ws",
      fs,
      toRelPath: (abs: string) => abs.replace("/ws/", ""),
      toAbsPath: (rel: string) => `/ws/${rel}`,
    };
    const result = syncSourceToVault(
      deps,
      sampleSource({ origin_url: "https://example.com/a", source_path: null }),
    );
    expect(result?.relPath).toMatch(/\.url\.lumii-ref$/);
  });

  it("目标主题目录不存在时先建目录再写 ref", () => {
    const fs = mockVaultFs();
    const deps = {
      vaultRoot: "/ws/wiki",
      workspaceRoot: "/ws",
      fs,
      toRelPath: (abs: string) => abs.replace("/ws/", ""),
      toAbsPath: (rel: string) => `/ws/${rel}`,
    };
    const result = syncSourceToVault(
      deps,
      sampleSource({
        title: "拍照姿势21",
        topic_category: "模板参考",
        topic_subtopic: "图片媒体素材",
      }),
    );
    expect(result?.relPath).toContain("收藏/图片媒体素材/");
    expect([...fs.files.keys()].some((p) => p.includes("收藏/图片媒体素材/"))).toBe(true);
  });
});

describe("removeSourceVaultArtifacts", () => {
  it("删除 vault 内的 url-ref 侧车", () => {
    const fs = mockVaultFs();
    const refPath = "/ws/wiki/收藏/示例.url.lumii-ref";
    fs.writeFile(refPath, "{}");
    const deps = {
      vaultRoot: "/ws/wiki",
      workspaceRoot: "/ws",
      fs,
      toRelPath: (abs: string) => abs.replace("/ws/", ""),
      toAbsPath: (rel: string) => `/ws/${rel}`,
    };
    const removed = removeSourceVaultArtifacts(
      deps,
      sampleSource({
        source_path: "wiki/收藏/示例.url.lumii-ref",
        origin_url: "https://example.com",
        storage_mode: "ref",
      }),
    );
    expect(removed).toBe(true);
    expect(fs.files.has(refPath)).toBe(false);
  });

  it("删除 vault 内的 file-ref 侧车，不删外部原始文件", () => {
    const fs = mockVaultFs();
    fs.writeFile("/ws/outputs/q3.pdf", "pdf");
    fs.writeFile("/ws/wiki/收藏/q3.pdf.lumii-ref", "{}");
    const deps = {
      vaultRoot: "/ws/wiki",
      workspaceRoot: "/ws",
      fs,
      toRelPath: (abs: string) => abs.replace("/ws/", ""),
      toAbsPath: (rel: string) => `/ws/${rel}`,
    };
    const removed = removeSourceVaultArtifacts(
      deps,
      sampleSource({
        source_path: "wiki/收藏/q3.pdf.lumii-ref",
        storage_mode: "ref",
      }),
    );
    expect(removed).toBe(true);
    expect(fs.files.has("/ws/wiki/收藏/q3.pdf.lumii-ref")).toBe(false);
    expect(fs.files.has("/ws/outputs/q3.pdf")).toBe(true);
  });

  it("不删除 vault 外的原始文件路径", () => {
    const fs = mockVaultFs();
    fs.writeFile("/ws/outputs/q3.pdf", "pdf");
    const deps = {
      vaultRoot: "/ws/wiki",
      workspaceRoot: "/ws",
      fs,
      toRelPath: (abs: string) => abs.replace("/ws/", ""),
      toAbsPath: (rel: string) => `/ws/${rel}`,
    };
    const removed = removeSourceVaultArtifacts(deps, sampleSource({ source_path: "outputs/q3.pdf" }));
    expect(removed).toBe(false);
    expect(fs.files.has("/ws/outputs/q3.pdf")).toBe(true);
  });
});
