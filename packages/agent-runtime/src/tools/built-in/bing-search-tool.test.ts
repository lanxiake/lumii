import { describe, it, expect, vi } from "vitest";
import axios from "axios";
import { bingSearchToolConfig } from "./bing-search-tool.js";

vi.mock("axios");

describe("bing-search-tool", () => {
  it("解析搜索结果", async () => {
    const mockHtml = `
      <div class="b_algo">
        <h2><a href="https://example.com/1">测试标题1</a></h2>
        <div class="b_caption"><p>测试摘要1</p></div>
      </div>
      <div class="b_algo">
        <h2><a href="https://example.com/2">测试标题2</a></h2>
        <div class="b_caption"><p>测试摘要2</p></div>
      </div>
    `;

    vi.mocked(axios.get).mockResolvedValueOnce({ data: mockHtml });

    const result = await bingSearchToolConfig.execute(
      "test-call-id",
      { query: "测试查询", count: 10, offset: 0 },
      {} as any,
    );

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      query: "测试查询",
      totalResults: 2,
    });
    expect(result.details.results).toHaveLength(2);
    expect(result.details.results[0]).toMatchObject({
      title: "测试标题1",
      url: "https://example.com/1",
      snippet: "测试摘要1",
    });
  });

  it("处理网络错误", async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error("网络超时"));

    await expect(
      bingSearchToolConfig.execute(
        "test-call-id",
        { query: "测试查询", count: 10, offset: 0 },
        {} as any,
      ),
    ).rejects.toThrow("网络超时");
  });
});
