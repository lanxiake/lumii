/**
 * 上下文占用卡片 —— 悬浮在上下文指示器上方，显示占比与分类明细。
 */

import React from 'react'
import type { ContextUsage } from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import type { ContextUsageCategory } from '../../../../../shared/agent-runtime-events'
import { formatTokenCount } from '../../../../utils/format-token-count'
import styles from './ContextUsageCard.module.css'

/** 分类展示文案与色板（色板同时用于堆叠条与行内色块） */
const CATEGORY_META: Record<ContextUsageCategory, { label: string; color: string; hint: string }> = {
  systemPrompt: { label: '系统提示词', color: '#9ca3af', hint: '身份、语言与通用指令' },
  tools: { label: '工具定义', color: '#7c3aed', hint: '内置工具的名称、描述与参数 schema' },
  skills: { label: '技能', color: '#f59e0b', hint: '已启用技能的说明' },
  mcp: {
    label: 'MCP 与动态工具',
    color: '#ec4899',
    hint: '已连接 MCP 服务的工具定义（mcp__*）及系统提示中的 MCP 章节，不是对话内容；压缩不会删除它们',
  },
  subagents: { label: '子 Agent 定义', color: '#0ea5e9', hint: '多 Agent 协作相关定义' },
  memory: { label: '记忆与规则', color: '#22c55e', hint: '长期记忆与用户规则' },
  conversation: { label: '对话历史', color: '#f97316', hint: '当前会话消息；压缩只裁剪这一项' },
}

export interface ContextUsageCardProps {
  readonly contextUsage: ContextUsage | null | undefined
  readonly contextWindow: number
}

const ContextUsageCard: React.FC<ContextUsageCardProps> = ({ contextUsage, contextWindow }) => {
  const used = contextUsage?.usedTokens ?? 0
  const percent = contextWindow > 0 ? Math.round((used / contextWindow) * 100) : 0
  const breakdown = contextUsage?.breakdown ?? []
  const threshold = Math.round((contextUsage?.triggerThreshold ?? 0.8) * 100)

  return (
    <div className={styles.card} role="tooltip">
      <div className={styles.header}>
        <span className={styles.title}>上下文占用</span>
        <span className={styles.total}>
          ~{formatTokenCount(used)} / {contextWindow > 0 ? formatTokenCount(contextWindow) : '--'} Tokens
        </span>
      </div>

      <div className={styles['bar-row']}>
        <span className={styles.percent}>{percent}% 已用</span>
        <div
          className={styles.bar}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="上下文占用比例"
        >
          {breakdown.length > 0 && contextWindow > 0 ? (
            breakdown.map((entry) => (
              <span
                key={entry.category}
                className={styles['bar-segment']}
                style={{
                  width: `${(entry.tokens / contextWindow) * 100}%`,
                  background: CATEGORY_META[entry.category].color,
                }}
              />
            ))
          ) : (
            <span
              className={styles['bar-segment']}
              style={{ width: `${Math.min(100, percent)}%`, background: CATEGORY_META.conversation.color }}
            />
          )}
        </div>
      </div>

      {breakdown.length > 0 ? (
        <ul className={styles.list}>
          {breakdown.map((entry) => (
            <li
              key={entry.category}
              className={styles.item}
              title={CATEGORY_META[entry.category].hint}
            >
              <span
                className={styles.swatch}
                style={{ background: CATEGORY_META[entry.category].color }}
                aria-hidden
              />
              <span className={styles.label}>{CATEGORY_META[entry.category].label}</span>
              <span className={styles.tokens}>{formatTokenCount(entry.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className={styles.empty}>发送一条消息后可查看分类明细</div>
      )}

      <div className={styles.footer}>
        超过 {threshold}% 自动压缩对话历史 · 点击可立即压缩
      </div>
    </div>
  )
}

export default ContextUsageCard
export { ContextUsageCard }
