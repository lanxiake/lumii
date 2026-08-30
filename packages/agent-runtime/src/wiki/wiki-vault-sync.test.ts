import { describe, expect, it } from "vitest";
import { syncSourceToVault } from "./wiki-vault-sync.js";
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
    expect(result?.relPath).toMatch(/^wiki\/00-收件箱\/.+\.lumii-ref$/);
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
});
