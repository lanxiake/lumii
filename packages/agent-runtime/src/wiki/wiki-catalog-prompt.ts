/**
 * 全库编目 v2 —— 结构轮/内容轮提示词构造与解析
 *
 * 两轮制：结构轮（不带正文，模型可声明 needContent）+ 内容轮（仅 needContent 且有正文的补摘要）。
 * 全局印象段规模恒定 O(叶子数)，不随批次增长——见 buildLibraryImpression。
 *
 * 设计：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p5-cataloging.md Task 2
 */

import { extractJsonPayload } from "./wiki-classifier.js";
import { buildTaxonomyGuide } from "./wiki-taxonomy-prompt.js";
import { validateTopicAssignment, type WikiTopicTree } from "./wiki-topic-tree.js";
import type { LibraryInventory, InventoryFileRow } from "./wiki-library-inventory.js";

/** 结构轮：每条只一行，可放 40–60 */
export const STRUCTURE_BATCH_SIZE = 50;
/** 内容轮：每条带摘要，成本更高 */
export const CONTENT_BATCH_SIZE = 12;

/**
 * 全库现状印象段：目录结构（每叶子计数）+ 各目录已有样例（锚点）。
 * 规模恒定 O(叶子数)，不随批次增长——每批重建时读的是当前库状态，天然幂等。
 */
export function buildLibraryImpression(inv: LibraryInventory): string {
  const dirLines = inv.tree.categories.map((c) => {
    const parts = c.subtopics.map((s) => {
      const leaf = inv.leaves.find((l) => l.category === c.name && l.subtopic === s);
      return `${s}(${leaf?.count ?? 0})`;
    });
    const unfiled = inv.leaves.find((l) => l.category === c.name && l.subtopic === null);
    if (unfiled?.count) parts.push(`未细分(${unfiled.count})`);
    return `- ${c.name}：${parts.join("、")}`;
  });

  const anchorLines = inv.leaves
    .filter((l) => l.anchors.length > 0)
    .map((l) => `- ${l.category}/${l.subtopic ?? "未细分"}：${l.anchors.join("、")}`);

  return [
    "## 全库现状（本次编目的完整视野）",
    "### 目录结构（数字为该目录现有文件数）",
    ...dirLines,
    `- 收件箱（未分类）(${inv.inboxCount})`,
    "### 各目录已有样例（据此保持一致）",
    ...anchorLines,
  ].join("\n");
}

function fileLine(f: InventoryFileRow, i: number): string {
  return (
    `${i + 1}. [id=${f.id}] ${f.fileName}${f.relPath ? `  路径: ${f.relPath}` : ""}` +
    `  当前: ${f.fromCategory ?? "收件箱"}${f.fromSubtopic ? ` / ${f.fromSubtopic}` : ""}` +
    (f.hasText ? "" : `  (${f.mediaType}，无正文)`)
  );
}

/**
 * 结构轮 prompt：只给文件名+相对路径+当前目录，不带正文。
 * 模型可输出 needContent: true 声明「判不了」，交给内容轮补正文。
 */
export function buildStructurePrompt(
  tree: WikiTopicTree,
  impression: string,
  batch: readonly InventoryFileRow[],
): string {
  const items = batch.map(fileLine).join("\n");

  return [
    buildTaxonomyGuide(tree),
    "",
    impression,
    "",
    "## 本批文件（只给了文件名和路径，没有正文）",
    items,
    "",
    "## 本批规则",
    "- 优先把同一文件夹下的文件归到同一处",
    "- 文件夹路径往往已经表达了用户的意图，优先采信",
    "- 光看文件名和路径判不了的，输出 needContent: true，不要硬猜",
    "- 无正文的图片/音视频：靠路径语义 + 同目录已定分类判断；判不了就 needContent（但它没有正文可读，等价于留收件箱并说明原因）",
    "",
    "## 输出 JSON",
    '{"items":[{"id":"...","category":"工作","subtopic":"例行","confidence":0.9,"reason":"..."},{"id":"...","needContent":true,"reason":"..."}]}',
    "仅输出 JSON，不要包含其他文字。",
  ].join("\n");
}

/**
 * 内容轮 prompt：仅 needContent 集合，补 P4 摘要（不再是原文预览），成本可控。
 * enableRename=true 时额外请求 renameTitle 提案（P6，默认关闭）。
 */
