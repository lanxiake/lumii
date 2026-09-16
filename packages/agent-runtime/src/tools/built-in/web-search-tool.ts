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
  offset: Type.Optional(
    Type.Number({
      description: "Result offset for pagination (default: 0, only supported by Bing provider)",
      default: 0,
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
    "搜索网页并返回结构化结果。默认走内置 Bing（无需配置）；备选 LangSearch（需 LANGSEARCH_API_KEY）→ SearXNG（需 SEARXNG_BASE_URL）。支持 offset 翻页（仅 Bing 生效）。\n\n" +
    "本路径实测的边界，照做能省掉整轮白跑：\n" +
    "- 擅长：新产品/新事件、英文技术资料、明确的实体名。\n" +
    "- 不擅长：生僻中文专名、古文原文、带日期的时事长句——会被拆成单字，结果退化成字典页和日历页。\n" +
    "- 不要用 site: 语法（本路径下被忽略）。要限定站点就直接 web_fetch 那个站点的列表页。\n" +
    "- 时事要闻的正路：搜索只用来定位站点，搜「站点名 + 栏目」（如「36氪 快讯」）拿到站点后，用 web_fetch 抓它的列表页/栏目页。\n" +
    "- 结果里集中出现 baike.baidu.com、字典站、日历站时，是查询不对的信号：换词，不要再翻页。",
  parameters: WebSearchInput,
  category: "web",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const startTime = Date.now();
    const query = params.query.trim();
    const count = Math.min(Math.max(params.count ?? 8, 1), 20);
    const language = params.language ?? "zh-CN";
    const offset = Math.max(params.offset ?? 0, 0);

    console.log(`[web_search] execute 开始: query="${query}" count=${count} language=${language} offset=${offset}`);
    console.log(
      `[web_search] 环境变量: LANGSEARCH_API_KEY=${process.env.LANGSEARCH_API_KEY ? "已配置" : "未配置"} SEARXNG_BASE_URL=${resolveSearxngBaseUrl() ?? "未配置"}`,
    );

    if (!query) {
      throw new Error("Search query cannot be empty");
    }

    const { signal, cleanup } = withTimeout(DEFAULT_TIMEOUT_SECONDS * 1000);

    let items: SearchItem[] = [];
    let provider = "unknown";
    let bingError: Error | null = null;
    let langSearchError: Error | null = null;
    let searxngError: Error | null = null;

    // 优先尝试内置 Bing 搜索（无需配置，默认第一项）
    console.log(`[web_search] 尝试内置 Bing 搜索: query="${query}" offset=${offset}`);
    try {
      const { fetchBingSearchHtml, parseBingSearchHtml } = await import("./bing-search-tool.js");
      const html = await fetchBingSearchHtml(query, offset);
      const bingItems = parseBingSearchHtml(html, count);
      if (bingItems.length > 0) {
        items = bingItems.map((item) => ({
          title: item.title,
          url: item.url,
          summary: item.snippet,
        }));
        provider = "Bing (内置)";
        console.log(`[web_search] Bing 成功: ${items.length} 条结果`);
      }
    } catch (err) {
      bingError = err instanceof Error ? err : new Error(String(err));
      console.error(`[web_search] Bing 失败: ${bingError.message}`);
    }

    // Bing 失败时，尝试 LangSearch
    if (items.length === 0 && process.env.LANGSEARCH_API_KEY) {
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

    // LangSearch 失败时，fallback 到 SearXNG
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

    // 所有 provider 都失败
    if (items.length === 0 && (bingError || langSearchError || searxngError)) {
      const errors = [bingError, langSearchError, searxngError]
        .filter(Boolean)
        .map((e) => e!.message);

      const errorMessage = `Web search failed. ${errors.join(" | ")}`;
      const configHint = (!process.env.LANGSEARCH_API_KEY && !searxngBaseUrl)
        ? "\n\nTip: Configure search API keys in Settings → Advanced → Search Tools for better reliability."
        : "";

      throw new Error(errorMessage + configHint);
    }

    // 没有任何 provider 报错、却一条结果都没有。
    //
    // 这不是「搜索成功但没搜到」——Bing 的抓取路径下，解析不出 .b_algo 意味着拿到的
    // 根本不是结果页（验证页 / 跳转页 / 真·无结果页，三者在这里分不开）。
    // 原实现会以 provider="unknown" 静默返回「未找到」并**计为成功**：统计里看不出来，
    // 模型也拿不到任何下一步线索，只能干瞪眼或原样重试。
    // 这里不再假装它是成功的结果，但也不谎称是错误（那会污染失败率），
    // 而是标成一个可辨认、可搜索的独立结局：provider='none' + 一句能照着做的下一步。
    if (items.length === 0) {
      console.warn(
        `[web_search] 无结果且无错误: query="${query}" provider=none（多半是结果页被拦或查询词太生僻）`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              `搜索"${query}"一条条目都没返回。可能这个词太生僻，也可能结果页被拦截了。\n` +
              `换更常见的说法重试；如果是找某个站点上的内容，直接 web_fetch 它的列表页更可靠。`,
          },
        ],
        details: { items: [], query, provider: "none", count: 0, tookMs: Date.now() - startTime },
      };
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
