/**
 * Web Search Tool — 网页搜索
 *
 * 主要搜索引擎：LangSearch API（国内可用，免费）
 * 备用搜索引擎：SearXNG（自托管，通过 SEARXNG_BASE_URL 环境变量配置）
 * 可选：由宿主通过 ToolRunner 的 cache hook 配置 TTL 缓存（见 apps/windows bridge）
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { DEFAULT_TIMEOUT_SECONDS, validateUrl, withTimeout } from "./web-shared.js";

interface SearchItem {
  title: string;
  url: string;
  summary: string;
}

interface SearchResult {
  items: SearchItem[];
  query: string;
  provider: string;
  count: number;
  tookMs: number;
}

const WebSearchInput = Type.Object({
  query: Type.String({ description: "Search query" }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (default: 8, max: 20)",
      default: 8,
    }),
  ),
  language: Type.Optional(
    Type.String({
      description: "Language for results, e.g. 'zh-CN', 'en-US' (default: zh-CN)",
      default: "zh-CN",
    }),
  ),
});

/** LangSearch API 响应类型 */
interface LangSearchResponse {
  code: number;
  message: string;
  data?: {
    webPages?: {
      value?: Array<{
        name?: string;
        url?: string;
        snippet?: string;
      }>;
    };
  };
}

/** SearXNG 响应类型 */
interface SearXNGResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

type FetchFn = (url: string, opts?: RequestInit) => Promise<{ status: number; body: string }>;

/** 通过 LangSearch API 搜索 */
async function searchViaLangSearch(
  query: string,
  count: number,
  language: string,
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  const apiKey = process.env.LANGSEARCH_API_KEY;
  if (!apiKey) {
    throw new Error("LANGSEARCH_API_KEY environment variable not configured");
  }

  const body = JSON.stringify({
    query,
    count: Math.min(count, 20),
    freshness: "noLimit",
    outputLanguage: language,
    summary: true,
  });

  let response: { status: number; body: string };
  try {
    response = await fetchFn("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal,
    } as RequestInit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LangSearch request failed: ${message}`);
  }

  if (response.status !== 200) {
    throw new Error(`LangSearch API error: HTTP ${response.status}`);
  }

  let parsed: LangSearchResponse;
  try {
    parsed = JSON.parse(response.body) as LangSearchResponse;
  } catch {
    throw new Error("LangSearch API returned invalid JSON");
  }

  if (parsed.code !== 200) {
    throw new Error(`LangSearch API error: ${parsed.message}`);
  }

  const values = parsed.data?.webPages?.value ?? [];
  return values.map((item) => ({
    title: item.name ?? "",
    url: item.url ?? "",
    summary: item.snippet ?? "",
  }));
}

/** 通过 SearXNG 搜索 */
async function searchViaSearXNG(
  query: string,
  count: number,
  language: string,
  baseUrl: string,
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<SearchItem[]> {
  // 校验 SearXNG baseUrl 合法性
  validateUrl(baseUrl);

  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: language,
    pageno: "1",
  });

  const url = `${baseUrl.replace(/\/$/, "")}/search?${params.toString()}`;
  console.log("[web_search] SearXNG request:", url);

  let response: { status: number; body: string };
  try {
    response = await fetchFn(url, { signal } as RequestInit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SearXNG request failed: ${message}`);
  }

  if (response.status !== 200) {
    const detail = response.status === 0 ? ` (${response.body.slice(0, 120)})` : "";
    throw new Error(`SearXNG error: HTTP ${response.status}${detail}`);
  }

  let parsed: SearXNGResponse;
  try {
    parsed = JSON.parse(response.body) as SearXNGResponse;
  } catch {
    throw new Error("SearXNG returned invalid JSON");
  }

  const results = parsed.results ?? [];
  console.log(`[web_search] SearXNG 解析结果: totalResults=${results.length} 取前${count}条`);
  return results.slice(0, count).map((item) => ({
    title: item.title ?? "",
    url: item.url ?? "",
    summary: item.content ?? "",
  }));
}

