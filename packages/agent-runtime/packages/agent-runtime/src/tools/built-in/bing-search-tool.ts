/**
 * Bing Search Tool — 必应搜索（内置爬虫版）
 *
 * 直接爬取 cn.bing.com 搜索结果，无需 API Key
 * 作为 web_search 的默认后备实现
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import axios from "axios";
import * as cheerio from "cheerio";
import { randomUUID } from "crypto";

interface BingSearchItem {
  uuid: string;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
}

interface BingSearchResult {
  query: string;
  results: BingSearchItem[];
  totalResults?: number;
  provider: string;
  tookMs: number;
}

const BingSearchInput = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  count: Type.Optional(
    Type.Number({
      description: "返回结果数量，默认 10 条，最多 50 条",
      default: 10,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: "结果偏移量，用于分页，默认 0",
      default: 0,
    }),
  ),
});

const BING_SEARCH_URL = "https://cn.bing.com/search";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 执行必应搜索并解析结果 */
async function fetchAndParseBingSearch(
  query: string,
  count: number,
  offset: number,
  signal: AbortSignal,
): Promise<BingSearchItem[]> {
  const params = {
    q: query,
    first: offset + 1,
  };

  const config = {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
    timeout: 15000,
    signal,
  };

  const response = await axios.get(BING_SEARCH_URL, { ...config, params });
  const html = response.data;

  const $ = cheerio.load(html);
  const results: BingSearchItem[] = [];

  $(".b_algo").each((_index, element) => {
    try {
      const $element = $(element);
      const $titleLink = $element.find("h2 a");
      const title = $titleLink.text().trim();
      const url = $titleLink.attr("href") || "";
      const snippet = $element.find(".b_caption p").first().text().trim();
      const displayUrl = $element.find(".b_attribution cite").text().trim();

      if (title && url) {
        results.push({
          uuid: randomUUID(),
          title,
          url,
          snippet: snippet || "",
          displayUrl: displayUrl || url,
        });
      }
    } catch (error) {
      console.error("[bing_search] 解析单条结果出错:", error);
    }
  });

  return results.slice(0, count);
}

/** 格式化搜索结果为文本 */
function formatBingSearchResults(result: BingSearchResult): string {
  if (result.results.length === 0) {
    return `未找到关于"${result.query}"的搜索结果。`;
  }

  const lines: string[] = [
    `搜索"${result.query}"，共 ${result.results.length} 条结果（来源：${result.provider}，耗时 ${result.tookMs}ms）`,
    "",
  ];

  for (let i = 0; i < result.results.length; i++) {
    const item = result.results[i];
    lines.push(`${i + 1}. **${item.title}**`);
    lines.push(`   ${item.url}`);
    if (item.snippet) {
      lines.push(`   ${item.snippet}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export const bingSearchToolConfig: MtBotToolConfig<typeof BingSearchInput> = {
  name: "bing_search",
  label: "Bing Search",
  description:
    "使用必应中文搜索引擎搜索信息。返回搜索结果包括标题、链接和摘要。无需 API Key，开箱即用。",
  parameters: BingSearchInput,
  category: "web",
  isReadOnly: true,
  needsPermission: false,

  execute: async (_toolCallId, params, _context) => {
    const startTime = Date.now();
    const query = params.query.trim();
    const count = Math.min(Math.max(params.count ?? 10, 1), 50);
    const offset = params.offset ?? 0;

    console.log(
      `[bing_search] 开始搜索: query="${query}" count=${count} offset=${offset}`,
    );

    if (!query) {
      throw new Error("搜索关键词不能为空");
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

    try {
      const results = await fetchAndParseBingSearch(
        query,
        count,
        offset,
        abortController.signal,
      );

      const result: BingSearchResult = {
        query,
        results,
        totalResults: results.length,
        provider: "Bing (内置爬虫)",
        tookMs: Date.now() - startTime,
      };

      console.log(
        `[bing_search] 搜索完成: ${result.results.length} 条结果，耗时 ${result.tookMs}ms`,
      );

      const text = formatBingSearchResults(result);

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("[bing_search] 搜索失败:", errorMessage);

      if (axios.isAxiosError(error)) {
        throw new Error(
          `必应搜索请求失败: ${error.message}` +
            (error.response ? ` (状态码: ${error.response.status})` : ""),
        );
      }

      throw new Error(`必应搜索失败: ${errorMessage}`);
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
