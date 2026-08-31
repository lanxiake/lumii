/**
 * WikiRepo — Wiki 知识库的收件箱 / 资料 / 页面 / 修订 / 运行日志读写与检索
 *
 * 直接持有 DatabaseAdapter，不建 service/factory 分层（同 AgentMemoryRepo 范式）。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import { tokenizeBigram } from "../memory/segmentation.js";
import { WikiIndexRepo } from "./wiki-index.js";
import { parseWikilinks } from "./wiki-link-parser.js";
import { resolveWikilinkTarget, type WikilinkCandidatePage } from "./wiki-link-resolver.js";
import { computeForgettingScore } from "./wiki-forgetting.js";
import {
  DEFAULT_TOPIC_TREE,
  PARKING_CATEGORY,
  TOPIC_CATEGORIES_META_KEY,
  parseTopicTree,
  treeHasOrphans,
  validateTopicAssignment,
  validateTopicTree,
  type WikiTopicTree,
} from "./wiki-topic-tree.js";
import { RECLASSIFY_RUN_META_KEY } from "./wiki-reclassify-types.js";
import { GRAPH_EXTRACT_CURSOR_META_KEY, type WikiGraphExtractCursor } from "./wiki-graph-types.js";
import {
  planTopicMutation,
  topicCountKey,
  type TopicCascade,
  type WikiTopicMutation,
} from "./wiki-topic-mutate.js";
import {
  generateWikiId,
  validateWikiPath,
  type WikiAttachment,
  type WikiBacklink,
  type WikiCategory,
  type WikiInboxItem,
  type WikiInboxItemType,
  type WikiInboxStatus,
  type WikiLink,
  type WikiMediaType,
  type WikiOrganizeRun,
  type WikiOrganizeRunStatus,
  type WikiPage,
  type WikiPageRevision,
  type WikiPageStatus,
  type WikiRevisionEditor,
  type WikiSource,
  type WikiStorageMode,
  type WikiSynthesis,
  type WikiSynthesisStatus,
} from "./types.js";

interface WikiInboxRow {
  id: string;
  agent_id: string;
  user_id: string;
  item_type: string;
  source_path: string | null;
  source_url: string | null;
  title: string;
  content_preview: string | null;
  media_type: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  last_outcome: string | null;
  organized_source_id: string | null;
  content_hash: string | null;
  created_at: string;
  organized_at: string | null;
}

function inboxRowToItem(row: WikiInboxRow): WikiInboxItem {
  return {
    ...row,
    item_type: row.item_type as WikiInboxItemType,
    media_type: row.media_type as WikiMediaType,
    status: row.status as WikiInboxStatus,
  };
}

interface WikiPageRow {
  id: string;
  agent_id: string;
  user_id: string;
  path: string;
  category: string;
  title: string;
  content_md: string;
  version: number;
  last_used: string | null;
  use_count: number;
  created_at: string;
  updated_at: string;
  status: string;
}

function pageRowToPage(row: WikiPageRow): WikiPage {
  return { ...row, category: row.category as WikiCategory, status: row.status as WikiPageStatus };
}

interface WikiLinkRow {
  id: string;
  agent_id: string;
  user_id: string;
  source_page_id: string;
  target_page_id: string | null;
  anchor_text: string;
  is_resolved: number;
  created_at: string;
}

function linkRowToLink(row: WikiLinkRow): WikiLink {
  return { ...row, is_resolved: row.is_resolved !== 0 };
}

interface WikiRunRow {
  id: string;
  agent_id: string;
  user_id: string;
  inbox_ids: string;
  status: string;
  result_summary: string | null;
  error: string | null;
  result_detail: string | null;
  created_at: string;
  finished_at: string | null;
}

function runRowToRun(row: WikiRunRow): WikiOrganizeRun {
  return {
    ...row,
    inbox_ids: JSON.parse(row.inbox_ids),
    status: row.status as WikiOrganizeRunStatus,
  };
}

export class WikiRepo {
  private readonly indexRepo: WikiIndexRepo;

  constructor(private readonly db: DatabaseAdapter) {
    this.indexRepo = new WikiIndexRepo(db);
  }

  /** 供同库派生仓储（ERO / 向量）共享连接 */
  get database(): DatabaseAdapter {
    return this.db;
  }

  // ── 收件箱 ──────────────────────────────────────────────

  /**
   * 摄入一条收件箱记录。以 source_path + content_hash 去重：
   * 相同路径相同内容跳过（返回已存在的 pending/organized 记录），内容变化则作为新条目插入。
   */
  ingestToInbox(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly itemType: WikiInboxItemType;
    readonly sourcePath?: string;
    readonly sourceUrl?: string;
    readonly title: string;
    readonly contentPreview?: string;
    readonly mediaType?: WikiMediaType;
    readonly contentHash?: string;
  }): WikiInboxItem {
    if (params.sourcePath && params.contentHash) {
      const existing = this.db
        .prepare<WikiInboxRow>(
          `SELECT * FROM wiki_inbox
           WHERE agent_id = ? AND user_id = ? AND source_path = ? AND content_hash = ?
           LIMIT 1`,
        )
        .get(params.agentId, params.userId, params.sourcePath, params.contentHash);
      if (existing) return inboxRowToItem(existing);
    }

    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_inbox
         (id, agent_id, user_id, item_type, source_path, source_url, title,
          content_preview, media_type, status, attempt_count, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        params.itemType,
        params.sourcePath ?? null,
        params.sourceUrl ?? null,
        params.title,
        params.contentPreview ?? null,
        params.mediaType ?? "document",
        params.contentHash ?? null,
        now,
      );

    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      item_type: params.itemType,
      source_path: params.sourcePath ?? null,
      source_url: params.sourceUrl ?? null,
      title: params.title,
      content_preview: params.contentPreview ?? null,
      media_type: params.mediaType ?? "document",
      status: "pending",
      attempt_count: 0,
      last_error: null,
      last_outcome: null,
      organized_source_id: null,
      content_hash: params.contentHash ?? null,
      created_at: now,
      organized_at: null,
    };
  }

  listInbox(
    agentId: string,
    userId: string,
    status?: WikiInboxStatus,
    limit = 100,
  ): readonly WikiInboxItem[] {
    const rows = status
      ? this.db
          .prepare<WikiInboxRow>(
            `SELECT * FROM wiki_inbox WHERE agent_id = ? AND user_id = ? AND status = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(agentId, userId, status, limit)
      : this.db
          .prepare<WikiInboxRow>(
            `SELECT * FROM wiki_inbox WHERE agent_id = ? AND user_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(agentId, userId, limit);
    return rows.map(inboxRowToItem);
  }

  /** 收件箱条数；不传 status 则计全部状态 */
  countInbox(agentId: string, userId: string, status?: WikiInboxStatus): number {
    const row = status
      ? this.db
          .prepare<{ c: number }>(
            `SELECT COUNT(*) AS c FROM wiki_inbox WHERE agent_id = ? AND user_id = ? AND status = ?`,
          )
          .get(agentId, userId, status)
      : this.db
          .prepare<{ c: number }>(
            `SELECT COUNT(*) AS c FROM wiki_inbox WHERE agent_id = ? AND user_id = ?`,
          )
          .get(agentId, userId);
    return row?.c ?? 0;
  }

  findInboxById(id: string): WikiInboxItem | null {
    const row = this.db.prepare<WikiInboxRow>("SELECT * FROM wiki_inbox WHERE id = ?").get(id);
    return row ? inboxRowToItem(row) : null;
  }

  /** 取一批待整理条目（同类型聚合，供批量分类） */
  takeInboxBatch(
    agentId: string,
    userId: string,
    itemType: WikiInboxItemType,
    batchSize: number,
    maxAttempts = 4,
  ): readonly WikiInboxItem[] {
    const rows = this.db
      .prepare<WikiInboxRow>(
        `SELECT * FROM wiki_inbox
         WHERE agent_id = ? AND user_id = ? AND status = 'pending' AND item_type = ?
           AND attempt_count < ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(agentId, userId, itemType, maxAttempts, batchSize);
    return rows.map(inboxRowToItem);
  }

  /**
   * 记一次未能归档。outcome 区分两种情形：
   * `degraded` = AI 拿不准/越权，按一期约定留待人工整理，不是错误；
   * `failed` = 落库或调用真的出错了，可重试。
   * 两者都占用重试预算（attempt_count），但 UI 文案不同。
   */
  markInboxAttemptFailed(id: string, error: string, outcome: "degraded" | "failed" = "failed"): void {
    this.db
      .prepare(
        "UPDATE wiki_inbox SET attempt_count = attempt_count + 1, last_error = ?, last_outcome = ? WHERE id = ?",
      )
      .run(error, outcome, id);
  }

  markInboxOrganized(id: string, organizedSourceId: string): void {
    this.db
      .prepare(
        "UPDATE wiki_inbox SET status = 'organized', organized_source_id = ?, organized_at = ? WHERE id = ?",
      )
      .run(organizedSourceId, new Date().toISOString(), id);
  }

  /**
   * 把一条收件箱条目归档进资料层：建资料行 → 写用途归属 → 建索引 → 标记已归档。
   * 四步必须同生共死：中途失败（最常见是主题越权被 validateTopicAssignment 拒）如果不回滚，
   * 会留下一条主题为空的孤儿资料，而条目仍是 pending，下次重试再建一条——createSource
   * 不按 content_hash 去重，重试几次就是几份。主题校验放在事务外先做，尽早失败。
   */
  archiveInboxItem(item: WikiInboxItem, category: string, subtopic: string | null, title?: string): WikiSource {
    const tree = this.getOrCreateTopicTree();
    const valid = validateTopicAssignment(tree, category, subtopic, { allowParking: true });
    if (!valid.ok) throw new Error(valid.reason);

    const originContext =
      item.item_type === "search" && item.source_url
        ? `原文链接: ${item.source_url}`
        : undefined;

    return withTransaction(this.db, () => {
      const source = this.createSource({
        agentId: item.agent_id,
        userId: item.user_id,
        title: title ?? item.title,
        sourcePath: item.source_path ?? undefined,
        contentMd: item.content_preview ?? undefined,
        contentHash: item.content_hash ?? undefined,
        mediaType: item.media_type,
        extractedText: item.content_preview ?? undefined,
        originContext,
      });
      const updated = this.updateSourceTopic(item.agent_id, item.user_id, source.id, category, subtopic);
      this.indexSource(source.id);
      this.markInboxOrganized(item.id, source.id);
      return updated;
    });
  }

  /**
   * 直接归档但不写主题：资料留在未分类状态。给「关掉 AI 自动分类，收件箱只做预处理」
   * 的流程用。搜索条目的 source_url 记进 origin_url，让详情页能显示原文链接。
   * 与 archiveInboxItem 同样是事务：建资料 → 建索引 → 标记已归档，中途失败一起回滚。
   */
  fileInboxItemUnclassified(item: WikiInboxItem, title?: string): WikiSource {
    const originUrl = item.item_type === "search" && item.source_url ? item.source_url : null;

    return withTransaction(this.db, () => {
      const source = this.createSource({
        agentId: item.agent_id,
        userId: item.user_id,
        title: title ?? item.title,
        sourcePath: item.source_path ?? undefined,
        contentMd: item.content_preview ?? undefined,
        contentHash: item.content_hash ?? undefined,
        mediaType: item.media_type,
        extractedText: item.content_preview ?? undefined,
        originUrl: originUrl ?? undefined,
      });
      this.indexSource(source.id);
      this.markInboxOrganized(item.id, source.id);
      return source;
    });
  }

/**
   * 丢弃条目。
   * @returns 是否真的改了一行；false 表示 id 不存在（调用方据此报错而非静默成功）
   */
  discardInbox(id: string): boolean {
    const info = this.db.prepare("UPDATE wiki_inbox SET status = 'discarded' WHERE id = ?").run(id);
    return info.changes > 0;
  }

  /**
   * 重试：清零尝试计数与错误，回到可被再次取件的状态。
   * 只对 pending 生效——已归档/已丢弃的条目不应被"复活"。
   * @returns 是否真的改了一行；false 表示 id 不存在或状态不是 pending
   */
  retryInbox(id: string): boolean {
    const info = this.db
      .prepare(
        "UPDATE wiki_inbox SET attempt_count = 0, last_error = NULL, last_outcome = NULL WHERE id = ? AND status = 'pending'",
      )
      .run(id);
    return info.changes > 0;
  }

  /**
   * 列出当前有 pending 收件箱条目的 (agentId, userId) 组合。
   * 供应用级整理轮询发现待处理归属，避免轮询硬编码某个固定 agentId。
   */
  listPendingAgentUserPairs(): readonly { readonly agentId: string; readonly userId: string }[] {
    const rows = this.db
      .prepare<{ agent_id: string; user_id: string }>(
        "SELECT DISTINCT agent_id, user_id FROM wiki_inbox WHERE status = 'pending'",
      )
      .all();
    return rows.map((r) => ({ agentId: r.agent_id, userId: r.user_id }));
  }

  // ── 资料层 ──────────────────────────────────────────────

  createSource(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly title: string;
    readonly sourcePath?: string;
    readonly contentMd?: string;
    readonly contentHash?: string;
    readonly mimeType?: string;
    readonly mediaType?: WikiMediaType;
    readonly extractedText?: string;
    readonly mediaMeta?: string;
    readonly previewPath?: string;
    readonly originContext?: string;
    readonly originUrl?: string;
    readonly storageMode?: WikiStorageMode;
  }): WikiSource {
    const id = generateWikiId();
    const now = new Date().toISOString();
    const storageMode = params.storageMode ?? "ref";
    this.db
      .prepare(
        `INSERT INTO wiki_sources
         (id, agent_id, user_id, title, source_path, content_md, content_hash, mime_type,
          media_type, extracted_text, media_meta, preview_path, origin_context, created_at,
          topic_category, topic_subtopic, last_used, use_count, origin_url, storage_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        params.title,
        params.sourcePath ?? null,
        params.contentMd ?? null,
        params.contentHash ?? null,
        params.mimeType ?? null,
        params.mediaType ?? "document",
        params.extractedText ?? null,
        params.mediaMeta ?? null,
        params.previewPath ?? null,
        params.originContext ?? null,
        now,
        null,
        null,
        null,
        0,
        params.originUrl ?? null,
        storageMode,
      );
    return {
      id,
      agent_id: params.agentId,
      user_id: params.userId,
      title: params.title,
      source_path: params.sourcePath ?? null,
      content_md: params.contentMd ?? null,
      content_hash: params.contentHash ?? null,
      mime_type: params.mimeType ?? null,
      media_type: params.mediaType ?? "document",
      extracted_text: params.extractedText ?? null,
      media_meta: params.mediaMeta ?? null,
      preview_path: params.previewPath ?? null,
      origin_context: params.originContext ?? null,
      archived_at: null,
      created_at: now,
      topic_category: null,
      topic_subtopic: null,
      last_used: null,
      use_count: 0,
      origin_url: params.originUrl ?? null,
      storage_mode: storageMode,
    };
  }

  /**
   * 按 id 取资料。传 agentId/userId 时限定归属（读取原文件、改主题等入口应当传），
   * 不传则跨归属查找，仅供已自行确认归属的内部调用（如按 source_ref 反查）。
   */
  findSourceById(id: string, agentId?: string, userId?: string): WikiSource | null {
    const row =
      agentId !== undefined && userId !== undefined
        ? this.db
            .prepare<WikiSource>(
              "SELECT * FROM wiki_sources WHERE id = ? AND agent_id = ? AND user_id = ?",
            )
            .get(id, agentId, userId)
        : this.db.prepare<WikiSource>("SELECT * FROM wiki_sources WHERE id = ?").get(id);
    return row ?? null;
  }

  /**
   * 按 source_path 反查资料。供 wiki_read 兼容 wiki_search 返回的 sourcePath——
   * 资料层没有独立的路径命名空间，磁盘路径就是它的自然键。
   */
  findSourceBySourcePath(agentId: string, userId: string, sourcePath: string): WikiSource | null {
    const row = this.db
      .prepare<WikiSource>(
        "SELECT * FROM wiki_sources WHERE agent_id = ? AND user_id = ? AND source_path = ?",
      )
      .get(agentId, userId, sourcePath);
    return row ?? null;
  }

  /**
   * 判断 source_path 是否已在 Wiki（资料层或有效收件箱条目）。
   * 供文件夹批量导入 scan 阶段去重预览。
   */
  isSourcePathKnown(agentId: string, userId: string, sourcePath: string): boolean {
    const key = sourcePath.replace(/\\/g, "/");
    const source = this.findSourceBySourcePath(agentId, userId, key);
    if (source) return true;
    const row = this.db
      .prepare<{ n: number }>(
        `SELECT 1 AS n FROM wiki_inbox
         WHERE agent_id = ? AND user_id = ?
           AND REPLACE(source_path, '\\', '/') = ?
           AND status != 'discarded'
         LIMIT 1`,
      )
      .get(agentId, userId, key);
    return row != null;
  }

  listSources(agentId: string, userId: string): readonly WikiSource[] {
    return this.db
      .prepare<WikiSource>(
        "SELECT * FROM wiki_sources WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC",
      )
      .all(agentId, userId);
  }

  // ── 用途主题树 ──────────────────────────────────────────

  /** 读取主题树；不存在时写入默认树并返回 */
  getOrCreateTopicTree(): WikiTopicTree {
    const raw = this.getIndexMeta(TOPIC_CATEGORIES_META_KEY);
    const parsed = parseTopicTree(raw);
    if (parsed) return parsed;
    this.setIndexMeta(TOPIC_CATEGORIES_META_KEY, JSON.stringify(DEFAULT_TOPIC_TREE));
    return DEFAULT_TOPIC_TREE;
  }

  /**
   * 覆盖主题树；若树中删除了仍有资料占用的 (category, subtopic) 组合会产生孤儿，拒绝写入。
   */
  setTopicTree(tree: WikiTopicTree): void {
    if (!validateTopicTree(tree)) {
      throw new Error("主题树结构不合法");
    }
    const occupied = this.db
      .prepare<{ topic_category: string; topic_subtopic: string }>(
        `SELECT DISTINCT topic_category, topic_subtopic FROM wiki_sources
         WHERE topic_category IS NOT NULL AND topic_subtopic IS NOT NULL AND archived_at IS NULL`,
      )
      .all()
      .map((r) => ({ category: r.topic_category, subtopic: r.topic_subtopic }));
    if (treeHasOrphans(tree, occupied)) {
      throw new Error("该主题树会导致已有文件的目录消失（孤儿），已拒绝保存");
    }
    this.setIndexMeta(TOPIC_CATEGORIES_META_KEY, JSON.stringify(tree));
  }

  /**
   * 分组统计各 (category, subtopic) 的在架文件数；key 用 topicCountKey。
   * 主题树是全局的（同 setTopicTree 的孤儿校验口径），故不按 agent 过滤。
   * 跳过待补分（两列 NULL）与临时存放（不参与 disposition 判定）。
   *
   * v1.1 小类可选：只按大类分类的资料（topic_subtopic IS NULL）单独一组统计，
   * key 用 topicCountKey(category)（不传 subtopic），否则这些资料会从计数里彻底消失，
   * 左栏大类计数与「按大类查」都会少算。
   */
  countSourcesByTopic(): Map<string, number> {
    const rows = this.db
      .prepare<{ topic_category: string; topic_subtopic: string | null; n: number }>(
        `SELECT topic_category, topic_subtopic, COUNT(*) AS n FROM wiki_sources
         WHERE topic_category IS NOT NULL
           AND topic_category <> ? AND archived_at IS NULL
         GROUP BY topic_category, topic_subtopic`,
      )
      .all(PARKING_CATEGORY);
    const counts = new Map<string, number>();
    for (const r of rows) {
      counts.set(topicCountKey(r.topic_category, r.topic_subtopic), r.n);
    }
    return counts;
  }

  /**
   * 单事务应用一次主题树变更：plan → 写树 JSON → 按 cascades 批量改 wiki_sources 两列。
   * plan 失败直接抛（需要去向时 message 带文件数）；任一步失败整单回滚。
   */
  applyTopicMutation(mutation: WikiTopicMutation): {
    readonly tree: WikiTopicTree;
    readonly movedCount: number;
  } {
    return withTransaction(this.db, () => {
      const tree = this.getOrCreateTopicTree();
      const counts = this.countSourcesByTopic();
      const plan = planTopicMutation(tree, mutation, counts);
      if (!plan.ok) {
        throw new Error(
          plan.needsDisposition
            ? `该目录下还有 ${plan.fileCount} 个文件，请先选择去向`
            : plan.reason,
        );
      }
      // 直接写 meta 键：不能走 setTopicTree，它的禁孤儿校验会在级联执行前误判。
      // 事务结束时级联已完成，不变量恢复。
      this.setIndexMeta(TOPIC_CATEGORIES_META_KEY, JSON.stringify(plan.tree));
      let movedCount = 0;
      for (const cascade of plan.cascades) {
        movedCount += this.bulkUpdateSourceTopic(cascade);
      }
      return { tree: plan.tree, movedCount };
    });
  }

  /** 等值改写一组资料的主题两列；from.subtopic 为 null 时用 IS NULL 匹配 */
  private bulkUpdateSourceTopic(cascade: TopicCascade): number {
    const subtopicClause =
      cascade.from.subtopic === null ? "topic_subtopic IS NULL" : "topic_subtopic = ?";
    const params: unknown[] = [cascade.to.category, cascade.to.subtopic, cascade.from.category];
    if (cascade.from.subtopic !== null) params.push(cascade.from.subtopic);
    return this.db
      .prepare(
        `UPDATE wiki_sources SET topic_category = ?, topic_subtopic = ?
         WHERE topic_category = ? AND ${subtopicClause} AND archived_at IS NULL`,
      )
      .run(...params).changes;
  }

  /**
   * 按用途过滤资料列表。`parking` 与 `unfiled` 互斥，不应同时传 true。
   * 默认排除已归档（archived_at 非空）；`archived: true` 时只返回已归档项且忽略分类过滤。
   */
  listSourcesByTopic(
    agentId: string,
    userId: string,
    filter: {
      readonly category?: string;
      readonly subtopic?: string;
      readonly parking?: boolean;
      readonly unfiled?: boolean;
      readonly archived?: boolean;
      readonly mediaType?: WikiMediaType;
    },
  ): readonly WikiSource[] {
    const conditions = ["agent_id = ?", "user_id = ?"];
    const params: unknown[] = [agentId, userId];

    if (filter.archived) {
      conditions.push("archived_at IS NOT NULL");
    } else {
      conditions.push("archived_at IS NULL");
    }

    if (filter.archived) {
      // 归档分区为扁平列表，不受 category/subtopic/unfiled/parking 影响。
    } else if (filter.parking) {
      conditions.push("topic_category = ?", "topic_subtopic IS NULL");
      params.push(PARKING_CATEGORY);
    } else if (filter.unfiled) {
      conditions.push("topic_category IS NULL", "topic_subtopic IS NULL");
    } else if (filter.category && filter.subtopic) {
      conditions.push("topic_category = ?", "topic_subtopic = ?");
      params.push(filter.category, filter.subtopic);
    } else if (filter.category) {
      // v1.1 小类可选：仅按大类查时不再要求 topic_subtopic 非空，
      // 否则 category 已定、subtopic=null（未细分）的资料会在「按大类浏览」里消失。
      conditions.push("topic_category = ?");
      params.push(filter.category);
    }

    if (filter.mediaType) {
      conditions.push("media_type = ?");
      params.push(filter.mediaType);
    }

    return this.db
      .prepare<WikiSource>(
        `SELECT * FROM wiki_sources WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      )
      .all(...params);
  }

  /**
   * 更新某条资料的用途归属；写前用 allowParking 校验，越权归属会抛错。
   * 按 agent_id + user_id 限定，避免拿到一个 id 就能改别的 agent 的资料。
   *
   * v1.1：category 放宽为 `string | null`，支持「整类退回收件箱」语义
   * （category=null 时 subtopic 必须同为 null，直接落两列为 NULL，不经 validateTopicAssignment——
   * 语义等价 clearSourceTopic，但走这个方法能让调用方统一走一个入口）。
   */
  updateSourceTopic(
    agentId: string,
    userId: string,
    sourceId: string,
    category: string | null,
    subtopic: string | null,
  ): WikiSource {
    if (category === null) {
      if (subtopic !== null) {
        throw new Error("大类为空时小类必须也为空");
      }
      return this.clearSourceTopic(agentId, userId, sourceId);
    }
    const tree = this.getOrCreateTopicTree();
    const result = validateTopicAssignment(tree, category, subtopic, { allowParking: true });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const info = this.db
      .prepare(
        "UPDATE wiki_sources SET topic_category = ?, topic_subtopic = ? WHERE id = ? AND agent_id = ? AND user_id = ?",
      )
      .run(category, subtopic, sourceId, agentId, userId);
    if (info.changes === 0) throw new Error(`资料不存在: ${sourceId}`);
    const source = this.findSourceById(sourceId);
    if (!source) throw new Error(`资料不存在: ${sourceId}`);
    return source;
  }

  /**
   * 把资料退回未分类（两列置 NULL）。不走 validateTopicAssignment——清空不是一次归属，
   * 没有「越权」可言；用户撤销误分类时不该被树校验挡住。
   */
  clearSourceTopic(agentId: string, userId: string, sourceId: string): WikiSource {
    const info = this.db
      .prepare(
        "UPDATE wiki_sources SET topic_category = NULL, topic_subtopic = NULL WHERE id = ? AND agent_id = ? AND user_id = ?",
      )
      .run(sourceId, agentId, userId);
    if (info.changes === 0) throw new Error(`资料不存在: ${sourceId}`);
    const source = this.findSourceById(sourceId);
    if (!source) throw new Error(`资料不存在: ${sourceId}`);
    return source;
  }

  /**
   * 更新资料的 source_path（vault ref 或 native md 相对/绝对路径）。
   */
  updateSourcePath(
    agentId: string,
    userId: string,
    sourceId: string,
    sourcePath: string,
  ): WikiSource {
    const info = this.db
      .prepare(
        "UPDATE wiki_sources SET source_path = ? WHERE id = ? AND agent_id = ? AND user_id = ?",
      )
      .run(sourcePath, sourceId, agentId, userId);
    if (info.changes === 0) throw new Error(`资料不存在: ${sourceId}`);
    const source = this.findSourceById(sourceId, agentId, userId);
    if (!source) throw new Error(`资料不存在: ${sourceId}`);
    return source;
  }

  /**
   * 写资料的来源与存放方式。两个字段都可选：只传一个时另一个保持原值，
   * 便于「先记链接、后来才复制副本」这类分步更新。
   */
  setSourceStorage(
    agentId: string,
    userId: string,
    sourceId: string,
    params: {
      readonly originUrl?: string | null;
      readonly storageMode?: WikiStorageMode;
      readonly sourcePath?: string;
      readonly contentMd?: string;
      readonly extractedText?: string;
      readonly mimeType?: string;
    },
  ): WikiSource {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (params.originUrl !== undefined) {
      sets.push("origin_url = ?");
      args.push(params.originUrl);
    }
    if (params.storageMode !== undefined) {
      sets.push("storage_mode = ?");
      args.push(params.storageMode);
    }
    if (params.sourcePath !== undefined) {
      sets.push("source_path = ?");
      args.push(params.sourcePath);
    }
    if (params.contentMd !== undefined) {
      sets.push("content_md = ?");
      args.push(params.contentMd);
    }
    if (params.extractedText !== undefined) {
      sets.push("extracted_text = ?");
      args.push(params.extractedText);
    }
    if (params.mimeType !== undefined) {
      sets.push("mime_type = ?");
      args.push(params.mimeType);
    }
    if (sets.length === 0) {
      const current = this.findSourceById(sourceId, agentId, userId);
      if (!current) throw new Error(`资料不存在: ${sourceId}`);
      return current;
    }
    const info = this.db
      .prepare(
        `UPDATE wiki_sources SET ${sets.join(", ")} WHERE id = ? AND agent_id = ? AND user_id = ?`,
      )
      .run(...args, sourceId, agentId, userId);
    if (info.changes === 0) throw new Error(`资料不存在: ${sourceId}`);
    const source = this.findSourceById(sourceId);
    if (!source) throw new Error(`资料不存在: ${sourceId}`);
    return source;
  }

  // ── 重新编目批次 ────────────────────────────────────────

  /** 读取当前重编目批次；解析失败视为不存在，避免坏 JSON 卡死入口 */
  getReclassifyRun(agentId: string, userId: string): unknown | null {
    const raw = this.getIndexMeta(this.reclassifyRunKey(agentId, userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 覆盖式写入当前批次；传 null 清空。每 agent+user 只留一条 */
  setReclassifyRun(agentId: string, userId: string, run: unknown | null): void {
    const key = this.reclassifyRunKey(agentId, userId);
    if (run === null) {
      this.db.prepare("DELETE FROM wiki_index_meta WHERE key = ?").run(key);
      return;
    }
    this.setIndexMeta(key, JSON.stringify(run));
  }

  private reclassifyRunKey(agentId: string, userId: string): string {
    return `${RECLASSIFY_RUN_META_KEY}:${agentId}:${userId}`;
  }

  // ── 图谱抽取游标（三期） ────────────────────────────────

  /**
   * 读取 ERO 增量抽取游标：sourceId → content_hash。
   * 游标是纯派生数据，损坏时重抽一遍即可，绝不能让图谱视图整体报错，
   * 所以解析或结构校验失败都退化为空对象（等价于「全部需要重抽」）。
   */
  getGraphExtractCursor(agentId: string, userId: string): WikiGraphExtractCursor {
    const raw = this.getIndexMeta(this.graphExtractCursorKey(agentId, userId));
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const cursor: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") return {};
      cursor[key] = value;
    }
    return cursor;
  }

  /** 覆盖式写入抽取游标 */
  setGraphExtractCursor(agentId: string, userId: string, cursor: WikiGraphExtractCursor): void {
    this.setIndexMeta(this.graphExtractCursorKey(agentId, userId), JSON.stringify(cursor));
  }

  private graphExtractCursorKey(agentId: string, userId: string): string {
    return `${GRAPH_EXTRACT_CURSOR_META_KEY}:${agentId}:${userId}`;
  }

  /**
   * 重编目扫描集：只含正式归档的资料（两列非空、非临时存放、未归档）。
   * 待补分与临时存放不参与重编目（设计 §9.1）。
   */
  listSourcesForReclassify(
    agentId: string,
    userId: string,
    scope:
      | { readonly kind: "source"; readonly sourceId: string }
      | { readonly kind: "subtopic"; readonly category: string; readonly subtopic: string }
      | { readonly kind: "all" },
  ): readonly WikiSource[] {
    const conditions = [
      "agent_id = ?",
      "user_id = ?",
      "archived_at IS NULL",
      "topic_category IS NOT NULL",
      "topic_subtopic IS NOT NULL",
      "topic_category <> ?",
    ];
    const params: unknown[] = [agentId, userId, PARKING_CATEGORY];
    if (scope.kind === "source") {
      conditions.push("id = ?");
      params.push(scope.sourceId);
    } else if (scope.kind === "subtopic") {
      conditions.push("topic_category = ?", "topic_subtopic = ?");
      params.push(scope.category, scope.subtopic);
    }
    return this.db
      .prepare<WikiSource>(
        `SELECT * FROM wiki_sources WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`,
      )
      .all(...params);
  }

  /**
   * 只改标题，不动 source_path：磁盘文件名保持稳定，避免已有引用失效。
   * 改完重建该行的 FTS，否则按新标题搜不到。
   */
  renameSource(agentId: string, userId: string, sourceId: string, title: string): WikiSource {
    const info = this.db
      .prepare("UPDATE wiki_sources SET title = ? WHERE id = ? AND agent_id = ? AND user_id = ?")
      .run(title, sourceId, agentId, userId);
    if (info.changes === 0) throw new Error(`资料不存在: ${sourceId}`);
    this.indexSource(sourceId);
    const source = this.findSourceById(sourceId);
    if (!source) throw new Error(`资料不存在: ${sourceId}`);
    return source;
  }

  /** 命中即更新 last_used / use_count（打开原文件、检索命中时调用），按归属限定 */
  touchSource(agentId: string, userId: string, sourceId: string): void {
    this.db
      .prepare(
        "UPDATE wiki_sources SET last_used = ?, use_count = use_count + 1 WHERE id = ? AND agent_id = ? AND user_id = ?",
      )
      .run(new Date().toISOString(), sourceId, agentId, userId);
  }

  /** 把一条资料写入/覆盖资料层 FTS 索引；供归档流水线调用，避免 organizer 直接碰 db */
  indexSource(sourceId: string): void {
    const row = this.db
      .prepare<{ rowid: number; title: string; extracted_text: string | null }>(
        "SELECT rowid, title, extracted_text FROM wiki_sources WHERE id = ?",
      )
      .get(sourceId);
    if (!row) return;
    this.indexRepo.upsertSourceRow(row.rowid, row.title, row.extracted_text);
  }

  /**
   * 该资料关联的页面（通过 wiki_page_revisions.source_ref = sourceId 找到）是否显示过使用痕迹
   * （last_used 非空或 use_count > 0）。找不到关联页面视为「未使用」。
   * 供清理扫描判断「长期未用」规则；P0 摄入时资料与页面一一对应（source_ref = source.id）。
   */
  /**
   * 找到该资料对应的页面（通过 wiki_page_revisions.source_ref = sourceId 的最新修订反查）。
   * P0 摄入时资料与页面一一对应；找不到返回 null（资料无对应页面是正常情况）。
   */
  findPageBySourceRef(agentId: string, userId: string, sourceId: string): WikiPage | null {
    const row = this.db
      .prepare<WikiPageRow>(
        `SELECT p.* FROM wiki_pages p
         JOIN wiki_page_revisions r ON r.page_id = p.id
         WHERE p.agent_id = ? AND p.user_id = ? AND r.source_ref = ?
         ORDER BY r.version DESC LIMIT 1`,
      )
      .get(agentId, userId, sourceId);
    return row ? pageRowToPage(row) : null;
  }

  /** 归档资料条目：置 archived_at，返回实际改动行数 */
  archiveSources(agentId: string, userId: string, sourceIds: readonly string[]): number {
    if (sourceIds.length === 0) return 0;
    const placeholders = sourceIds.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `UPDATE wiki_sources SET archived_at = ? WHERE agent_id = ? AND user_id = ? AND id IN (${placeholders}) AND archived_at IS NULL`,
      )
      .run(new Date().toISOString(), agentId, userId, ...sourceIds);
    return info.changes;
  }

  /** 恢复归档：清空 archived_at，返回实际改动行数 */
  restoreSources(agentId: string, userId: string, sourceIds: readonly string[]): number {
    if (sourceIds.length === 0) return 0;
    const placeholders = sourceIds.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `UPDATE wiki_sources SET archived_at = NULL WHERE agent_id = ? AND user_id = ? AND id IN (${placeholders}) AND archived_at IS NOT NULL`,
      )
      .run(agentId, userId, ...sourceIds);
    return info.changes;
  }

  /**
   * 物理删除资料条目。不级联删除引用它的页面——页面仅失去来源标注
   * （page_revisions.source_ref 保持原值，指向已不存在的资料 id，来源详情入口需自行处理「资料已删除」展示）。
   */
  deleteSources(agentId: string, userId: string, sourceIds: readonly string[]): number {
    if (sourceIds.length === 0) return 0;
    const placeholders = sourceIds.map(() => "?").join(",");
    return withTransaction(this.db, () => {
      // 先取 rowid 再删：wiki_sources_fts 不是 external content 表，没有触发器同步，
      // 漏删会留下孤儿索引行，而 SQLite 会回收 rowid——新资料可能继承它，搜出别人的正文。
      const rows = this.db
        .prepare<{ rowid: number }>(
          `SELECT rowid FROM wiki_sources WHERE agent_id = ? AND user_id = ? AND id IN (${placeholders})`,
        )
        .all(agentId, userId, ...sourceIds);
      const info = this.db
        .prepare(`DELETE FROM wiki_sources WHERE agent_id = ? AND user_id = ? AND id IN (${placeholders})`)
        .run(agentId, userId, ...sourceIds);
      for (const row of rows) this.indexRepo.deleteSourceRow(row.rowid);
      return info.changes;
    });
  }

  /**
   * 批量删除页面，返回删除数与受影响反链数（供 UI 二次确认展示）。
   * 受影响反链数 = 这些页面作为目标时，其他页面指向它们的链接行数（去重按链接行计）。
   */
  deletePages(
    agentId: string,
    userId: string,
    pageIds: readonly string[],
  ): { readonly deleted: number; readonly affectedBacklinks: number } {
    if (pageIds.length === 0) return { deleted: 0, affectedBacklinks: 0 };
    return withTransaction(this.db, () => {
      const placeholders = pageIds.map(() => "?").join(",");
      const backlinkCount = this.db
        .prepare<{ c: number }>(
          `SELECT COUNT(*) as c FROM wiki_links WHERE agent_id = ? AND user_id = ? AND target_page_id IN (${placeholders})`,
        )
        .get(agentId, userId, ...pageIds);

      let deleted = 0;
      for (const id of pageIds) {
        const page = this.findPageById(id);
        if (!page || page.agent_id !== agentId || page.user_id !== userId) continue;
        this.deletePage(id);
        deleted += 1;
      }
      return { deleted, affectedBacklinks: backlinkCount?.c ?? 0 };
    });
  }

  // ── 附件 ────────────────────────────────────────────────

  /**
   * 登记一个附件到页面。只引用路径不搬移文件（沿用 P0 约定）。
   * sourceId 非空时表示该文件同时是既有资料条目，不重复存储——附件行仅指向既有资料路径。
   */
  attachFile(params: {
    readonly pageId: string;
    readonly filePath: string;
    readonly mediaType: WikiMediaType;
    readonly displayName: string;
    readonly sourceId?: string;
  }): WikiAttachment {
    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_page_attachments (id, page_id, source_id, file_path, media_type, display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, params.pageId, params.sourceId ?? null, params.filePath, params.mediaType, params.displayName, now);
    return {
      id,
      page_id: params.pageId,
      source_id: params.sourceId ?? null,
      file_path: params.filePath,
      media_type: params.mediaType,
      display_name: params.displayName,
      created_at: now,
    };
  }

  listAttachments(pageId: string): readonly WikiAttachment[] {
    return this.db
      .prepare<WikiAttachment>(
        "SELECT * FROM wiki_page_attachments WHERE page_id = ? ORDER BY created_at ASC",
      )
      .all(pageId);
  }

  /** 解绑附件，返回是否真的删了一行 */
  detachFile(attachmentId: string): boolean {
    const info = this.db.prepare("DELETE FROM wiki_page_attachments WHERE id = ?").run(attachmentId);
    return info.changes > 0;
  }

  // ── 知识层（页面）──────────────────────────────────────

  /**
   * 保存页面：不存在则新建（version=1），存在则同事务内递增 version 并写修订。
   * 路径必须已通过 validateWikiPath 校验，调用方负责降级。
   */
  savePage(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly path: string;
    readonly title: string;
    readonly contentMd: string;
    readonly editor: WikiRevisionEditor;
    readonly sourceRef?: string;
  }): WikiPage {
    const { category } = validateWikiPath(params.path);
    if (!category) {
      throw new Error(`非法 Wiki 路径: ${params.path}`);
    }

    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare<WikiPageRow>(
          "SELECT * FROM wiki_pages WHERE agent_id = ? AND user_id = ? AND path = ?",
        )
        .get(params.agentId, params.userId, params.path);

      const now = new Date().toISOString();
      let page: WikiPage;
      let rowid: number | bigint;

      if (existing) {
        const nextVersion = existing.version + 1;
        this.db
          .prepare(
            "UPDATE wiki_pages SET title = ?, content_md = ?, version = ?, updated_at = ? WHERE id = ?",
          )
          .run(params.title, params.contentMd, nextVersion, now, existing.id);
        page = {
          ...pageRowToPage(existing),
          title: params.title,
          content_md: params.contentMd,
          version: nextVersion,
          updated_at: now,
        };
        rowid = this.db
          .prepare<{ rowid: number }>("SELECT rowid FROM wiki_pages WHERE id = ?")
          .get(existing.id)!.rowid;
        this.insertRevision(existing.id, nextVersion, params.title, params.path, params.contentMd, params.editor, params.sourceRef, now);
      } else {
        const id = generateWikiId();
        this.db
          .prepare(
            `INSERT INTO wiki_pages
             (id, agent_id, user_id, path, category, title, content_md, version, use_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
          )
          .run(id, params.agentId, params.userId, params.path, category, params.title, params.contentMd, now, now);
        page = {
          id,
          agent_id: params.agentId,
          user_id: params.userId,
          path: params.path,
          category,
          title: params.title,
          content_md: params.contentMd,
          version: 1,
          last_used: null,
          use_count: 0,
          created_at: now,
          updated_at: now,
          status: "active",
        };
        rowid = this.db.prepare<{ rowid: number }>("SELECT rowid FROM wiki_pages WHERE id = ?").get(id)!.rowid;
        this.insertRevision(id, 1, params.title, params.path, params.contentMd, params.editor, params.sourceRef, now);
      }

      this.indexRepo.upsertRow(rowid, page.title, page.content_md);
      this.recomputeLinksForPage(params.agentId, params.userId, page.id, params.path, page.content_md);
      return page;
    });
  }

  /**
   * 重算某页的出向链接索引：删除旧行 → 解析 → 插入新行。
   * 解析失败/歧义的行以 is_resolved=0 落库，anchor_text 保留供 UI 展示候选。
   * 必须在 savePage 的同一事务内调用，链接解析永不抛异常（resolveWikilinkTarget 已兜底）。
   */
  private recomputeLinksForPage(
    agentId: string,
    userId: string,
    pageId: string,
    pagePath: string,
    contentMd: string,
  ): void {
    this.db.prepare("DELETE FROM wiki_links WHERE source_page_id = ?").run(pageId);

    const candidates = parseWikilinks(contentMd);
    if (candidates.length === 0) return;

    const allPages: WikilinkCandidatePage[] = this.db
      .prepare<{ id: string; path: string; title: string }>(
        "SELECT id, path, title FROM wiki_pages WHERE agent_id = ? AND user_id = ?",
      )
      .all(agentId, userId);

    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO wiki_links (id, agent_id, user_id, source_page_id, target_page_id, anchor_text, is_resolved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const candidate of candidates) {
      const resolution = resolveWikilinkTarget(candidate.anchorText, pagePath, allPages);
      insert.run(
        generateWikiId(),
        agentId,
        userId,
        pageId,
        resolution.targetPageId,
        candidate.anchorText,
        resolution.isResolved ? 1 : 0,
        now,
      );
    }
  }

  private insertRevision(
    pageId: string,
    version: number,
    title: string,
    path: string,
    contentMd: string,
    editor: WikiRevisionEditor,
    sourceRef: string | undefined,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO wiki_page_revisions (id, page_id, version, title, path, content_md, editor, source_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(generateWikiId(), pageId, version, title, path, contentMd, editor, sourceRef ?? null, now);
  }

  findPageById(id: string): WikiPage | null {
    const row = this.db.prepare<WikiPageRow>("SELECT * FROM wiki_pages WHERE id = ?").get(id);
    return row ? pageRowToPage(row) : null;
  }

  findPageByPath(agentId: string, userId: string, path: string): WikiPage | null {
    const row = this.db
      .prepare<WikiPageRow>("SELECT * FROM wiki_pages WHERE agent_id = ? AND user_id = ? AND path = ?")
      .get(agentId, userId, path);
    return row ? pageRowToPage(row) : null;
  }

  /** 某页的修订列表，按 version 降序 */
  listRevisions(pageId: string): readonly WikiPageRevision[] {
    return this.db
      .prepare<WikiPageRevision>(
        "SELECT * FROM wiki_page_revisions WHERE page_id = ? ORDER BY version DESC",
      )
      .all(pageId);
  }

  /**
   * 回滚：读取目标版本内容作为一次新的编辑写入，走 savePage 同一条路径。
   * version+1，editor 固定为 'user'（用户主动触发的回滚操作），source_ref 记录来源版本号。
   * 旧修订永不被物理修改或覆盖。
   */
  rollbackPage(agentId: string, userId: string, pageId: string, targetVersion: number): WikiPage {
    const page = this.findPageById(pageId);
    if (!page || page.agent_id !== agentId || page.user_id !== userId) {
      throw new Error(`页面不存在或无权访问: ${pageId}`);
    }
    const target = this.db
      .prepare<WikiPageRevision>(
        "SELECT * FROM wiki_page_revisions WHERE page_id = ? AND version = ?",
      )
      .get(pageId, targetVersion);
    if (!target) {
      throw new Error(`目标版本不存在: page=${pageId} version=${targetVersion}`);
    }

    return this.savePage({
      agentId,
      userId,
      path: page.path,
      title: target.title,
      contentMd: target.content_md,
      editor: "user",
      sourceRef: `rollback:v${targetVersion}`,
    });
  }

  listPages(agentId: string, userId: string, category?: WikiCategory): readonly WikiPage[] {
    const rows = category
      ? this.db
          .prepare<WikiPageRow>(
            "SELECT * FROM wiki_pages WHERE agent_id = ? AND user_id = ? AND category = ? ORDER BY updated_at DESC",
          )
          .all(agentId, userId, category)
      : this.db
          .prepare<WikiPageRow>(
            "SELECT * FROM wiki_pages WHERE agent_id = ? AND user_id = ? ORDER BY updated_at DESC",
          )
          .all(agentId, userId);
    return rows.map(pageRowToPage);
  }

  /** 按分类统计页面数（供 Agent overview 与左栏分类树） */
  countByCategory(agentId: string, userId: string): Readonly<Record<string, number>> {
    const rows = this.db
      .prepare<{ category: string; c: number }>(
        "SELECT category, COUNT(*) as c FROM wiki_pages WHERE agent_id = ? AND user_id = ? GROUP BY category",
      )
      .all(agentId, userId);
    const result: Record<string, number> = {};
    for (const row of rows) result[row.category] = row.c;
    return result;
  }

  /**
   * 删除页面：级联清理以该页为源的链接行；以该页为目标的链接行置未解析
   * （target_page_id 无外键约束，需在应用层显式维护，见设计 §4.2）。
   */
  deletePage(id: string): void {
    withTransaction(this.db, () => {
      const row = this.db.prepare<{ rowid: number }>("SELECT rowid FROM wiki_pages WHERE id = ?").get(id);
      this.db.prepare("DELETE FROM wiki_pages WHERE id = ?").run(id);
      if (row) this.indexRepo.deleteRow(row.rowid);
      this.db.prepare("DELETE FROM wiki_links WHERE source_page_id = ?").run(id);
      this.db
        .prepare("UPDATE wiki_links SET target_page_id = NULL, is_resolved = 0 WHERE target_page_id = ?")
        .run(id);
    });
  }

  /** 命中即更新 last_used / use_count（检索命中与读取时调用） */
  touchPage(id: string): void {
    this.db
      .prepare("UPDATE wiki_pages SET last_used = ?, use_count = use_count + 1 WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  // ── 链接与反链 ──────────────────────────────────────────

  /** 指向某页的反链：含源页标题/路径 + 链接原文 + 解析状态 */
  listBacklinks(agentId: string, userId: string, pageId: string): readonly WikiBacklink[] {
    const rows = this.db
      .prepare<{
        link_id: string;
        source_page_id: string;
        source_title: string;
        source_path: string;
        anchor_text: string;
        is_resolved: number;
      }>(
        `SELECT l.id as link_id, l.source_page_id, p.title as source_title, p.path as source_path,
                l.anchor_text, l.is_resolved
         FROM wiki_links l
         JOIN wiki_pages p ON p.id = l.source_page_id
         WHERE l.agent_id = ? AND l.user_id = ? AND l.target_page_id = ?
         ORDER BY l.created_at DESC`,
      )
      .all(agentId, userId, pageId);
    return rows.map((row) => ({
      linkId: row.link_id,
      sourcePageId: row.source_page_id,
      sourceTitle: row.source_title,
      sourcePath: row.source_path,
      anchorText: row.anchor_text,
      isResolved: row.is_resolved !== 0,
    }));
  }

  /** 某页的出向链接（含未解析） */
  listOutboundLinks(agentId: string, userId: string, pageId: string): readonly WikiLink[] {
    const rows = this.db
      .prepare<WikiLinkRow>(
        `SELECT * FROM wiki_links WHERE agent_id = ? AND user_id = ? AND source_page_id = ?
         ORDER BY created_at ASC`,
      )
      .all(agentId, userId, pageId);
    return rows.map(linkRowToLink);
  }

  /** 全库未解析链接列表（供 UI「未解析链接」入口） */
  listUnresolvedLinks(agentId: string, userId: string): readonly WikiLink[] {
    const rows = this.db
      .prepare<WikiLinkRow>(
        `SELECT * FROM wiki_links WHERE agent_id = ? AND user_id = ? AND is_resolved = 0
         ORDER BY created_at DESC`,
      )
      .all(agentId, userId);
    return rows.map(linkRowToLink);
  }

  /**
   * 全量重扫所有页面正文重建链接索引（供解析规则升级后修复）。
   * 返回重建后的链接行数。
   */
  rebuildLinkIndex(agentId: string, userId: string): number {
    return withTransaction(this.db, () => {
      const pages = this.db
        .prepare<WikiPageRow>("SELECT * FROM wiki_pages WHERE agent_id = ? AND user_id = ?")
        .all(agentId, userId);
      for (const page of pages) {
        this.recomputeLinksForPage(agentId, userId, page.id, page.path, page.content_md);
      }
      const count = this.db
        .prepare<{ c: number }>(
          "SELECT COUNT(*) as c FROM wiki_links WHERE agent_id = ? AND user_id = ?",
        )
        .get(agentId, userId);
      return count?.c ?? 0;
    });
  }

  // ── 检索 ────────────────────────────────────────────────

  /**
   * FTS5 + BM25 检索：查询词按 tokenizeBigram 切分，拼成 **AND** 短语查询并逐 token 转义引号，
   * 避免用户输入被解释为 FTS5 查询语法。
   *
   * 使用 AND 而非 OR：中文短语会拆成多个 bigram（如「架构设计」→ 架构/构设/设计），
   * OR 会导致任一常见 bigram 命中即召回（「完全不存在的词xyz…」误命中含「存在」的页）；
   * AND 要求查询侧全部 token 同页出现，显著降低误配，对连续短语召回仍友好。
   *
   * 归档资料对应的页面（当前版本的 source_ref 指向已归档资料）排除出结果——
   * 具体实现：反连接页面当前版本的修订记录到 wiki_sources，命中已归档来源即排除。
   * 命中后更新 last_used / use_count。
   */
  search(agentId: string, userId: string, keyword: string, limit = 10): readonly WikiSearchHit[] {
    const tokens = [...tokenizeBigram(keyword)];
    if (tokens.length === 0) return [];
    const query = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
    try {
      const rows = this.db
        .prepare<WikiPageRow>(
          `SELECT p.*
           FROM wiki_pages_fts
           JOIN wiki_pages p ON p.rowid = wiki_pages_fts.rowid
           WHERE wiki_pages_fts MATCH ? AND p.agent_id = ? AND p.user_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM wiki_page_revisions r
               JOIN wiki_sources s ON s.id = r.source_ref
               WHERE r.page_id = p.id AND r.version = p.version AND s.archived_at IS NOT NULL
             )
           ORDER BY bm25(wiki_pages_fts)
           LIMIT ?`,
        )
        .all(query, agentId, userId, Math.max(limit * 3, limit));
      const ranked = rows
        .map((row) => {
          const page = pageRowToPage(row);
          return {
            page,
            snippet: row.content_md.slice(0, 200),
            score: computeForgettingScore({
              lastUsedAt: page.last_used,
              createdAt: page.created_at,
              useCount: page.use_count,
            }),
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      for (const hit of ranked) this.touchPage(hit.page.id);
      return ranked.map(({ page, snippet }) => ({ page, snippet }));
    } catch (err) {
      console.warn("[WikiRepo.search] FTS5 查询失败:", err);
      return [];
    }
  }

  /**
   * FTS5 + BM25 检索资料层（title/extracted_text），构造方式同 search()（页面层）。
   * 排除已归档资料；命中即 touchSource。返回完整正文而非截断片段：
   * 一次调用应给 Agent 足够上下文，避免再来一轮 wiki_read（wiki_search 工具描述的承诺）。
   */
  searchSources(agentId: string, userId: string, keyword: string, limit = 10): readonly WikiSourceSearchHit[] {
    const tokens = [...tokenizeBigram(keyword)];
    if (tokens.length === 0) return [];
    const query = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
    try {
      const rows = this.db
        .prepare<WikiSource>(
          `SELECT s.*
           FROM wiki_sources_fts
           JOIN wiki_sources s ON s.rowid = wiki_sources_fts.rowid
           WHERE wiki_sources_fts MATCH ? AND s.agent_id = ? AND s.user_id = ? AND s.archived_at IS NULL
           ORDER BY bm25(wiki_sources_fts)
           LIMIT ?`,
        )
        .all(query, agentId, userId, limit);
      for (const row of rows) this.touchSource(agentId, userId, row.id);
      return rows.map((source) => ({ source, snippet: source.extracted_text ?? "" }));
    } catch (err) {
      console.warn("[WikiRepo.searchSources] FTS5 查询失败:", err);
      return [];
    }
  }

  // ── 运行日志 ────────────────────────────────────────────

  createRun(agentId: string, userId: string, inboxIds: readonly string[]): WikiOrganizeRun {
    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO wiki_organize_runs (id, agent_id, user_id, inbox_ids, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)",
      )
      .run(id, agentId, userId, JSON.stringify(inboxIds), now);
    return {
      id,
      agent_id: agentId,
      user_id: userId,
      inbox_ids: inboxIds,
      status: "running",
      result_summary: null,
      error: null,
      result_detail: null,
      created_at: now,
      finished_at: null,
    };
  }

  finishRun(
    id: string,
    status: WikiOrganizeRunStatus,
    resultSummary?: string,
    error?: string,
    resultDetail?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE wiki_organize_runs
         SET status = ?, result_summary = ?, error = ?, result_detail = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        resultSummary ?? null,
        error ?? null,
        resultDetail ?? null,
        new Date().toISOString(),
        id,
      );
  }

  listRuns(agentId: string, userId: string, limit = 50): readonly WikiOrganizeRun[] {
    const rows = this.db
      .prepare<WikiRunRow>(
        "SELECT * FROM wiki_organize_runs WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(agentId, userId, limit);
    return rows.map(runRowToRun);
  }

  /** 重建 FTS5 派生索引（页面 + 资料），返回两者合计重建行数 */
  rebuildIndex(): number {
    return this.indexRepo.rebuildFts() + this.indexRepo.rebuildSourceFts();
  }

  /**
   * FTS 索引是否与主表一致（页面 + 资料都查）。
   * bigram 分词要 JS 做，SQL migration 建完虚表是空的，老库升级后搜索会静默零命中，
   * 宿主启动时据此决定要不要跑一次 rebuildIndex()。
   */
  checkIndexHealth(): { readonly isHealthy: boolean; readonly reason?: string } {
    const page = this.indexRepo.checkFtsHealth();
    if (!page.isHealthy) return { isHealthy: false, reason: `页面索引：${page.reason}` };
    const source = this.indexRepo.checkSourceFtsHealth();
    if (!source.isHealthy) return { isHealthy: false, reason: `资料索引：${source.reason}` };
    return { isHealthy: true };
  }

  // ── 索引元数据 KV ───────────────────────────────────────

  /** 读取一个元数据键值，不存在返回 null（供概念候选存取、索引健康诊断复用） */
  getIndexMeta(key: string): string | null {
    const row = this.db.prepare<{ value: string }>("SELECT value FROM wiki_index_meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  /** 写入/覆盖一个元数据键值 */
  setIndexMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO wiki_index_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  /**
   * 是否允许 AI 自动给收件箱条目分类。默认 false：分类是有主观判断的动作，
   * 猜错会把资料塞进用户没预期的位置，比留在未分类更难发现。用户显式打开才生效。
   */
  getAutoClassifyEnabled(agentId: string, userId: string): boolean {
    return this.getIndexMeta(this.autoClassifyKey(agentId, userId)) === "1";
  }

  setAutoClassifyEnabled(agentId: string, userId: string, enabled: boolean): void {
    this.setIndexMeta(this.autoClassifyKey(agentId, userId), enabled ? "1" : "0");
  }

  private autoClassifyKey(agentId: string, userId: string): string {
    return `wiki_auto_classify:${agentId}:${userId}`;
  }

  /** 删除一个元数据键 */
  deleteIndexMeta(key: string): void {
    this.db.prepare("DELETE FROM wiki_index_meta WHERE key = ?").run(key);
  }

  /** 列出所有以指定前缀开头的元数据键（供概念候选批量清点/清除） */
  listIndexMetaByPrefix(prefix: string): readonly { readonly key: string; readonly value: string }[] {
    return this.db
      .prepare<{ key: string; value: string }>("SELECT key, value FROM wiki_index_meta WHERE key LIKE ?")
      .all(`${prefix}%`);
  }

  // ── 综述合成（wiki_syntheses）────────────────────────────

  /** 插入一条 candidate 合成记录，返回 id */
  insertSynthesis(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly sourcePageIds: readonly string[];
    readonly sourceIds?: readonly string[] | null;
    readonly title: string;
    readonly candidateMd: string;
    readonly outputPath?: string | null;
    readonly error?: string | null;
  }): string {
    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_syntheses
         (id, agent_id, user_id, source_page_ids, source_ids, title, output_path, candidate_md, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.userId,
        JSON.stringify(params.sourcePageIds),
        params.sourceIds && params.sourceIds.length > 0 ? JSON.stringify(params.sourceIds) : null,
        params.title,
        params.outputPath ?? null,
        params.candidateMd,
        params.error ?? null,
        now,
      );
    return id;
  }

  findSynthesisById(id: string): WikiSynthesis | null {
    const row = this.db.prepare<WikiSynthesisRow>("SELECT * FROM wiki_syntheses WHERE id = ?").get(id);
    return row ? synthesisRowToSynthesis(row) : null;
  }

  /** 按状态筛选合成列表（缺省全部），按 created_at 降序 */
  listSyntheses(
    agentId: string,
    userId: string,
    status?: WikiSynthesisStatus,
  ): readonly WikiSynthesis[] {
    const rows = status
      ? this.db
          .prepare<WikiSynthesisRow>(
            `SELECT * FROM wiki_syntheses WHERE agent_id = ? AND user_id = ? AND status = ?
             ORDER BY created_at DESC`,
          )
          .all(agentId, userId, status)
      : this.db
          .prepare<WikiSynthesisRow>(
            `SELECT * FROM wiki_syntheses WHERE agent_id = ? AND user_id = ?
             ORDER BY created_at DESC`,
          )
          .all(agentId, userId);
    return rows.map(synthesisRowToSynthesis);
  }

  /** 写入进行中进度标记到 error 字段：progress:i/n */
  setSynthesisProgress(id: string, chunk: number, total: number): void {
    this.db
      .prepare("UPDATE wiki_syntheses SET error = ? WHERE id = ? AND status = 'candidate'")
      .run(`progress:${chunk}/${total}`, id);
  }

  /** 完成候选正文落库（仍为 candidate，供审阅） */
  finishSynthesisCandidate(
    id: string,
    params: {
      readonly candidateMd: string;
      readonly outputPath: string | null;
      readonly error: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE wiki_syntheses
         SET candidate_md = ?, output_path = ?, error = ?, finished_at = ?
         WHERE id = ? AND status = 'candidate'`,
      )
      .run(
        params.candidateMd,
        params.outputPath,
        params.error,
        new Date().toISOString(),
        id,
      );
  }

  /**
   * 接受合成：同一事务内 savePage 建 syntheses/ 页，并更新 wiki_syntheses.status=accepted。
   * 注意：savePage 自身也开事务——嵌套时依赖 SQLite 外层事务，此处手动内联插入避免双重事务冲突。
   */
  acceptSynthesis(params: {
    readonly synthesisId: string;
    readonly agentId: string;
    readonly userId: string;
    readonly path: string;
    readonly title: string;
    readonly contentMd: string;
  }): WikiPage {
    return withTransaction(this.db, () => {
      const existing = this.findSynthesisById(params.synthesisId);
      if (!existing || existing.status !== "candidate") {
        throw new Error(`接受失败：合成不存在或状态非 candidate: ${params.synthesisId}`);
      }
      const page = this.savePage({
        agentId: params.agentId,
        userId: params.userId,
        path: params.path,
        title: params.title,
        contentMd: params.contentMd,
        editor: "ai",
        sourceRef: `synthesis:${params.synthesisId}`,
      });
      this.db
        .prepare(
          `UPDATE wiki_syntheses
           SET status = 'accepted', page_id = ?, finished_at = ?
           WHERE id = ? AND status = 'candidate'`,
        )
        .run(page.id, new Date().toISOString(), params.synthesisId);
      return page;
    });
  }

  /**
   * 二期语义的接受：综述产物落成目录里的一份普通资料，而非 wiki_pages 摘要页。
   * 单事务内 createSource + 写主题两列 + 建索引 + 标 accepted；page_id 保持 NULL。
   */
  acceptSynthesisAsSource(params: {
    readonly synthesisId: string;
    readonly agentId: string;
    readonly userId: string;
    readonly title: string;
    readonly outputPath: string;
    readonly contentMd: string;
    readonly category: string;
    readonly subtopic: string;
  }): WikiSource {
    return withTransaction(this.db, () => {
      const existing = this.findSynthesisById(params.synthesisId);
      if (!existing || existing.status !== "candidate") {
        throw new Error(`接受失败：合成不存在或状态非 candidate: ${params.synthesisId}`);
      }
      const source = this.createSource({
        agentId: params.agentId,
        userId: params.userId,
        title: params.title,
        sourcePath: params.outputPath,
        mediaType: "document",
        mimeType: "text/markdown",
        contentMd: params.contentMd,
        extractedText: params.contentMd,
        originContext: `综述:${params.synthesisId}`,
      });
      this.updateSourceTopic(
        params.agentId,
        params.userId,
        source.id,
        params.category,
        params.subtopic,
      );
      this.indexSource(source.id);
      this.db
        .prepare(
          `UPDATE wiki_syntheses SET status = 'accepted', finished_at = ?
           WHERE id = ? AND status = 'candidate'`,
        )
        .run(new Date().toISOString(), params.synthesisId);
      const saved = this.findSourceById(source.id);
      if (!saved) throw new Error("接受失败：资料写入后读取不到");
      return saved;
    });
  }

  /** 拒绝合成：保留记录，status=rejected */
  rejectSynthesis(id: string): void {
    const info = this.db
      .prepare(
        `UPDATE wiki_syntheses SET status = 'rejected', finished_at = ?
         WHERE id = ? AND status = 'candidate'`,
      )
      .run(new Date().toISOString(), id);
    if (info.changes === 0) {
      throw new Error(`拒绝失败：合成不存在或状态非 candidate: ${id}`);
    }
  }

  /** 更新页面 status 列（供 P2 状态候选确认） */
  updatePageStatus(pageId: string, status: WikiPageStatus): void {
    const info = this.db.prepare("UPDATE wiki_pages SET status = ?, updated_at = ? WHERE id = ?").run(
      status,
      new Date().toISOString(),
      pageId,
    );
    if (info.changes === 0) {
      throw new Error(`页面不存在: ${pageId}`);
    }
  }
}

export interface WikiSearchHit {
  readonly page: WikiPage;
  readonly snippet: string;
}

export interface WikiSourceSearchHit {
  readonly source: WikiSource;
  readonly snippet: string;
}

interface WikiSynthesisRow {
  id: string;
  agent_id: string;
  user_id: string;
  page_id: string | null;
  source_page_ids: string;
  source_ids: string | null;
  title: string;
  output_path: string | null;
  candidate_md: string;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** 将 wiki_syntheses 行转为领域对象，JSON 数组字段容错解析 */
function synthesisRowToSynthesis(row: WikiSynthesisRow): WikiSynthesis {
  let sourcePageIds: string[] = [];
  try {
    const parsed = JSON.parse(row.source_page_ids) as unknown;
    if (Array.isArray(parsed)) {
      sourcePageIds = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    sourcePageIds = [];
  }
  let sourceIds: string[] | null = null;
  if (row.source_ids) {
    try {
      const parsed = JSON.parse(row.source_ids) as unknown;
      if (Array.isArray(parsed)) {
        sourceIds = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      sourceIds = null;
    }
  }
  return {
    id: row.id,
    agent_id: row.agent_id,
    user_id: row.user_id,
    page_id: row.page_id,
    source_page_ids: sourcePageIds,
    source_ids: sourceIds,
    title: row.title,
    output_path: row.output_path,
    candidate_md: row.candidate_md,
    status: row.status as WikiSynthesisStatus,
    error: row.error,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}
