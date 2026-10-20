/**
 * 解析 task_complete 工具 part：完成摘要对用户可见，验证门提示不当成「已完成」。
 */

export type TaskCompletePhase = 'running' | 'completed' | 'gate' | 'failed'

export interface ParsedTaskComplete {
  phase: TaskCompletePhase
  /** 完成摘要（优先结果 JSON，其次工具参数） */
  summary?: string
  /** 验证门 / 失败时的说明文案 */
  message?: string
}

interface TaskCompleteToolPart {
  args?: Record<string, unknown>
  result?: unknown
  status?: string
  isError?: boolean
}

/**
 * 从工具结果 content[].text 解析 JSON（与 pet extractTaskCompletion 同源判据）
 */
function parseResultJson(result: unknown): { status?: string; summary?: string; rawText?: string } {
  try {
    let text: string | undefined
    if (typeof result === 'string') {
      text = result
    } else if (result && typeof result === 'object') {
      const content = (result as { content?: unknown }).content
      if (Array.isArray(content)) {
        const first = content.find(
          (c): c is { type?: string; text?: string } =>
            !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string',
        )
        if (first?.text) text = first.text
      }
    }
    if (!text) return {}
    try {
      const parsed = JSON.parse(text) as { status?: unknown; summary?: unknown }
      return {
        ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}),
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary.trim() } : {}),
        rawText: text,
      }
    } catch {
      return { rawText: text }
    }
  } catch {
    return {}
  }
}

/**
 * 解析 task_complete 卡片状态。
 * 只有 `status === 'completed'` 才算真正完成（验证门那次 isError=false 但不是完成）。
 */
export function parseTaskCompletePart(part: TaskCompleteToolPart): ParsedTaskComplete {
  const argSummary =
    typeof part.args?.summary === 'string' ? part.args.summary.trim() : ''

  if (part.status === 'running' || part.result === undefined) {
    return {
      phase: 'running',
      ...(argSummary ? { summary: argSummary } : {}),
    }
  }

  if (part.isError) {
    const parsed = parseResultJson(part.result)
    return {
      phase: 'failed',
      message: parsed.rawText?.trim() || '任务完成信号失败',
      ...(argSummary ? { summary: argSummary } : {}),
    }
  }

  const parsed = parseResultJson(part.result)
  if (parsed.status === 'completed') {
    const summary = (parsed.summary || argSummary || '').trim()
    return {
      phase: 'completed',
      ...(summary ? { summary } : {}),
    }
  }

  // 验证门等：返回提示文案，要求再次调用
  const tip = parsed.rawText?.trim()
  return {
    phase: 'gate',
    message: tip || '尚需确认后才能标记完成',
    ...(argSummary ? { summary: argSummary } : {}),
  }
}
