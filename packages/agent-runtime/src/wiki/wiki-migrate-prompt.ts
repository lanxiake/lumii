/**
 * Wiki 库级迁移 — 目录映射 prompt 构造与 JSON 解析
 *
 * MapPlan 阶段以文件夹簇为决策单元，少量 LLM 调用产出映射方案。
 * 复用 buildTaxonomyGuide / extractJsonPayload / validateTopicAssignment。
 *
 * 设计：docs/design/记忆设计/2026-09-05-wiki-library-migrate-design.md §3.2
 */

import { extractJsonPayload } from "./wiki-classifier.js";
import type { MigrateFolderCluster, MigrateInventory } from "./wiki-migrate-inventory.js";
import type { MigrateFolderMapping } from "./wiki-migrate-types.js";
import { buildTaxonomyGuide } from "./wiki-taxonomy-prompt.js";
import { validateTopicAssignment, type WikiTopicTree } from "./wiki-topic-tree.js";

/** 映射规划每批处理的文件夹簇数量（设计建议 20～40） */
export const MIGRATE_PLAN_BATCH_SIZE = 30;

/** 低于此置信度的映射标为 conflict，预览需人工处理 */
export const MIGRATE_CONFIDENCE_THRESHOLD = 0.6;

/**
 * 构造 MapPlan 阶段 prompt：分类口诀 + wiki 占用/锚点 + 源目录树 + 本批簇。
 * 不含正文预览，仅文件名与路径语义。
 */
export function buildMigratePlanPrompt(
  tree: WikiTopicTree,
  inventory: MigrateInventory,
  batchClusters: readonly MigrateFolderCluster[],
): string {
  const clusterLines = batchClusters.map((c) => {
    const samples = c.sampleNames.length > 0 ? c.sampleNames.join("、") : "（无样例）";
    return `- folderRel="${c.folderRel || "（根目录）"}"  文件数=${c.fileCount}  样例：${samples}`;
  });

  return [
    buildTaxonomyGuide(tree),
    "",
    "## Wiki 资料库现状（优先归到已有占用，避免另起碎片）",
    "### 各目录已有资料数量",
    inventory.wikiOccupancyText,
    "### 各目录锚点样例",
    inventory.wikiAnchorsText,
    "",
    "## 源目录结构（待迁移文件的原始组织）",
    inventory.directoryTreeText,
    "",
    "## 本批文件夹簇（决策单元；同夹默认同一落点）",
    clusterLines.join("\n"),
    "",
    "## 映射规则",
    "- 同一文件夹下的文件默认归入同一 wiki 落点，不要拆散",
    "- 优先映射到 wiki 中已有占用非零的叶子目录；空库才自由选择",
    "- 同父路径下的子文件夹，若语义同属一项目，可映射到同一落点（小类可留空）",
    "- 小类可选：只确定大类、小类留 null 是允许的",
    "- proposedSubtopic 仅作「建议新建小类」提案，不会自动写入主题树，须用户在预览批准",
    "- 路径语义明显不足、需要读正文才能判断的，输出 needContent: true（尽量少用）",
    `- confidence < ${MIGRATE_CONFIDENCE_THRESHOLD} 或无法确定大类 → category 留 null（服务端标 conflict）`,
    "- exceptions 仅用于簇内极少数例外文件，需强 reason；默认不要用",
    "",
    "## 输出 JSON",
    '[{"folderRel":"proj","category":"工作","subtopic":"项目","confidence":0.9,"reason":"同项目资料","proposedSubtopic":"可选新小类名","needContent":false,"exceptions":[]}]',
    "仅输出 JSON 数组，不要包含其他文字。",
  ].join("\n");
}

/** 从模型回复中解析出 folderRel → 原始记录的映射 */
function parseRawItems(raw: string): Record<string, unknown>[] {
  const payload = extractJsonPayload(raw);
  if (payload === null) return [];

  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  }
  if (typeof payload === "object" && payload !== null && "folderRel" in (payload as Record<string, unknown>)) {
    return [payload as Record<string, unknown>];
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    "items" in (payload as Record<string, unknown>) &&
    Array.isArray((payload as Record<string, unknown>).items)
  ) {
    return ((payload as Record<string, unknown>).items as unknown[]).filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  }
  return [];
}

/**
 * 将单条模型输出规范化为 MigrateFolderMapping。
 * 越权大类、低置信、空 category 均标 conflict 并清空 category。
 */