/** 格式化搜索结果为文本 */
function formatSearchResults(result: SearchResult): string {
  if (result.items.length === 0) {
    return `未找到关于"${result.query}"的搜索结果。`;
  }

  const lines: string[] = [
    `搜索"${result.query}"，共 ${result.items.length} 条结果（来源：${result.provider}，耗时 ${result.tookMs}ms）`,
    "",
  ];

  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    lines.push(`${i + 1}. **${item.title}**`);
    lines.push(`   ${item.url}`);
    if (item.summary) {
      lines.push(`   ${item.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** 规范化 SearXNG 基址（生产环境裸域名 mtbot.top 不可用，须 www） */
function resolveSearxngBaseUrl(): string | undefined {
  const raw = process.env.SEARXNG_BASE_URL?.trim();
  if (!raw) return undefined;
  return raw
    .replace(/^http:\/\/mtbot\.top\//i, "http://www.mtbot.top/")
    .replace(/^https:\/\/mtbot\.top\//i, "https://www.mtbot.top/")
    .replace(/\/+$/, "");
}

export const webSearchToolConfig: MtBotToolConfig<typeof WebSearchInput> = {
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web and return structured results. Uses LangSearch API (requires LANGSEARCH_API_KEY) or SearXNG (requires SEARXNG_BASE_URL).",
  parameters: WebSearchInput,
  category: "web",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const startTime = Date.now();
    const query = params.query.trim();
    const count = Math.min(Math.max(params.count ?? 8, 1), 20);
    const language = params.language ?? "zh-CN";

    console.log(`[web_search] execute 开始: query="${query}" count=${count} language=${language}`);
    console.log(
      `[web_search] 环境变量: LANGSEARCH_API_KEY=${process.env.LANGSEARCH_API_KEY ? "已配置" : "未配置"} SEARXNG_BASE_URL=${resolveSearxngBaseUrl() ?? "未配置"}`,
    );

    if (!query) {
      throw new Error("Search query cannot be empty");
    }

    const { signal, cleanup } = withTimeout(DEFAULT_TIMEOUT_SECONDS * 1000);

    let items: SearchItem[] = [];
    let provider = "unknown";
    let langSearchError: Error | null = null;
    let searxngError: Error | null = null;

    // 优先尝试 LangSearch
    if (process.env.LANGSEARCH_API_KEY) {
      console.log(`[web_search] 尝试 LangSearch: query="${query}"`);
      try {
        items = await searchViaLangSearch(
          query,
          count,
          language,
          context.fetch.bind(context),
          signal,
        );
        provider = "LangSearch";
        console.log(`[web_search] LangSearch 成功: ${items.length} 条结果`);
      } catch (err) {
        langSearchError = err instanceof Error ? err : new Error(String(err));
        console.error(`[web_search] LangSearch 失败: ${langSearchError.message}`);
      }
    }

    const searxngBaseUrl = resolveSearxngBaseUrl();

    // LangSearch 未配置或失败时，fallback 到 SearXNG
    if (items.length === 0 && searxngBaseUrl) {
      console.log(
        `[web_search] 尝试 SearXNG: query="${query}" baseUrl=${searxngBaseUrl}`,
      );
      try {
        items = await searchViaSearXNG(
          query,
          count,
          language,
          searxngBaseUrl,
          context.fetch.bind(context),
          signal,
        );
        provider = "SearXNG";
        console.log(`[web_search] SearXNG 成功: ${items.length} 条结果`);
      } catch (err) {
        searxngError = err instanceof Error ? err : new Error(String(err));
        console.error("[web_search] SearXNG error:", searxngError.message);
      }
    }

    cleanup();

    // 未配置任何 provider
    if (!process.env.LANGSEARCH_API_KEY && !searxngBaseUrl) {
      throw new Error(
        "No search provider configured. Set LANGSEARCH_API_KEY or SEARXNG_BASE_URL environment variable.",
      );
    }

    // 所有 provider 都失败
    if (items.length === 0 && (langSearchError || searxngError)) {
      const errors = [langSearchError, searxngError].filter(Boolean).map((e) => e!.message);
      throw new Error(`Web search failed. Errors: ${errors.join(" | ")}`);
    }

    const result: SearchResult = {
      items,
      query,
      provider,
      count: items.length,
      tookMs: Date.now() - startTime,
    };
    console.log(
      `[web_search] 搜索完成: query="${query}" provider=${provider} count=${result.count} tookMs=${result.tookMs}`,
    );

    const text = formatSearchResults(result);

    return {
      content: [{ type: "text", text }],
      details: result,
    };
  },
};
