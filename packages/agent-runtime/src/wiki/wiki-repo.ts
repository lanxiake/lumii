/**
 * WikiRepo — Wiki 知识库的收件箱 / 资料 / 页面 / 修订 / 运行日志读写与检索
 *
 * 直接持有 DatabaseAdapter，不建 service/factory 分层（同 AgentMemoryRepo 范式）。
 */

import type { DatabaseAdapter } from "../storage/local-database.js";
import { withTransaction } from "../storage/local-database.js";
import { tokenizeBigram } from "../memory/segmentation.js";
import { WikiIndexRepo } from "./wiki-index.js";
import {
  generateWikiId,
  validateWikiPath,
  type WikiCategory,
  type WikiInboxItem,
  type WikiInboxItemType,
  type WikiInboxStatus,
  type WikiMediaType,
  type WikiOrganizeRun,
  type WikiOrganizeRunStatus,
  type WikiPage,
  type WikiPageRevision,
  type WikiRevisionEditor,
  type WikiSource,
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
}

function pageRowToPage(row: WikiPageRow): WikiPage {
  return { ...row, category: row.category as WikiCategory };
}

interface WikiRunRow {
  id: string;
  agent_id: string;
  user_id: string;
  inbox_ids: string;
  status: string;
  result_summary: string | null;
  error: string | null;
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
          media_type, extracted_text, media_meta, preview_path, origin_context, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    };
  }

  findSourceById(id: string): WikiSource | null {
    const row = this.db.prepare<WikiSource>("SELECT * FROM wiki_sources WHERE id = ?").get(id);
    return row ?? null;
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
        };
        rowid = this.db.prepare<{ rowid: number }>("SELECT rowid FROM wiki_pages WHERE id = ?").get(id)!.rowid;
        this.insertRevision(id, 1, params.title, params.path, params.contentMd, params.editor, params.sourceRef, now);
      }

      this.indexRepo.upsertRow(rowid, page.title, page.content_md);
      return page;
    });
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

  deletePage(id: string): void {
    const row = this.db.prepare<{ rowid: number }>("SELECT rowid FROM wiki_pages WHERE id = ?").get(id);
    this.db.prepare("DELETE FROM wiki_pages WHERE id = ?").run(id);
    if (row) this.indexRepo.deleteRow(row.rowid);
  }

  /** 命中即更新 last_used / use_count（检索命中与读取时调用） */
  touchPage(id: string): void {
    this.db
      .prepare("UPDATE wiki_pages SET last_used = ?, use_count = use_count + 1 WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  // ── 检索 ────────────────────────────────────────────────

  /**
   * FTS5 + BM25 检索——同 memory-repo.search 范式：查询词按 tokenizeBigram 切分，
   * 拼成 OR 短语查询并逐 bigram 转义引号，避免用户输入被解释为 FTS5 查询语法。
   * 归档资料对应页面（archived_at 非空的来源）P0 不特殊处理，P1 提供 UI 开关。
   * 命中后更新 last_used / use_count。
   */
  search(agentId: string, userId: string, keyword: string, limit = 10): readonly WikiSearchHit[] {
    const tokens = [...tokenizeBigram(keyword)];
    if (tokens.length === 0) return [];
    const query = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const rows = this.db
        .prepare<WikiPageRow>(
          `SELECT p.*
           FROM wiki_pages_fts
           JOIN wiki_pages p ON p.rowid = wiki_pages_fts.rowid
           WHERE wiki_pages_fts MATCH ? AND p.agent_id = ? AND p.user_id = ?
           ORDER BY bm25(wiki_pages_fts)
           LIMIT ?`,
        )
        .all(query, agentId, userId, limit);
      for (const row of rows) this.touchPage(row.id);
      return rows.map((row) => ({
        page: pageRowToPage(row),
        snippet: row.content_md.slice(0, 200),
      }));
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
      created_at: now,
      finished_at: null,
    };
  }

  finishRun(id: string, status: WikiOrganizeRunStatus, resultSummary?: string, error?: string): void {
    this.db
      .prepare(
        "UPDATE wiki_organize_runs SET status = ?, result_summary = ?, error = ?, finished_at = ? WHERE id = ?",
      )
      .run(status, resultSummary ?? null, error ?? null, new Date().toISOString(), id);
  }

  listRuns(agentId: string, userId: string, limit = 50): readonly WikiOrganizeRun[] {
    const rows = this.db
      .prepare<WikiRunRow>(
        "SELECT * FROM wiki_organize_runs WHERE agent_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(agentId, userId, limit);
    return rows.map(runRowToRun);
  }

  /** 重建 FTS5 派生索引，返回重建后的行数 */
  rebuildIndex(): number {
    return this.indexRepo.rebuildFts();
  }
}

export interface WikiSearchHit {
  readonly page: WikiPage;
  readonly snippet: string;
}
