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

  markInboxAttemptFailed(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE wiki_inbox SET attempt_count = attempt_count + 1, last_error = ? WHERE id = ?",
      )
      .run(error, id);
  }

  markInboxOrganized(id: string, organizedSourceId: string): void {
    this.db
      .prepare(
        "UPDATE wiki_inbox SET status = 'organized', organized_source_id = ?, organized_at = ? WHERE id = ?",
      )
      .run(organizedSourceId, new Date().toISOString(), id);
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
      .prepare("UPDATE wiki_inbox SET attempt_count = 0, last_error = NULL WHERE id = ? AND status = 'pending'")
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
  }): WikiSource {
    const id = generateWikiId();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wiki_sources
         (id, agent_id, user_id, title, source_path, content_md, content_hash, mime_type,
          media_type, extracted_text, media_meta, preview_path, origin_context, created_at,
          topic_category, topic_subtopic, last_used, use_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    };
  }

  findSourceById(id: string): WikiSource | null {
    const row = this.db.prepare<WikiSource>("SELECT * FROM wiki_sources WHERE id = ?").get(id);
    return row ?? null;
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
   * 按用途过滤资料列表。`parking` 与 `unfiled` 互斥，不应同时传 true。
   * 排除已归档（archived_at 非空）的资料。
   */
  listSourcesByTopic(
    agentId: string,
    userId: string,
    filter: {
      readonly category?: string;
      readonly subtopic?: string;
      readonly parking?: boolean;
      readonly unfiled?: boolean;
      readonly mediaType?: WikiMediaType;
    },
  ): readonly WikiSource[] {
    const conditions = ["agent_id = ?", "user_id = ?", "archived_at IS NULL"];
    const params: unknown[] = [agentId, userId];

    if (filter.parking) {
      conditions.push("topic_category = ?", "topic_subtopic IS NULL");
      params.push(PARKING_CATEGORY);
    } else if (filter.unfiled) {
      conditions.push("topic_category IS NULL", "topic_subtopic IS NULL");
    } else if (filter.category && filter.subtopic) {
      conditions.push("topic_category = ?", "topic_subtopic = ?");
      params.push(filter.category, filter.subtopic);
    } else if (filter.category) {
      conditions.push("topic_category = ?", "topic_subtopic IS NOT NULL");
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

  /** 更新某条资料的用途归属；写前用 allowParking 校验，越权归属会抛错 */
  updateSourceTopic(sourceId: string, category: string, subtopic: string | null): WikiSource {
    const tree = this.getOrCreateTopicTree();
    const result = validateTopicAssignment(tree, category, subtopic, { allowParking: true });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    this.db
      .prepare("UPDATE wiki_sources SET topic_category = ?, topic_subtopic = ? WHERE id = ?")
      .run(category, subtopic, sourceId);
    const source = this.findSourceById(sourceId);
    if (!source) throw new Error(`资料不存在: ${sourceId}`);
    return source;
  }

  /** 命中即更新 last_used / use_count（打开原文件、检索命中时调用） */
  touchSource(sourceId: string): void {
    this.db
      .prepare("UPDATE wiki_sources SET last_used = ?, use_count = use_count + 1 WHERE id = ?")
      .run(new Date().toISOString(), sourceId);
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

  sourceHasUsedPage(agentId: string, userId: string, sourceId: string): boolean {
    const row = this.db
      .prepare<{ last_used: string | null; use_count: number }>(
        `SELECT p.last_used, p.use_count FROM wiki_pages p
         JOIN wiki_page_revisions r ON r.page_id = p.id
         WHERE p.agent_id = ? AND p.user_id = ? AND r.source_ref = ?
         LIMIT 1`,
      )
      .get(agentId, userId, sourceId);
    if (!row) return false;
    return row.last_used !== null || row.use_count > 0;
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
    const info = this.db
      .prepare(`DELETE FROM wiki_sources WHERE agent_id = ? AND user_id = ? AND id IN (${placeholders})`)
      .run(agentId, userId, ...sourceIds);
    return info.changes;
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
