/**
 * 工作台评论（P2 T8）的跨进程契约
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.7
 *
 * 评论是工作台草稿，不是消息 part：「带着评论继续」只把拼好的文本**预填**到输入框，
 * 发出去才属于对话。存储 `<ws>/.lumii/comments/<conversationId>.json`。
 */

export type CommentAnchor =
  | { type: 'text-range'; start: number; end: number; quote: string }
  | { type: 'slide'; index: number; quote: string }

export interface ArtifactComment {
  id: string
  /** 工作区相对路径 */
  path: string
  /** 针对哪一版（`turn:…` / `local:…`）；缺省=当前 */
  versionId?: string
  /** 没有锚点 = 针对整篇 */
  anchor?: CommentAnchor
  /** ≤500 字 */
  text: string
  createdAt: number
  sentAt?: number
  sentMessageId?: string
}

export interface SaveCommentInput {
  sessionKey: string
  path: string
  text: string
  versionId?: string
  anchor?: CommentAnchor
}

export interface CommentListResult {
  ok: true
  comments: ArtifactComment[]
}

export interface CommentComposeInput {
  sessionKey: string
  path: string
  /** 只拼这批评论；省略 = 该产物所有未发送评论 */
  ids?: readonly string[]
  versionLabel?: string
}

export interface CommentComposeResult {
  ok: true
  /** 预填到输入框的整段文本（不自动发送） */
  text: string
  ids: string[]
  count: number
  /** 超过 10 条 / 2000 字被截断 */
  truncated?: boolean
}

/** 单会话评论上限 */
export const MAX_COMMENTS_PER_SESSION = 200
/** 单文件大小上限 */
export const MAX_COMMENTS_FILE_BYTES = 512 * 1024
/** 单条评论字数上限 */
export const MAX_COMMENT_TEXT_CHARS = 500
/** 一次最多拼接的条数与总字数 */
export const MAX_PROMPT_COMMENTS = 10
export const MAX_PROMPT_CHARS = 2000
