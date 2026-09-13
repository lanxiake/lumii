/**
 * 分组清空历史：执行计划计算（纯函数，便于单测）。
 */
import type { ChatSession } from '../../hooks/business/useChat'

/** 分组清空历史的请求：keepRecent=5 保留最近 5 条，null 清空全部 */
export interface ClearGroupHistoryRequest {
  label: string
  sessions: ChatSession[]
  keepRecent: number | null
}

export interface ClearGroupPlan {
  /** 置顶会话数（豁免） */
  pinned: number
  /** 运行中会话数（跳过） */
  streaming: number
  /** 实际将删除的会话（按更新时间倒序） */
  toDelete: ChatSession[]
}

/**
 * 计算分组清空的执行计划：置顶豁免、运行中跳过、自主进化会话不可删（主进程守卫）。
 * keepRecent=5 时保留最近的 5 条可删会话（按更新时间倒序）。
 */
export function computeClearGroupPlan(request: ClearGroupHistoryRequest): ClearGroupPlan {
  const pinned = request.sessions.filter((s) => s.isPinned).length
  const streaming = request.sessions.filter((s) => !s.isPinned && s.isStreaming).length
  const deletable = request.sessions
    .filter((s) => !s.isPinned && !s.isStreaming && s.channel !== 'evolution')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const toDelete = request.keepRecent == null ? deletable : deletable.slice(request.keepRecent)
  return { pinned, streaming, toDelete }
}
