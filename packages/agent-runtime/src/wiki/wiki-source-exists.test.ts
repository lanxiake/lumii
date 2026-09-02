import { describe, expect, it } from "vitest";
import type { WikiSource } from "./types.js";
import { resolveWikiSourceFileExists } from "./wiki-source-exists.js";

function source(partial: Partial<WikiSource> & Pick<WikiSource, "id" | "title">): WikiSource {
  return {
    agent_id: "ag",
    user_id: "u",
    source_path: null,
    content_md: null,
    content_hash: null,
    mime_type: null,
    media_type: "document",
    extracted_text: null,
    topic_category: null,
    topic_subtopic: null,
    archived_at: null,
    origin_url: null,
    storage_mode: "ref",
    use_count: 0,
    last_used: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("resolveWikiSourceFileExists", () => {
  it("URL 资料不判失效", () => {
    const exists = resolveWikiSourceFileExists(
      source({ id: "1", title: "网页", origin_url: "https://example.com" }),
      { fileExists: () => false, toAbsPath: (p) => p },
    );
    expect(exists).toBe(true);
  });

  it("解引用 .lumii-ref 后检查底层文件", () => {
    const refPath = "wiki/inbox/temp.lumii-ref";
    const targetPath = "outputs/deleted.md";
    const exists = resolveWikiSourceFileExists(
      source({ id: "2", title: "临时", source_path: refPath }),
      {
        fileExists: (p) => p.endsWith("temp.lumii-ref"),
        readRefTarget: () => targetPath,
        toAbsPath: (p) => p,
      },
    );
    expect(exists).toBe(false);
  });
});
