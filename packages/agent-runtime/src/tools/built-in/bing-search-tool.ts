/**
 * Bing Search 内部模块 — 必应搜索爬虫
 *
 * 直接爬取 cn.bing.com 搜索结果，无需 API Key。
 * 已合并到 web_search 工具作为默认第一 provider（见 web-search-tool.ts），
 * 不再作为独立工具注册。fetchBingSearchHtml / parseBingSearchHtml 供 web_search 内部调用。
 */

import axios from "axios";
import { load } from "cheerio";
import { randomUUID } from "crypto";

interface BingSearchItem {
  uuid: string;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
}

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
