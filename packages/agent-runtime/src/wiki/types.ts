/**
 * Wiki 知识库类型定义
 *
 * 设计：`docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md`
 */

/** 固定顶层分类，AI 落点被约束在此集合内（P0 仅 sources/media/inbox 可自动写） */
export type WikiCategory = "sources" | "media" | "inbox" | "concepts" | "entities" | "syntheses";

/** P0 允许 AI 自动写入的顶层分类 */
export const AI_WRITABLE_CATEGORIES: ReadonlySet<WikiCategory> = new Set(["sources", "media", "inbox"]);

export type WikiMediaType = "document" | "image" | "audio" | "video";

export type WikiInboxItemType = "upload" | "output" | "search" | "chat";

export type WikiInboxStatus = "pending" | "organized" | "discarded";

export interface WikiInboxItem {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly item_type: WikiInboxItemType;
  readonly source_path: string | null;
  readonly source_url: string | null;
  readonly title: string;
  readonly content_preview: string | null;
  readonly media_type: WikiMediaType;
  readonly status: WikiInboxStatus;
  readonly attempt_count: number;
  readonly last_error: string | null;
  /** degraded = AI 拿不准留待人工整理，failed = 落库或调用真的出错 */
  readonly last_outcome: string | null;
  readonly organized_source_id: string | null;
  readonly content_hash: string | null;
  readonly created_at: string;
  readonly organized_at: string | null;
}

export interface WikiSource {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly title: string;
  readonly source_path: string | null;
  readonly content_md: string | null;
  readonly content_hash: string | null;
  readonly mime_type: string | null;
  readonly media_type: WikiMediaType;
  readonly extracted_text: string | null;
  readonly media_meta: string | null;
  readonly preview_path: string | null;
  readonly origin_context: string | null;
  readonly archived_at: string | null;
  readonly created_at: string;
  readonly topic_category: string | null;
  readonly topic_subtopic: string | null;
  readonly last_used: string | null;
  readonly use_count: number;
}

export interface WikiAttachment {
  readonly id: string;
  readonly page_id: string;
  readonly source_id: string | null;
  readonly file_path: string;
  readonly media_type: WikiMediaType;
  readonly display_name: string;
  readonly created_at: string;
}

/** 页面状态：P1 只落 active，outdated/doubtful/archived 由 P2 UI 启用 */
export type WikiPageStatus = "active" | "outdated" | "doubtful" | "archived";

/** 综述合成运行状态：候选审阅 → 接受建页 / 拒绝保留 */
export type WikiSynthesisStatus = "candidate" | "accepted" | "rejected";

/** 综述合成运行记录（wiki_syntheses） */
export interface WikiSynthesis {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly page_id: string | null;
  readonly source_page_ids: readonly string[];
  readonly source_ids: readonly string[] | null;
  readonly title: string;
  readonly output_path: string | null;
  readonly candidate_md: string;
  readonly status: WikiSynthesisStatus;
  readonly error: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

export interface WikiPage {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly path: string;
  readonly category: WikiCategory;
  readonly title: string;
  readonly content_md: string;
  readonly version: number;
  readonly last_used: string | null;
  readonly use_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: WikiPageStatus;
}

export interface WikiLink {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly source_page_id: string;
  readonly target_page_id: string | null;
  readonly anchor_text: string;
  readonly is_resolved: boolean;
  readonly created_at: string;
}

/** 反链条目：源页标题/路径 + 链接原文 + 解析状态，供 UI 展示 */
export interface WikiBacklink {
  readonly linkId: string;
  readonly sourcePageId: string;
  readonly sourceTitle: string;
  readonly sourcePath: string;
  readonly anchorText: string;
  readonly isResolved: boolean;
}

export type WikiRevisionEditor = "user" | "ai";

export interface WikiPageRevision {
  readonly id: string;
  readonly page_id: string;
  readonly version: number;
  readonly title: string;
  readonly path: string;
  readonly content_md: string;
  readonly editor: WikiRevisionEditor;
  readonly source_ref: string | null;
  readonly created_at: string;
}

/**
 * 归档运行终态：
 * - succeeded：全部按模型分类落到目标分类
 * - degraded：全部已归档但部分/全部落点降级为兜底 inbox/（资料没丢，需用户手动归档）
 * - partial：部分条目落库失败，仍 pending 等退避重试
 * - failed：整批分类失败，条目全部保持 pending
 */
export type WikiOrganizeRunStatus = "running" | "succeeded" | "degraded" | "partial" | "failed";

/** 单条归档运行明细的终态 */
export type WikiOrganizeRunDetailOutcome = "archived" | "corrected" | "degraded" | "failed";

/** 正文来源：原有预览 / 本次提取 / 无正文 */
export type WikiOrganizeRunDetailExtract = "preview" | "extracted" | "none";

/** 归档运行逐条明细（序列化进 result_detail JSON） */
export interface WikiOrganizeRunDetailItem {
  readonly inboxId: string;
  readonly title: string;
  readonly path: string;
  readonly mediaType: WikiMediaType;
  readonly outcome: WikiOrganizeRunDetailOutcome;
  readonly reason?: string;
  readonly extract: WikiOrganizeRunDetailExtract;
}

export interface WikiOrganizeRun {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly inbox_ids: readonly string[];
  readonly status: WikiOrganizeRunStatus;
  readonly result_summary: string | null;
  readonly error: string | null;
  readonly result_detail: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
}

/** 生成短随机 ID（同 memory 模块范式） */
export function generateWikiId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 校验路径是否落在允许的顶层分类内，且不含空段、`..`、绝对路径、分隔符逃逸。
 * 校验失败时调用方应降级到 inbox/。
 */
export function validateWikiPath(pathStr: string): { readonly valid: boolean; readonly category: WikiCategory | null } {
  if (!pathStr || pathStr.startsWith("/") || pathStr.includes("\\")) {
    return { valid: false, category: null };
  }
  const segments = pathStr.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return { valid: false, category: null };
  }
  const top = segments[0];
  const categories: readonly WikiCategory[] = [
    "sources",
    "media",
    "inbox",
    "concepts",
    "entities",
    "syntheses",
  ];
  if (!categories.includes(top as WikiCategory)) {
    return { valid: false, category: null };
  }
  return { valid: true, category: top as WikiCategory };
}
