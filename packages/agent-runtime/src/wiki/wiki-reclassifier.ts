/**
 * WikiReclassifier — 重新编目：生成候选、审阅、部分接受
 *
 * 与自动归档（WikiOrganizer）的区别：重编目**不直接写库**，先落候选态，
 * 用户接受后才改主题两列。每 agent+user 同时只允许一个批次。
 * AI 只能在当前树里选节点，不能自造、不能写临时存放。
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §9
 */

import { extractJsonPayload } from "./wiki-classifier.js";
import { buildTaxonomyGuide } from "./wiki-taxonomy-prompt.js";
import type { WikiRepo } from "./wiki-repo.js";
import { generateWikiId, type WikiSource } from "./types.js";
import {
  PARKING_CATEGORY,
  validateTopicAssignment,
  type WikiTopicTree,
} from "./wiki-topic-tree.js";
import type {
  WikiReclassifyCandidate,
  WikiReclassifyRun,
  WikiReclassifyScope,
} from "./wiki-reclassify-types.js";

export type {
  WikiReclassifyCandidate,
  WikiReclassifyRun,
  WikiReclassifyScope,
  WikiReclassifyStatus,
} from "./wiki-reclassify-types.js";
export { RECLASSIFY_RUN_META_KEY } from "./wiki-reclassify-types.js";

/** 单批条数：与归档分类同量级，正文已截断，一批 8 条 */
export const RECLASSIFY_BATCH_SIZE = 8;
/** 每条正文截断长度，与 buildClassifyPrompt 的预览一致 */
export const RECLASSIFY_TEXT_CHARS = 300;

/** 提示词输入项 */
interface ReclassifyPromptItem {
  readonly id: string;
  readonly title: string;
  readonly text: string | null;
  readonly fromCategory: string;
  readonly fromSubtopic: string;
}

/**
 * 构造重编目提示词。与归档分类共用口诀，但多给「当前所属目录」，
 * 并要求只在确有更好用途时才输出新节点——否则原样返回，避免无意义抖动。
 */
export function buildReclassifyPrompt(
  items: readonly ReclassifyPromptItem[],
  tree: WikiTopicTree,
): string {
  const list = items
    .map(
      (item, i) =>
        `${i + 1}. [id=${item.id}] 标题: ${item.title}\n当前目录: ${item.fromCategory} / ${item.fromSubtopic}\n内容预览: ${(item.text ?? "").slice(0, RECLASSIFY_TEXT_CHARS)}`,
    )
    .join("\n\n");

  return [
    // 口诀 / 易混 / 可选目录 / 通用规则与归档分类共用同一份真源
    buildTaxonomyGuide(tree),
    "",
    "## 本次任务",
    "你正在复查**已归档**资料的目录是否合适，不是首次归档。",
    "- 只有当前目录确实不合适、且能在上方目录里找到明显更好的位置时才改",
    "- 拿不准就保持原目录（输出与当前目录相同的大类小类）",
    "- reason 用一句中文说明为什么新目录更合适",
    "",
    "## 待复查资料",
    list,
    "",
    "## 输出",
    '仅 JSON 数组: {"id":"<id>","category":"<大类>","subtopic":"<小类>","reason":"<一句话理由>"}',
    "仅输出 JSON，不要包含其他文字。",
  ].join("\n");
}

/** 解析输入项：比提示词项多一个 sourceId */
interface ReclassifyParseItem {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly fromCategory: string;
  readonly fromSubtopic: string;
}

/**
 * 解析模型回复为候选列表。
 * 三类不产候选：与原目录相同（unchanged）、模型漏答（unchanged）、
 * 越权或自造节点含临时存放（droppedInvalid）。整批不可解析时全算 unchanged，不抛错。
 */
