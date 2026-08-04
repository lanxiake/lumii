/**
 * 最近对话轮次摘要器
 *
 * 从 ConversationRepo 读取最近 N 条消息，截断长度后传给 Router。
 */

import type { ConversationRepo } from "@mtbot/agent-runtime"
import type { TurnSummary } from "./types"

const MAX_CONTENT_CHARS = 200
const DEFAULT_TURN_LIMIT = 3

/**
 * 从 conversation 中提取最近 N 轮（user/assistant）摘要。
 * 失败时返回空数组（不阻断 Router）。
 */
export function summarizeRecentTurns(
  repo: ConversationRepo | null | undefined,
  conversationId: string | undefined,
  limit: number = DEFAULT_TURN_LIMIT,
): readonly TurnSummary[] {
  if (!repo || !conversationId) return []
  try {
    // ConversationRepo 按时间 ASC 返回，取较大窗口后切尾部最新 N 条
    const messages = repo.loadMessagesAsPiFormat(conversationId, { limit: Math.max(limit * 2, 10) })
    if (!messages.length) return []
    const tail = messages.slice(-limit)
    return tail
      .map((m): TurnSummary | undefined => {
        const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : undefined
        if (!role) return undefined
        const content = extractPlainText(m)
        if (!content) return undefined
        return {
          role,
          content: content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS - 1) + "…" : content,
        }
      })
      .filter((t): t is TurnSummary => Boolean(t))
  } catch {
    return []
  }
}

/** 从 pi-agent Message 中拼出纯文本（忽略 thinking / tool 等结构化块） */
function extractPlainText(message: unknown): string {
  const m = message as { content?: unknown }
  if (typeof m.content === "string") return m.content
  if (!Array.isArray(m.content)) return ""
  const parts: string[] = []
  for (const block of m.content as Array<{ type?: string; text?: unknown }>) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join(" ").trim()
}
