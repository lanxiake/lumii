import { describe, expect, it, vi } from "vitest";
import { WikiClipSaver } from "./wiki-clip-saver.js";

describe("WikiClipSaver", () => {
  it("抓取 HTML 转 md 并落盘", async () => {
    let written = "";
    const saver = new WikiClipSaver({
      fetchImpl: async () =>
        new Response("<html><head><title>示例</title></head><body><p>正文</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      writeFile: async (_rel, content) => {
        written = content;
        return "/tmp/wiki-clips/示例.md";
      },
    });
    const r = await saver.save("https://example.com/a", "兜底标题");
    expect(r.title).toBe("示例");
    expect(written).toContain("正文");
    expect(r.savedPath).toMatch(/^\/tmp\//);
  });

  it("非 http(s) 直接拒绝", async () => {
    const fetchImpl = vi.fn();
    const saver = new WikiClipSaver({ fetchImpl, writeFile: async () => "" });
    await expect(saver.save("file:///etc/passwd", "t")).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
