/**
 * Bing Search Tool — 必应搜索（内置爬虫版）
 *
 * 直接爬取 cn.bing.com 搜索结果，无需 API Key。
 * 同时作为 web_search 的首选 provider（见 web-search-tool.ts）。
 */

import { Type } from "@sinclair/typebox";
import axios from "axios";
import { load } from "cheerio";
import { randomUUID } from "crypto";
import type { MtBotToolConfig } from "../tool-adapter.js";
import type { ToolExecutionContext } from "../../types/tool.js";

interface BingSearchItem {
  uuid: string;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
}

export interface BingSearchResult {
  query: string;
  results: BingSearchItem[];
  totalResults?: number;
}

const BingSearchInput = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  count: Type.Optional(
    Type.Number({ description: "返回结果数量，默认 10 条，最多 50 条", default: 10 }),
  ),
  offset: Type.Optional(
    Type.Number({ description: "结果偏移量，用于分页，默认 0", default: 0 }),
  ),
});

const BING_SEARCH_URL = "https://cn.bing.com/search";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 解析 Bing 搜索结果 HTML，提取标题/链接/摘要。 */
export function parseBingSearchHtml(html: string, count: number): BingSearchItem[] {
  const $ = load(html);
  const results: BingSearchItem[] = [];

  $(".b_algo").each((_index, element) => {
    if (results.length >= count) return false;
    const $el = $(element);
    const title = $el.find("h2 a").text().trim();
    const url = $el.find("h2 a").attr("href") || "";
    const snippet = $el.find(".b_caption p").first().text().trim();
    const displayUrl = $el.find(".b_attribution cite").text().trim();
    if (title && url) {
      results.push({
        uuid: randomUUID(),
        title,
        url,
        snippet,
        displayUrl: displayUrl || url,
      });
    }
  });

  return results.slice(0, count);
}

/** 抓取 Bing 搜索结果页 HTML（axios 直连）。 */
export async function fetchBingSearchHtml(query: string, offset: number): Promise<string> {
  const response = await axios.get(BING_SEARCH_URL, {
    params: { q: query, first: offset + 1 },
    headers: { "User-Agent": USER_AGENT },
    timeout: 15000,
  });
  return response.data as string;
}

/** 格式化搜索结果为文本 */
function formatBingSearchResults(result: BingSearchResult): string {
  if (result.results.length === 0) {
    return `未找到关于"${result.query}"的搜索结果。`;
  }
  const lines: string[] = [`搜索"${result.query}"，共 ${result.results.length} 条结果`, ""];
  for (let i = 0; i < result.results.length; i++) {
    const item = result.results[i];
    lines.push(`${i + 1}. **${item.title}**`);
    lines.push(`   ${item.url}`);
    if (item.snippet) lines.push(`   ${item.snippet}`);
    lines.push("");
  }
  return lines.join("\n");
}

export const bingSearchToolConfig: MtBotToolConfig<typeof BingSearchInput, BingSearchResult> = {
  name: "bing_search",
  label: "Bing Search",
  description:
    "使用必应中文搜索引擎搜索信息，返回标题、链接和摘要。无需 API Key，开箱即用。",
  parameters: BingSearchInput,
  category: "web",
  isReadOnly: true,
  needsPermission: false,

  execute: async (_toolCallId, params, _context: ToolExecutionContext) => {
    const query = params.query.trim();
    const count = Math.min(Math.max(params.count ?? 10, 1), 50);
    const offset = params.offset ?? 0;

    if (!query) throw new Error("搜索关键词不能为空");

    const html = await fetchBingSearchHtml(query, offset);
    const results = parseBingSearchHtml(html, count);
    const result: BingSearchResult = { query, results, totalResults: results.length };

    return {
      content: [{ type: "text", text: formatBingSearchResults(result) }],
      details: result,
    };
  },
};
