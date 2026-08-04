/**
 * Web Fetch Tool — 网页抓取
 *
 * 参考 Claude Code 实现：HTML → Markdown 提取，支持纯文本和 Markdown 两种模式
 * 可选：由宿主通过 ToolRunner cache hook 做 TTL 缓存（见 apps/windows bridge）
 */

import { Type } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../tool-adapter.js";
import { DEFAULT_TIMEOUT_SECONDS, validateUrl, withTimeout } from "./web-shared.js";

/** 默认最大返回字符数 */
const DEFAULT_MAX_CHARS = 20000;

/** 缓存中存储的原始提取结果（不含截断） */
interface FetchResultRaw {
  text: string;
  title?: string;
  url: string;
  status: number;
  extractMode: "markdown" | "text";
  tookMs: number;
}

interface FetchResult extends FetchResultRaw {
  truncated: boolean;
}

const WebFetchInput = Type.Object({
  url: Type.String({ description: "The URL to fetch content from. ONLY http:// and https:// protocols are supported. Do NOT use file:// URLs — use the read_file tool for local files instead." }),
  extractMode: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
      description:
        "Extraction mode: 'markdown' (default) for structured content, 'text' for plain text only",
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (default: 20000)",
      default: DEFAULT_MAX_CHARS,
    }),
  ),
});

/** HTML entity 解码 */
function decodeEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    copy: "©",
    reg: "®",
    trade: "™",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    ldquo: "\u201c",
    rdquo: "\u201d",
    lsquo: "\u2018",
    rsquo: "\u2019",
  };

  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(parseInt(entity.slice(1), 10));
    }
    return entities[entity] ?? match;
  });
}

/** 移除所有 HTML 标签 */
function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

/** 规范化行内空白（保留换行符） */
function normalizeInlineWhitespace(value: string): string {
  return value.replace(/[^\S\n]+/g, " ").trim();
}

/** HTML 转 Markdown */
function htmlToMarkdown(html: string): { text: string; title?: string } {
  // 提取 title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, " ").trim()
    : undefined;

  // 移除 script, style, noscript, template
  let text = html.replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // 移除 HTML 注释
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // 转换标题 h1-h6
  for (let level = 1; level <= 6; level++) {
    const prefix = "#".repeat(level);
    const tag = `h${level}`;
    text = text.replace(
      new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"),
      (_, content) =>
        `\n\n${prefix} ${normalizeInlineWhitespace(decodeEntities(stripTags(content)))}\n\n`,
    );
  }

  // 转换链接 <a href="...">text</a> → [text](href)，兼容单引号和双引号
  text = text.replace(/<a[^>]+href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, content) => {
    const linkText = normalizeInlineWhitespace(decodeEntities(stripTags(content)));
    if (!href || href.startsWith("javascript:") || href === "#") {
      return linkText;
    }
    return `[${linkText}](${href})`;
  });

  // 转换图片，兼容 alt 在 src 之前的情况
  text = text.replace(/<img[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/src=["']([^"']*)["']/);
    const altMatch = tag.match(/alt=["']([^"']*)["']/);
    const src = srcMatch?.[1] ?? "";
    const alt = altMatch?.[1] ?? "";
    return src ? `![${alt}](${src})` : "";
  });

  // 转换列表项
  text = text.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_, content) => `\n- ${normalizeInlineWhitespace(decodeEntities(stripTags(content)))}`,
  );

  // 转换块级换行元素
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/div>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(
    /<td[^>]*>([\s\S]*?)<\/td>/gi,
    (_, content) => `${decodeEntities(stripTags(content)).trim()} | `,
  );

  // 移除剩余标签
  text = stripTags(text);

  // 解码剩余实体
  text = decodeEntities(text);

  // 规范化：合并多余空行，保留 Markdown 结构（不压缩换行为空格）
  text = text.replace(/[^\S\n]+/g, " "); // 行内多余空格
  text = text.replace(/^ +| +$/gm, ""); // 行首行尾空格
  text = text.replace(/\n{3,}/g, "\n\n"); // 最多两个连续空行
  text = text.trim();

  return { text, title };
}

/** Markdown 转纯文本 */
function markdownToText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "") // 移除图片
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // 链接 → 文本
    .replace(/```[\s\S]*?```/g, "") // 代码块
    .replace(/`([^`]+)`/g, "$1") // 行内代码
    .replace(/^#{1,6}\s+/gm, "") // 标题标记
    .replace(/(\*\*|__)([^*_]+)\1/g, "$2") // 粗体
    .replace(/(\*|_)([^*_]+)\1/g, "$2") // 斜体
    .replace(/^[-*+]\s+/gm, "") // 无序列表
    .replace(/^\d+\.\s+/gm, "") // 有序列表
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 截断文本 */
function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const slice = value.slice(0, maxChars);
  // 尝试在单词/句子边界截断
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return { text: slice.slice(0, lastSpace).trim(), truncated: true };
  }
  return { text: slice.trim(), truncated: true };
}

export const webFetchToolConfig: MtBotToolConfig<typeof WebFetchInput> = {
  name: "web_fetch",
  label: "Web Fetch",
  description: "Fetch content from a URL and extract readable content as Markdown or plain text.",
  parameters: WebFetchInput,
  category: "web",
  isReadOnly: true,
  needsPermission: false,
  execute: async (_toolCallId, params, context) => {
    const startTime = Date.now();
    const extractMode = params.extractMode ?? "markdown";
    const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

    // URL 校验（防止 SSRF）
    validateUrl(params.url);
    const url = params.url;

    // 获取页面（带超时，完成后清理 timer）
    const { signal, cleanup } = withTimeout(DEFAULT_TIMEOUT_SECONDS * 1000);
    let response: { status: number; body: string };
    try {
      response = await context.fetch(url, { signal });
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to fetch ${url}: ${message}`);
    }
    cleanup();

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: Failed to fetch ${url}`);
    }

    // 解析 HTML → Markdown
    const { text: markdown, title } = htmlToMarkdown(response.body);

    // 根据模式处理
    const fullText = extractMode === "text" ? markdownToText(markdown) : markdown;

    // 写入缓存（存完整文本）
    const raw: FetchResultRaw = {
      text: fullText,
      title,
      url,
      status: response.status,
      extractMode,
      tookMs: Date.now() - startTime,
    };

    // 截断后返回
    const { text: truncatedText, truncated } = truncateText(fullText, maxChars);
    const result: FetchResult = { ...raw, text: truncatedText, truncated };

    return {
      content: [{ type: "text", text: truncatedText }],
      details: result,
    };
  },
};
