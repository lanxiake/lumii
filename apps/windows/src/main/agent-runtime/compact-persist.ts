/**
 * 手动压缩摘要的落库形态。
 *
 * DB 的 assistant `{ type: 'text' }` 在 messageRowToAgentMessages 中会被丢弃，
 * 必须写成 assistant_parts，后续 restoreHistory / prompt 才能注入摘要。
 */

import type { AssistantPartsContent } from '@mtbot/agent-runtime'
import { COMPACT_SUMMARY_PREFIX } from '../../shared/compact-summary-text'

/**
 * 将 LLM 摘要转为可被 loadMessagesAsPiFormat 投影的 assistant_parts。
 */
export function buildPersistedCompactSummary(summaryText: string): AssistantPartsContent {
  return {
    type: 'assistant_parts',
    parts: [
      {
        type: 'text',
        id: 'compact-summary',
        text: `${COMPACT_SUMMARY_PREFIX}\n${summaryText}`,
        status: 'done',
      },
    ],
  }
}

/**
 * 摘要应插在保留段之前，时间戳取首条保留消息之前 1ms；无保留段时用当前时间。
 */
export function resolveCompactSummaryTimestamp(firstKeptTimestamp: string | undefined): string {
  if (!firstKeptTimestamp) return new Date().toISOString()
  const ms = Date.parse(firstKeptTimestamp)
  if (Number.isNaN(ms)) return new Date().toISOString()
  return new Date(ms - 1).toISOString()
}
