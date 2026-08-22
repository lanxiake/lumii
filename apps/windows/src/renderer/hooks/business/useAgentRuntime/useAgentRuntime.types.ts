/**
 * useAgentRuntime 内部类型：主进程 conversation:messages 返回的历史消息结构。
 */

/** 首屏与每次上滑加载的历史条数（与主进程 CONVERSATION_PAGE_SIZE 一致） */
export const HISTORY_PAGE_SIZE = 60

/** 主进程 conversation:messages 返回的单条历史消息 */
export interface DbMessage {
  id: string
  role: 'user' | 'assistant'
  content: readonly { type: 'text'; text: string }[]
  timestamp: number
  isStreaming?: boolean
  /** 已被上下文压缩移出 LLM 请求，仍保留在历史中 */
  contextExcluded?: boolean
  isVoice?: boolean
  audioWavBase64?: string
  contentJson?: string
  toolCalls?: readonly {
    id: string
    name: string
    args: Record<string, unknown>
    result?: unknown
    isError?: boolean
    textPositionAtStart?: number
  }[]
  sourceAgent?: { instanceId: string; label: string }
}

/** conversation:messages 的分页响应 */
export interface DbMessagePage {
  items: readonly DbMessage[]
  hasMore: boolean
  /** 本页最早一条消息的原始游标，直接回传即可取更早的一页 */
  nextCursor?: { timestamp: string; id: string }
}