export function buildContentPrompt(
  tree: WikiTopicTree,
  impression: string,
  batch: readonly InventoryFileRow[],
  summaries: ReadonlyMap<string, string>,
  opts?: { readonly enableRename?: boolean },
): string {
  const items = batch
    .map((f, i) => {
      const summary = summaries.get(f.id);
      return (
        `${i + 1}. [id=${f.id}] ${f.fileName}${f.relPath ? `  路径: ${f.relPath}` : ""}` +
        `  当前: ${f.fromCategory ?? "收件箱"}${f.fromSubtopic ? ` / ${f.fromSubtopic}` : ""}` +
        `\n   摘要: ${summary ?? "（无摘要）"}`
      );
    })
    .join("\n\n");

  const renameSection = opts?.enableRename
    ? [
        "",
        "## 改名提案（可选）",
        "- 标题信息量明显不足（如 IMG_1234、未命名文档、纯数字）时，可给出 renameTitle 建议一个更有信息量的标题",
        "- 标题本身已经说清楚内容的，不要给 renameTitle",
        "- renameTitle 只依据摘要与文件名，不要编造摘要之外的内容",
      ]
    : [];

  return [
    buildTaxonomyGuide(tree),
    "",
    impression,
    "",
    "## 本批文件（结构轮判不了，补充摘要重新判断）",
    items,
    ...renameSection,
    "",
    "## 本批规则",
    "- 优先把同一文件夹下的文件归到同一处",
    "- 结合摘要与路径综合判断；仍拿不准就只给大类、留空小类，而不是继续 needContent",
    "",
    "## 输出 JSON",
    opts?.enableRename
      ? '{"items":[{"id":"...","category":"工作","subtopic":"例行","confidence":0.9,"reason":"...","renameTitle":"更有信息量的标题"}]}'
      : '{"items":[{"id":"...","category":"工作","subtopic":"例行","confidence":0.9,"reason":"..."}]}',
    "仅输出 JSON，不要包含其他文字。",
  ].join("\n");
}

export interface StructureDecision {
  readonly id: string;
  readonly category: string | null;
  readonly subtopic: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly needContent: boolean;
  /** 内容轮 enableRename=true 时可能给出的改名提案；服务端校验前的原始值 */
  readonly renameTitle?: string;
}

/**
 * 解析结构轮/内容轮回复。校验：id 必须在本批（否则 drop）；
 * category/subtopic 必须落在当前树内（否则 drop）；needContent 与 category 同给时以 category 为准。
 */
export function parseStructureResponse(
  raw: string,
  batch: readonly InventoryFileRow[],
  tree: WikiTopicTree,
): { decisions: StructureDecision[]; droppedInvalid: number } {
  const byId = new Set(batch.map((f) => f.id));
  const payload = extractJsonPayload(raw);
  if (payload === null) return { decisions: [], droppedInvalid: 0 };

  let items: unknown[];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (
    typeof payload === "object" &&
    payload !== null &&
    "items" in (payload as Record<string, unknown>) &&
    Array.isArray((payload as Record<string, unknown>).items)
  ) {
    items = (payload as Record<string, unknown>).items as unknown[];
  } else if (typeof payload === "object" && payload !== null && "id" in (payload as Record<string, unknown>)) {
    items = [payload];
  } else {
    return { decisions: [], droppedInvalid: 0 };
  }

  const decisions: StructureDecision[] = [];
  let droppedInvalid = 0;
  const seen = new Set<string>();

  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    if (!id || !byId.has(id) || seen.has(id)) {
      if (id && !byId.has(id)) droppedInvalid++;
      continue;
    }
    seen.add(id);

    const needContent = record.needContent === true;
    const category = typeof record.category === "string" && record.category ? record.category : null;
    const subtopic = typeof record.subtopic === "string" && record.subtopic ? record.subtopic : null;
    const reason = typeof record.reason === "string" ? record.reason : "";
    const confidence = typeof record.confidence === "number" ? record.confidence : 0;
    const renameTitle =
      typeof record.renameTitle === "string" && record.renameTitle.trim() ? record.renameTitle.trim() : undefined;

    // needContent 与 category 同时给出时以 category 为准
    if (category !== null) {
      if (!validateTopicAssignment(tree, category, subtopic).ok) {
        droppedInvalid++;
        continue;
      }
      decisions.push({ id, category, subtopic, confidence, reason, needContent: false, renameTitle });
      continue;
    }

    if (needContent) {
      decisions.push({ id, category: null, subtopic: null, confidence, reason, needContent: true });
      continue;
    }

    // 既没给合法 category 也没声明 needContent：视为漏答，不产决策也不计入 droppedInvalid
  }

  return { decisions, droppedInvalid };
}
