/**
 * Wiki 自动综述：按分类选页并写入稳定 syntheses/overview-* 路径。
 *
 * 设计：`docs/superpowers/specs/2026-08-27-wiki-auto-synthesis-and-kg-design.md` Task 1
 */

import { rankByForgettingScore } from "./wiki-forgetting.js";
import type { WikiPage } from "./types.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiSynthesizer } from "./wiki-synthesizer.js";

/** 支持自动综述的顶层分类 */
export const AUTO_SYNTHESIS_CATEGORIES = ["sources", "media"] as const;

/** 自动综述分类字面量 */
export type AutoSynthesisCategory = (typeof AUTO_SYNTHESIS_CATEGORIES)[number];

const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MAX_CHARS = 80_000;

/** 分类 → 稳定综述落点路径 */
const CATEGORY_TITLES: Readonly<Record<AutoSynthesisCategory, string>> = {
  sources: "资料综述",
  media: "多媒体综述",
};

/**
 * 返回分类对应的稳定综述页面路径。
 */
export function autoSynthesisPath(category: string): string {
  return `syntheses/overview-${category}`;
}

/**
 * 过滤非活跃页，按遗忘分数降序，再按页数/字符上限截断。
 */
export function selectPagesForAutoSynthesis(
  pages: readonly WikiPage[],
  options: { readonly maxPages?: number; readonly maxChars?: number } = {},
): readonly WikiPage[] {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const eligible = pages.filter((p) => p.status !== "archived" && p.status !== "outdated");
  const ranked = rankByForgettingScore(
    eligible.map((p) => ({
      page: p,
      lastUsedAt: p.last_used,
      createdAt: p.created_at,
      useCount: p.use_count,
    })),
  ).map((item) => item.page);
  const out: WikiPage[] = [];
  let chars = 0;
  for (const item of ranked) {
    if (out.length >= maxPages) break;
    const bodyLen = item.content_md.length;
    if (out.length > 0 && chars + bodyLen > maxChars) break;
    out.push(item);
    chars += bodyLen;
  }
  return out;
}

/** 单分类自动综述执行结果 */
export interface AutoSynthesizeCategoryResult {
  readonly pageId: string;
  readonly path: string;
  readonly skipped?: boolean;
  readonly error?: string;
}

/** 全部分类自动综述的单条结果（含 category） */
export interface AutoSynthesisRunResult extends AutoSynthesizeCategoryResult {
  readonly category: string;
}

/** 全部分类自动综述的汇总结果 */
export interface AutoSynthesizeAllResult {
  readonly results: readonly AutoSynthesisRunResult[];
}

/**
 * 按分类触发自动综述：选页 → 合成 → 直接写入稳定路径（不经用户 accept 手势）。
 */
export class WikiAutoSynthesisRunner {
  constructor(
    private readonly synth: WikiSynthesizer,
    private readonly repo: WikiRepo,
  ) {}

  /**
   * 对指定分类执行自动综述；无可用页时返回 skipped。
   */
  async autoSynthesizeCategory(
    agentId: string,
    userId: string,
    category: AutoSynthesisCategory,
  ): Promise<AutoSynthesizeCategoryResult> {
    const path = autoSynthesisPath(category);
    const pages = this.repo.listPages(agentId, userId, category);
    const selected = selectPagesForAutoSynthesis(pages);
    if (selected.length === 0) {
      return { pageId: "", path, skipped: true };
    }
    const title = CATEGORY_TITLES[category];
    try {
      const page = await this.synth.synthesizeDirectToPath(agentId, userId, selected.map((p) => p.id), {
        title,
        path,
      });
      return { pageId: page.id, path: page.path };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { pageId: "", path, error: message };
    }
  }

  /**
   * 串行执行所有支持自动综述的分类（sources → media）。
   */
  async autoSynthesizeAll(agentId: string, userId: string): Promise<AutoSynthesizeAllResult> {
    const results: AutoSynthesisRunResult[] = [];
    for (const category of AUTO_SYNTHESIS_CATEGORIES) {
      results.push({
        category,
        ...(await this.autoSynthesizeCategory(agentId, userId, category)),
      });
    }
    return { results };
  }
}
