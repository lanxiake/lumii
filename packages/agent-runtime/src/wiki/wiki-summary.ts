/**
 * Wiki 资料摘要 —— heuristic / extractive / llm 三层降级 + 单入口
 *
 * 摘要是四方共用的持久派生资产（编目、AI 重命名、向量语料、UI 列表副标题）。
 * heuristic/extractive 零成本；llm 层惰性，只在消费者显式索取（allowLlm=true）且
 * 正文超过 EXTRACTIVE_MAX_TEXT 时触发，失败降级 extractive 而不抛错。
 * 摘要绝不写回 content_md/extracted_text，避免 LLM 幻觉污染原始资料。
 *
 * 设计：docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md v1.1 §5.7
 */

import { wikiBigramJoin } from "./wiki-index.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { SummaryLevel, WikiSource } from "./types.js";

export const SUMMARY_MAX_CHARS = 120;
export const HEURISTIC_MAX_TEXT = 800;
export const EXTRACTIVE_MAX_TEXT = 2000;
export const LLM_HEAD_CHARS = 3000;
export const LLM_TAIL_CHARS = 500;

export type { SummaryLevel };

export interface SummaryResult {
  readonly summary: string;
  readonly level: SummaryLevel;
}

const PAGE_NUMBER_LINE = /^\s*\d+\s*$/;
const SEPARATOR_LINE = /^\s*[-=_*]{3,}\s*$/;
const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/;

/** 去样板：空行、纯分隔线、纯数字页码行 */
function stripBoilerplateLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SEPARATOR_LINE.test(line) && !PAGE_NUMBER_LINE.test(line));
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * 纯函数，零成本，无 LLM。正文 < 800 字走此层。
 *
 * 1) 正文本身够短（≤ SUMMARY_MAX_CHARS）直接作摘要；
 * 2) 首行是 Markdown 标题则取标题 + 后续首个非空段落；
 * 3) 否则去样板后取前几个非空行拼接；
 * 4) 去样板后为空返回 null。
 */
export function buildHeuristicSummary(title: string, text: string): SummaryResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const lines = stripBoilerplateLines(trimmed);
  if (lines.length === 0) return null;

  if (trimmed.length <= SUMMARY_MAX_CHARS) {
    return { summary: trimmed, level: "heuristic" };
  }

  const headingMatch = MARKDOWN_HEADING.exec(lines[0] ?? "");
  if (headingMatch) {
    const heading = headingMatch[1]?.trim() ?? "";
    const rest = lines.slice(1).join(" ");
    const combined = rest ? `${heading}：${rest}` : heading;
    return { summary: truncate(combined, SUMMARY_MAX_CHARS), level: "heuristic" };
  }

  const combined = lines.join(" ");
  return { summary: truncate(combined, SUMMARY_MAX_CHARS), level: "heuristic" };
}

const SENTENCE_SPLIT = /[。！？；\n]/;
const MIN_SENTENCE_LEN = 8;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LEN);
}

/**
 * 纯函数，零成本，复用 wikiBigramJoin 打分选 3 句。800–2000 字走此层。
 * 句子数 < 3 时降级到 buildHeuristicSummary。
 */
export function buildExtractiveSummary(title: string, text: string): SummaryResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const sentences = splitSentences(trimmed);
  if (sentences.length < 3) {
    return buildHeuristicSummary(title, text);
  }

  const titleTokens = new Set(wikiBigramJoin(title).split(" ").filter(Boolean));

  const freq = new Map<string, number>();
  const sentenceTokens = sentences.map((s) => {
    const tokens = wikiBigramJoin(s).split(" ").filter(Boolean);
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    return tokens;
  });

  const scored = sentences.map((sentence, i) => {
    const tokens = sentenceTokens[i] ?? [];
    let score = 0;
    for (const t of tokens) {
      score += freq.get(t) ?? 0;
      if (titleTokens.has(t)) score += 2;
    }
    return { sentence, index: i, score };
  });

  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, 3);
  const inOrder = top.sort((a, b) => a.index - b.index).map((s) => s.sentence);

  return { summary: truncate(inOrder.join("。"), SUMMARY_MAX_CHARS), level: "extractive" };
}

/** 构造 LLM 摘要提示词：首 3000 字 + 尾 500 字，供长文摘要用 */
export function buildSummaryPrompt(title: string, text: string): string {
  const head = text.slice(0, LLM_HEAD_CHARS);
  const tail =
    text.length > LLM_HEAD_CHARS + LLM_TAIL_CHARS
      ? `\n\n……（中间省略）……\n\n${text.slice(-LLM_TAIL_CHARS)}`
      : "";
  return [
    "用一句话概括这份资料讲什么，供分类归档用。",
    "",
    "要求：",
    "- 不超过 120 字，一句话",
    "- 说清「这是什么类型的东西」和「关于什么」，不要复述细节",
    "- 不要写「这份文件」「本文档」这类废话开头",
    "- 只依据给出的内容，不要推测补充",
    "",
    `标题：${title}`,
    "内容：",
    head + tail,
  ].join("\n");
}

/** 从 LLM 原始回复中取出摘要正文，截断到上限，去除包裹引号 */
function normalizeLlmSummary(raw: string): string {
  const trimmed = raw.trim().replace(/^["'「]|["'」]$/g, "");
  return truncate(trimmed, SUMMARY_MAX_CHARS);
}

/**
 * 摘要单入口。allowLlm=false 时最多降级到 extractive，绝不静默调用 LLM。
 * summary_hash === content_hash 时直接返回缓存，第二次跑全库编目摘要成本为 0。
 */
export class WikiSummarizer {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: ((prompt: string) => Promise<string>) | null,
  ) {}

  async getOrBuildSummary(
    source: WikiSource,
    opts: { readonly allowLlm: boolean },
  ): Promise<SummaryResult | null> {
    // 1) 缓存命中：summary_hash 与当前 content_hash 一致，文件内容未变
    if (source.summary && source.summary_hash && source.summary_hash === source.content_hash) {
      return { summary: source.summary, level: source.summary_level ?? "heuristic" };
    }

    // 2) 无正文 / 无 content_hash → null（无正文资料交 P5 §6.4 路径处理，不产摘要）
    const text = source.extracted_text ?? source.content_md ?? "";
    if (!text.trim() || !source.content_hash) return null;

    // 3) 按长度分档，allowLlm=false 时长文降级 extractive 而不调 LLM
    let result: SummaryResult | null;
    if (text.length < HEURISTIC_MAX_TEXT) {
      result = buildHeuristicSummary(source.title, text);
    } else if (text.length < EXTRACTIVE_MAX_TEXT) {
      result = buildExtractiveSummary(source.title, text);
    } else if (opts.allowLlm && this.callLLM) {
      result = await this.buildLlmSummary(source.title, text);
    } else {
      result = buildExtractiveSummary(source.title, text);
    }
    if (!result) return null;

    // 4) 持久化：只写 summary/summary_hash/summary_level，绝不写回正文
    this.repo.updateSourceSummary(source.id, result.summary, source.content_hash, result.level);
    return result;
  }

  /** LLM 调用失败（超时/异常）时降级 extractive，不抛错 */
  private async buildLlmSummary(title: string, text: string): Promise<SummaryResult | null> {
    if (!this.callLLM) return buildExtractiveSummary(title, text);
    try {
      const prompt = buildSummaryPrompt(title, text);
      const raw = await this.callLLM(prompt);
      const summary = normalizeLlmSummary(raw);
      if (!summary) return buildExtractiveSummary(title, text);
      return { summary, level: "llm" };
    } catch {
      return buildExtractiveSummary(title, text);
    }
  }
}
