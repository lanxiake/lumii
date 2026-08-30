import { describe, expect, it } from "vitest";
import {
  FILE_REF_EXT,
  URL_REF_EXT,
  buildFileRefDoc,
  parseRefDocument,
  resolveUniqueRefBasename,
  writeFileRef,
  writeUrlRef,
  type WikiRefStoreFs,
} from "./wiki-ref-store.js";

function mockFs(initial: Record<string, string> = {}): WikiRefStoreFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    joinPath: (...parts) => parts.join("/"),
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`missing ${p}`);
      return v;
    },
    writeFile: (p, content) => {
      files.set(p, content);
    },
    rename: (from, to) => {
      const v = files.get(from);
      if (v === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    unlink: (p) => {
      files.delete(p);
    },
  };
}

describe("wiki-ref-store", () => {
  it("buildFileRefDoc 含 targetPath", () => {
    const doc = buildFileRefDoc({ title: "报告", targetPath: "/tmp/a.pdf" });
    expect(doc.refType).toBe("file");
    expect(doc.targetPath).toBe("/tmp/a.pdf");
  });

  it("writeFileRef 写入 JSON", () => {
    const fs = mockFs();
    const abs = writeFileRef(fs, "/vault/inbox", { title: "Q3报告", targetPath: "outputs/q3.pdf" });
    expect(abs).toBe(`/vault/inbox/Q3报告${FILE_REF_EXT}`);
    const parsed = parseRefDocument(fs.readFile(abs));
    expect(parsed?.targetPath).toBe("outputs/q3.pdf");
  });

  it("writeUrlRef 使用 url 后缀", () => {
    const fs = mockFs();
    const abs = writeUrlRef(fs, "/vault/inbox", { title: "示例", targetUrl: "https://e.com/a" });
    expect(abs.endsWith(URL_REF_EXT)).toBe(true);
  });

  it("resolveUniqueRefBasename 避免冲突", () => {
    const fs = mockFs({ "/d/标题.lumii-ref": "{}" });
    expect(resolveUniqueRefBasename(fs, "/d", "标题", FILE_REF_EXT)).toBe("标题-2.lumii-ref");
  });
});