function normalizeMapping(
  record: Record<string, unknown>,
  cluster: MigrateFolderCluster,
  tree: WikiTopicTree,
): MigrateFolderMapping {
  const folderRel = cluster.folderRel;
  const inboxIds = cluster.inboxIds;
  const reason = typeof record.reason === "string" ? record.reason : "";
  const confidence = typeof record.confidence === "number" ? record.confidence : 0;
  const needContent = record.needContent === true;
  const proposedSubtopic =
    typeof record.proposedSubtopic === "string" && record.proposedSubtopic.trim()
      ? record.proposedSubtopic.trim()
      : undefined;

  const rawCategory = typeof record.category === "string" && record.category ? record.category : null;
  const rawSubtopic = typeof record.subtopic === "string" && record.subtopic ? record.subtopic : null;

  const exceptions = parseExceptions(record.exceptions, tree);

  if (needContent && rawCategory === null) {
    return {
      folderRel,
      category: null,
      subtopic: null,
      confidence,
      reason: reason || "路径语义不足，需正文轮",
      proposedSubtopic,
      status: "needContent",
      exceptions: exceptions.length > 0 ? exceptions : undefined,
      inboxIds,
    };
  }

  if (rawCategory === null) {
    return conflictMapping(folderRel, inboxIds, confidence, reason || "未给出大类", proposedSubtopic, exceptions);
  }

  const validation = validateTopicAssignment(tree, rawCategory, rawSubtopic);
  if (!validation.ok) {
    return conflictMapping(
      folderRel,
      inboxIds,
      confidence,
      reason || validation.reason,
      proposedSubtopic,
      exceptions,
    );
  }

  if (confidence < MIGRATE_CONFIDENCE_THRESHOLD) {
    return conflictMapping(folderRel, inboxIds, confidence, reason || "置信度过低", proposedSubtopic, exceptions);
  }

  return {
    folderRel,
    category: rawCategory,
    subtopic: rawSubtopic,
    confidence,
    reason,
    proposedSubtopic,
    status: "ok",
    exceptions: exceptions.length > 0 ? exceptions : undefined,
    inboxIds,
  };
}

/**
 * 解析 exceptions 数组，过滤越权 category/subtopic。
 */
function parseExceptions(
  raw: unknown,
  tree: WikiTopicTree,
): NonNullable<MigrateFolderMapping["exceptions"]> {
  if (!Array.isArray(raw)) return [];
  const result: NonNullable<MigrateFolderMapping["exceptions"]>[number][] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const inboxId = typeof rec.inboxId === "string" ? rec.inboxId : null;
    if (!inboxId) continue;
    const category = typeof rec.category === "string" && rec.category ? rec.category : null;
    const subtopic = typeof rec.subtopic === "string" && rec.subtopic ? rec.subtopic : null;
    const reason = typeof rec.reason === "string" ? rec.reason : "";
    if (category !== null && !validateTopicAssignment(tree, category, subtopic).ok) continue;
    result.push({ inboxId, category, subtopic, reason });
  }
  return result;
}

/** 构造 conflict 状态的映射条目 */
function conflictMapping(
  folderRel: string,
  inboxIds: readonly string[],
  confidence: number,
  reason: string,
  proposedSubtopic?: string,
  exceptions?: NonNullable<MigrateFolderMapping["exceptions"]>,
): MigrateFolderMapping {
  return {
    folderRel,
    category: null,
    subtopic: null,
    confidence,
    reason,
    proposedSubtopic,
    status: "conflict",
    exceptions: exceptions && exceptions.length > 0 ? exceptions : undefined,
    inboxIds,
  };
}

/**
 * 解析 MapPlan LLM 回复，校验 category/subtopic 合法性并补回 inboxIds。
 * 本批每个输入簇均产出一条映射；模型未返回或 JSON 无效时标 conflict。
 */
export function parseMigratePlanResponse(
  raw: string,
  tree: WikiTopicTree,
  batchClusters: readonly MigrateFolderCluster[],
): MigrateFolderMapping[] {
  const clusterByRel = new Map(batchClusters.map((c) => [c.folderRel, c]));
  const items = parseRawItems(raw);
  const byFolderRel = new Map<string, Record<string, unknown>>();

  for (const item of items) {
    const rel = typeof item.folderRel === "string" ? item.folderRel : null;
    if (rel !== null && clusterByRel.has(rel) && !byFolderRel.has(rel)) {
      byFolderRel.set(rel, item);
    }
  }

  const jsonFailed = items.length === 0 && raw.trim().length > 0 && extractJsonPayload(raw) === null;

  return batchClusters.map((cluster) => {
    const record = byFolderRel.get(cluster.folderRel);
    if (!record) {
      return conflictMapping(
        cluster.folderRel,
        cluster.inboxIds,
        0,
        jsonFailed ? "模型回复无法解析" : "模型未返回该文件夹映射",
      );
    }
    return normalizeMapping(record, cluster, tree);
  });
}
