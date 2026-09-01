/**
 * WikiRepo — Wiki 知识库的收件箱 / 资料 / 运行日志读写与检索
 *
 * 直接持有 DatabaseAdapter，不建 service/factory 分层（同 AgentMemoryRepo 范式）。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import { tokenizeBigram } from "../memory/segmentation.js";
import { WikiIndexRepo } from "./wiki-index.js";
import {
  DEFAULT_TOPIC_TREE,
  LEGACY_TOPIC_TREE_V1,
  PARKING_CATEGORY,
  TOPIC_CATEGORIES_META_KEY,
  parseTopicTree,
  topicTreeHasLegacyV1Categories,
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
  type WikiInboxItem,
  type WikiInboxItemType,
  type WikiInboxStatus,
  type WikiMediaType,
  type WikiOrganizeRun,
  type WikiOrganizeRunStatus,
  type WikiSource,
  type WikiStorageMode,
  type SummaryLevel,
  type WikiTopicMigrationRule,
  type WikiTopicTreeMigrationReport,
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
      legacy_subtopic: null,
      title_locked: 0,
      summary: null,
      summary_hash: null,
      summary_level: null,
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

  /**
   * 读取已存主题树；没有合法 JSON 时写入 v2 默认树。
   * 不自动升版本——给 migrateTopicTreeToV2 用，避免「读即迁」后再统计变成 alreadyMigrated。
   */
  private readTopicTreeOrDefault(): WikiTopicTree {
    const raw = this.getIndexMeta(TOPIC_CATEGORIES_META_KEY);
    const parsed = parseTopicTree(raw);
    if (parsed) return parsed;
    this.setIndexMeta(TOPIC_CATEGORIES_META_KEY, JSON.stringify(DEFAULT_TOPIC_TREE));
    return DEFAULT_TOPIC_TREE;
  }

  /**
   * 读取主题树；不存在时写入默认树。
   * 仍含 v1 旧六大类名时当场迁到 v2，打开 Wiki 就不会继续显示做事记录/学习资料等。
   */
  getOrCreateTopicTree(): WikiTopicTree {
    const current = this.readTopicTreeOrDefault();
    if (topicTreeHasLegacyV1Categories(current)) {
      this.migrateTopicTreeToV2();
      return this.readTopicTreeOrDefault();
    }
    return current;
  }

  /**
   * 一次性把主题树 JSON 从 v1（六大类）迁到 v2（4 大类），并保留用户自建大类。
   *
   * 与 V26 SQL 迁移的分工：SQL 只改 `wiki_sources` 的两列（大类机械改写、小类置空），
   * 这里只换 meta 里的树定义。两者都靠「幂等 + 防重跑」保证多次调用安全：
   * 已是 v2 直接返回 `alreadyMigrated`，不覆盖用户在 v2 下的任何编辑。
   *
   * 用户自建大类（不在旧六大类里的）整体追加到 v2 树末尾——它们的小类是用户自己定的，
   * 无从机械映射，只能原样保留，否则 setTopicTree 的禁孤儿校验会因为占用节点消失而拒绝写入。
   */
  migrateTopicTreeToV2(): WikiTopicTreeMigrationReport {
    const startedAt = Date.now();
    const current = this.readTopicTreeOrDefault();
    if (!topicTreeHasLegacyV1Categories(current)) {
      return {
        alreadyMigrated: true,
        categoryRules: [],
        inboxCount: 0,
        legacySubtopicTop: [],
        userCategories: [],
        elapsedMs: Date.now() - startedAt,
      };
    }

    const legacyNames = new Set(LEGACY_TOPIC_TREE_V1.categories.map((c) => c.name));
    const defaultNames = new Set(DEFAULT_TOPIC_TREE.categories.map((c) => c.name));
    const userCategories = current.categories.filter(
      (c) => !legacyNames.has(c.name) && !defaultNames.has(c.name),
    );
    const nextTree: WikiTopicTree = {
      version: 2,
      categories: [...DEFAULT_TOPIC_TREE.categories, ...userCategories],
    };

    // 直接写 meta：不能走 setTopicTree。V26 SQL 已把小类整体置空，
    // 但旧大类名仍在（SQL 与本函数的执行先后不保证），禁孤儿校验会误判。
    this.setIndexMeta(TOPIC_CATEGORIES_META_KEY, JSON.stringify(nextTree));

    return {
      alreadyMigrated: false,
      categoryRules: this.countV26CategoryRules(),
      inboxCount:
        this.db
          .prepare<{ n: number }>(
            "SELECT COUNT(*) AS n FROM wiki_sources WHERE topic_category IS NULL AND legacy_subtopic IS NOT NULL",
          )
          .get()?.n ?? 0,
      legacySubtopicTop: this.db
        .prepare<{ legacy_subtopic: string; n: number }>(
          `SELECT legacy_subtopic, COUNT(*) AS n FROM wiki_sources
           WHERE legacy_subtopic IS NOT NULL
           GROUP BY legacy_subtopic ORDER BY n DESC, legacy_subtopic ASC LIMIT 20`,
        )
        .all()
        .map((r) => ({ subtopic: r.legacy_subtopic, count: r.n })),
      userCategories: userCategories.map((c) => c.name),
      elapsedMs: Date.now() - startedAt,
    };
  }

  /** 统计 V26 六条大类改写规则各命中多少条（迁移后按新大类名反查） */
  private countV26CategoryRules(): readonly WikiTopicMigrationRule[] {
    const rules: ReadonlyArray<{ from: string; to: string | null }> = [
      { from: "做事记录", to: "工作" },
      { from: "学习资料", to: "学习" },
      { from: "证件凭据", to: "生活" },
      { from: "模板参考", to: "收藏" },
      { from: "随笔创作", to: "生活" },
      { from: "计划与复盘", to: null },
    ];
    const legacySubtopicsOf = (name: string): readonly string[] =>
      LEGACY_TOPIC_TREE_V1.categories.find((c) => c.name === name)?.subtopics ?? [];

    return rules.map((rule) => {
      // 迁移已把 topic_category 改写掉，只能靠 legacy_subtopic 反推来源大类。
      // 「整合长文」在六个大类下都有，无法归属到某一条规则，这里排除，避免重复计数。
      const subtopics = legacySubtopicsOf(rule.from).filter((s) => s !== "整合长文");
      if (subtopics.length === 0) return { from: rule.from, to: rule.to, count: 0 };
      const placeholders = subtopics.map(() => "?").join(",");
      const sql =
        rule.to === null
          ? `SELECT COUNT(*) AS n FROM wiki_sources
             WHERE topic_category IS NULL AND legacy_subtopic IN (${placeholders})`
          : `SELECT COUNT(*) AS n FROM wiki_sources
             WHERE topic_category = ? AND legacy_subtopic IN (${placeholders})`;
      const params = rule.to === null ? subtopics : [rule.to, ...subtopics];
      const count = this.db.prepare<{ n: number }>(sql).get(...params)?.n ?? 0;
      return { from: rule.from, to: rule.to, count };
    });
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
      /** 与 category 同用：只要该大类下「未细分」（小类为空）的资料 */
      readonly subtopicUnfiled?: boolean;
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
    } else if (filter.category && filter.subtopicUnfiled) {
      // 「大类下未细分」分组：小类可选带来的新视图（设计 §2.1.1）
      conditions.push("topic_category = ?", "topic_subtopic IS NULL");
      params.push(filter.category);
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
   * 持久化摘要三列。contentHash 存生成时的 content_hash 快照，供后续失效判据
   * （summary_hash !== content_hash → 重算）。只写这三列，绝不动正文列。
   */
  updateSourceSummary(sourceId: string, summary: string, contentHash: string, level: SummaryLevel): void {
    this.db
      .prepare(
        "UPDATE wiki_sources SET summary = ?, summary_hash = ?, summary_level = ? WHERE id = ?",
      )
      .run(summary, contentHash, level, sourceId);
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
   * 重编目扫描集：v1.1 起 `scope='all'` 纳入收件箱（未分类，topic_category IS NULL），
   * 与「整理收件箱」合并为同一能力（设计 §5.9 D5）。始终排除已归档与临时存放。
   */
  listSourcesForReclassify(
    agentId: string,
    userId: string,
    scope:
      | { readonly kind: "source"; readonly sourceId: string }
      | { readonly kind: "subtopic"; readonly category: string; readonly subtopic: string | null }
      | { readonly kind: "all" },
  ): readonly WikiSource[] {
    const conditions = [
      "agent_id = ?",
      "user_id = ?",
      "archived_at IS NULL",
      "(topic_category IS NULL OR topic_category <> ?)",
    ];
    const params: unknown[] = [agentId, userId, PARKING_CATEGORY];
    if (scope.kind === "source") {
      conditions.push("id = ?");
      params.push(scope.sourceId);
    } else if (scope.kind === "subtopic") {
      conditions.push("topic_category = ?");
      params.push(scope.category);
      if (scope.subtopic === null) {
        conditions.push("topic_subtopic IS NULL");
      } else {
        conditions.push("topic_subtopic = ?");
        params.push(scope.subtopic);
      }
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
   * 用户手动改名后置 title_locked=1：AI 编目改名提案（P6）必须丢弃 locked 资料的 renameTitle。
   */
  renameSource(agentId: string, userId: string, sourceId: string, title: string): WikiSource {
    const info = this.db
      .prepare("UPDATE wiki_sources SET title = ?, title_locked = 1 WHERE id = ? AND agent_id = ? AND user_id = ?")
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

  /** 物理删除资料条目，同时清掉资料层 FTS 索引行 */
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

  // ── 检索 ────────────────────────────────────────────────

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

  /** 重建资料层 FTS5 派生索引，返回重建行数 */
  rebuildIndex(): number {
    return this.indexRepo.rebuildSourceFts();
  }

  /**
   * 资料层 FTS 索引是否与主表一致。
   * bigram 分词要 JS 做，SQL migration 建完虚表是空的，老库升级后搜索会静默零命中，
   * 宿主启动时据此决定要不要跑一次 rebuildIndex()。
   */
  checkIndexHealth(): { readonly isHealthy: boolean; readonly reason?: string } {
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
}

export interface WikiSourceSearchHit {
  readonly source: WikiSource;
  readonly snippet: string;
}