export function parseReclassifyResponse(
  response: string,
  items: readonly ReclassifyParseItem[],
  tree: WikiTopicTree,
  newId: () => string,
): { candidates: WikiReclassifyCandidate[]; droppedInvalid: number; unchanged: number } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const payload = extractJsonPayload(response);
  if (payload === null) return { candidates: [], droppedInvalid: 0, unchanged: items.length };

  let parsed: unknown[];
  if (Array.isArray(payload)) {
    parsed = payload;
  } else if (typeof payload === "object" && "id" in (payload as Record<string, unknown>)) {
    parsed = [payload];
  } else {
    return { candidates: [], droppedInvalid: 0, unchanged: items.length };
  }

  const candidates: WikiReclassifyCandidate[] = [];
  const seen = new Set<string>();
  let droppedInvalid = 0;
  let unchanged = 0;

  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const item = id ? byId.get(id) : null;
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);

    const category = typeof record.category === "string" && record.category ? record.category : null;
    const subtopic = typeof record.subtopic === "string" && record.subtopic ? record.subtopic : null;

    // AI 不得写临时存放，也不得自造节点
    if (category === null || category === PARKING_CATEGORY) {
      droppedInvalid++;
      continue;
    }
    if (!validateTopicAssignment(tree, category, subtopic).ok) {
      droppedInvalid++;
      continue;
    }
    if (category === item.fromCategory && subtopic === item.fromSubtopic) {
      unchanged++;
      continue;
    }

    candidates.push({
      id: newId(),
      sourceId: item.sourceId,
      title: item.title,
      fromCategory: item.fromCategory,
      fromSubtopic: item.fromSubtopic,
      toCategory: category,
      toSubtopic: subtopic!,
      reason: typeof record.reason === "string" ? record.reason : "",
      decision: "pending",
    });
  }

  // 模型漏答的不算改动
  unchanged += items.filter((i) => !seen.has(i.id)).length;
  return { candidates, droppedInvalid, unchanged };
}

/** 正文语料：无 extracted_text 的媒体退化为标题 */
function corpusOf(source: WikiSource): string | null {
  return source.extracted_text ?? source.title;
}

