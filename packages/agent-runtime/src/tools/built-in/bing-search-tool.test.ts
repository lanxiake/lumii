import { describe, it, expect, vi } from "vitest";
import axios from "axios";
import { fetchBingSearchHtml, parseBingSearchHtml } from "./bing-search-tool.js";

vi.mock("axios");

/**
 * 本模块不注册为独立工具（`bing_search` 已并入 `web_search` 作为默认第一 provider），
 * 所以测的是 web_search 实际调用的那两个函数，而不是工具包装层。
 */
describe("bing-search-tool", () => {
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

  it("解析搜索结果", () => {
    const results = parseBingSearchHtml(mockHtml, 10);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "测试标题1",
      url: "https://example.com/1",
      snippet: "测试摘要1",
    });
    expect(results[1]).toMatchObject({
      title: "测试标题2",
      url: "https://example.com/2",
    });
  });

  it("count 截断结果数", () => {
    const html = Array.from(
      { length: 5 },
      (_, i) =>
        `<div class="b_algo"><h2><a href="https://example.com/${i}">标题${i}</a></h2>` +
        `<div class="b_caption"><p>摘要${i}</p></div></div>`,
    ).join("");

    expect(parseBingSearchHtml(html, 2)).toHaveLength(2);
  });

  it("无 .b_algo 时返回空数组（不抛，交由调用方判零结果）", () => {
    expect(parseBingSearchHtml("<html><body>nothing</body></html>", 10)).toEqual([]);
  });

  it("抓取失败向上抛，不吞异常", async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error("网络超时"));

    await expect(fetchBingSearchHtml("测试查询", 0)).rejects.toThrow("网络超时");
  });
});
