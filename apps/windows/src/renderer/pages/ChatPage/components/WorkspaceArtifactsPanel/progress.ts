/**
 * 进行中回合的进度（阶段 + 已完成/总数 + 起始时间）。
 *
 * **数据源必须是 `parts`**：`agent:tool:start` 只把运行中的工具写进 parts 与
 * `currentTool`，`message.toolCalls` 要等整条消息落定才补齐——读 toolCalls 会
 * 在工具真正运行的那段时间里恰好什么都看不到（实测：只显示「执行中」）。
 */

export interface ProgressPart {
  type: string
  name?: string
  status?: string
}

export interface ProgressMessageLike {
  role: string
  isStreaming: boolean
  timestamp: number
  parts: readonly ProgressPart[]
}

export interface TurnProgress {
  toolName?: string
  done: number
  total: number
  startedAt: number
}

export function buildTurnProgress(
  messages: readonly ProgressMessageLike[],
): TurnProgress | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const toolParts = message.parts.filter((part) => part.type === 'tool')
    const running = [...toolParts].reverse().find((part) => part.status === 'running')
    if (!running && !message.isStreaming) continue
    return {
      ...(running?.name ? { toolName: running.name } : {}),
      done: toolParts.filter(
        (part) =>
          part.status === 'done' || part.status === 'error' || part.status === 'interrupted',
      ).length,
      total: toolParts.length,
      startedAt: message.timestamp,
    }
  }
  return null
}
