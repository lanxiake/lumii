/**
 * web_search 的「零结果」这条路径。
 *
 * 它既不是成功也不是失败，原实现却把它算成成功（provider="unknown" 下返回「未找到」）——
 * 统计里看不出来、模型也拿不到下一步线索。这些用例守住「标成可辨认的第三种结局」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchBingSearchHtmlMock = vi.fn<(query: string, offset: number) => Promise<string>>()
const parseBingSearchHtmlMock = vi.fn<(html: string, count: number) => unknown[]>()

vi.mock("./bing-search-tool.js", () => ({
  fetchBingSearchHtml: (query: string, offset: number) => fetchBingSearchHtmlMock(query, offset),
  parseBingSearchHtml: (html: string, count: number) => parseBingSearchHtmlMock(html, count),
}));

const { webSearchToolConfig } = await import("./web-search-tool.js");

const ctx = { fetch: async () => ({ status: 200, body: "{}" }) } as never;

beforeEach(() => {
  vi.stubEnv("LANGSEARCH_API_KEY", "");
  vi.stubEnv("SEARXNG_BASE_URL", "");
  fetchBingSearchHtmlMock.mockReset();
  parseBingSearchHtmlMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("web_search · 零结果", () => {
  it("Bing 返回了页面但解析不出条目：不抛错，但标成 provider='none' 并给出下一步", async () => {
    fetchBingSearchHtmlMock.mockResolvedValue("<html>验证页</html>")
    parseBingSearchHtmlMock.mockReturnValue([])

    const result = await webSearchToolConfig.execute("tc", { query: "生僻词" }, ctx)
    const text = (result.content[0] as { text: string }).text

    // 不抛错：这是「第三种结局」，不是失败，不该污染失败率
    expect(text).toContain("一条条目都没返回")
    expect(text).toContain("web_fetch")
    // provider 不再是 'unknown' —— 那是「试过了但没成」和「没试」共用的值，查不出真相
    expect((result.details as { provider: string }).provider).toBe("none")
    expect((result.details as { count: number }).count).toBe(0)
  })

  it("Bing 抛错时仍然抛错（真失败不能被降级成「零结果」）", async () => {
    fetchBingSearchHtmlMock.mockRejectedValue(new Error("ECONNRESET"))

    await expect(webSearchToolConfig.execute("tc", { query: "x" }, ctx)).rejects.toThrow(
      /Web search failed/,
    )
  })

  it("有结果时一切照旧", async () => {
    fetchBingSearchHtmlMock.mockResolvedValue("<html/>")
    parseBingSearchHtmlMock.mockReturnValue([
      { title: "标题", url: "https://example.com/a", snippet: "摘要" },
    ])

    const result = await webSearchToolConfig.execute("tc", { query: "x" }, ctx)

    expect((result.details as { provider: string }).provider).toBe("Bing (内置)")
    expect((result.details as { count: number }).count).toBe(1)
  })
})