export class WikiReclassifier {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    /** 测试注入固定 id；生产用 generateWikiId */
    private readonly newId: () => string = generateWikiId,
  ) {}

  get(agentId: string, userId: string): WikiReclassifyRun | null {
    return (this.repo.getReclassifyRun(agentId, userId) as WikiReclassifyRun | null) ?? null;
  }

  /** organizer 判暂停用：只有 running 才阻塞自动归档，review 不阻塞 */
  static isRunning(run: WikiReclassifyRun | null): boolean {
    return run?.status === "running";
  }

  /**
   * 启动一个批次：写 running → 分批问 LLM → 写 review。
   * 已有 running 一律拒绝；review/failed 需要 force（UI 先弹「丢弃旧批次？」）。
   */
  async run(
    agentId: string,
    userId: string,
    scope: WikiReclassifyScope,
    opts?: { readonly force?: boolean },
  ): Promise<string> {
    const existing = this.get(agentId, userId);
    if (existing) {
      if (existing.status === "running") {
        throw new Error("已有正在进行的重新编目，请等它结束");
      }
      if (!opts?.force) {
        throw new Error("已有待审阅的重新编目结果，请先处理或丢弃");
      }
    }

    const sources = this.repo.listSourcesForReclassify(agentId, userId, scope);
    const runId = this.newId();
    const now = new Date().toISOString();
    let run: WikiReclassifyRun = {
      runId,
      status: "running",
      scope,
      total: sources.length,
      processed: 0,
      droppedInvalid: 0,
      unchanged: 0,
      candidates: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.setReclassifyRun(agentId, userId, run);

    if (sources.length === 0) {
      run = { ...run, status: "review", updatedAt: new Date().toISOString() };
      this.repo.setReclassifyRun(agentId, userId, run);
      return runId;
    }

    const tree = this.repo.getOrCreateTopicTree();
    const candidates: WikiReclassifyCandidate[] = [];
    let droppedInvalid = 0;
    let unchanged = 0;

    try {
      for (let i = 0; i < sources.length; i += RECLASSIFY_BATCH_SIZE) {
        const batch = sources.slice(i, i + RECLASSIFY_BATCH_SIZE);
        const parseItems: ReclassifyParseItem[] = batch.map((s) => ({
          id: s.id,
          sourceId: s.id,
          title: s.title,
          fromCategory: s.topic_category!,
          fromSubtopic: s.topic_subtopic!,
        }));
        const prompt = buildReclassifyPrompt(
          batch.map((s) => ({
            id: s.id,
            title: s.title,
            text: corpusOf(s),
            fromCategory: s.topic_category!,
            fromSubtopic: s.topic_subtopic!,
          })),
          tree,
        );
        const response = await this.callLLM(prompt);
        const parsed = parseReclassifyResponse(response, parseItems, tree, this.newId);
        candidates.push(...parsed.candidates);
        droppedInvalid += parsed.droppedInvalid;
        unchanged += parsed.unchanged;

        // 每批结束刷进度，任务中心 pill 读这个
        run = {
          ...run,
          processed: Math.min(i + batch.length, sources.length),
          droppedInvalid,
          unchanged,
          candidates: [...candidates],
          updatedAt: new Date().toISOString(),
        };
        this.repo.setReclassifyRun(agentId, userId, run);
      }
    } catch (err) {
      // 保留 scope 供 retry
      this.repo.setReclassifyRun(agentId, userId, {
        ...run,
        status: "failed",
        error: (err as Error).message,
        updatedAt: new Date().toISOString(),
      });
      throw err;
    }

    this.repo.setReclassifyRun(agentId, userId, {
      ...run,
      status: "review",
      updatedAt: new Date().toISOString(),
    });
    return runId;
  }

  /**
   * 部分接受。逐条校验目标节点仍在树里（用户可能刚删掉它），
   * 失败的条目留在 review 并带 applyError；全部落定后清空批次。
   */
  apply(
    agentId: string,
    userId: string,
    candidateIds: readonly string[],
  ): { applied: number; failed: number } {
    const run = this.get(agentId, userId);
    if (!run) return { applied: 0, failed: 0 };
    if (candidateIds.length === 0) return { applied: 0, failed: 0 };

    const tree = this.repo.getOrCreateTopicTree();
    const wanted = new Set(candidateIds);
    let applied = 0;
    let failed = 0;

    const next = run.candidates.map((c) => {
      if (!wanted.has(c.id) || c.decision !== "pending") return c;
      const check = validateTopicAssignment(tree, c.toCategory, c.toSubtopic);
      if (!check.ok) {
        failed++;
        return { ...c, applyError: `目标目录已不存在：${c.toCategory} / ${c.toSubtopic}` };
      }
      try {
        this.repo.updateSourceTopic(agentId, userId, c.sourceId, c.toCategory, c.toSubtopic);
        applied++;
        const { applyError: _drop, ...rest } = c;
        return { ...rest, decision: "applied" as const };
      } catch (err) {
        failed++;
        return { ...c, applyError: (err as Error).message };
      }
    });

    this.persist(agentId, userId, run, next);
    return { applied, failed };
  }

  ignore(agentId: string, userId: string, candidateId: string): void {
    const run = this.get(agentId, userId);
    if (!run) return;
    const next = run.candidates.map((c) =>
      c.id === candidateId ? { ...c, decision: "ignored" as const } : c,
    );
    this.persist(agentId, userId, run, next);
  }

  discard(agentId: string, userId: string): void {
    this.repo.setReclassifyRun(agentId, userId, null);
  }

  /**
   * 落盘：只留还需要用户处理的条目（pending，或接受失败带 applyError 的）。
   * 一条都不剩时整批清空，避免空批次占住「同时只允许一个」的槽位。
   */
  private persist(
    agentId: string,
    userId: string,
    run: WikiReclassifyRun,
    candidates: readonly WikiReclassifyCandidate[],
  ): void {
    const remaining = candidates.filter((c) => c.decision === "pending");
    if (remaining.length === 0) {
      this.repo.setReclassifyRun(agentId, userId, null);
      return;
    }
    this.repo.setReclassifyRun(agentId, userId, {
      ...run,
      status: "review",
      candidates: remaining,
      updatedAt: new Date().toISOString(),
    });
  }
}
