/**
 * ToolBatchGroup — 工具批次分组
 * 把同一 agentic 轮次里连续的工具调用折叠成一行摘要（如「读取 2 个文件 · 搜索 3 次」），
 * 点开展开逐个 ToolCallCard 详情。流式中摘要行追加当前正在执行的工具动作。
 */

import React, { useState } from 'react'
import clsx from 'clsx'
import type { AgentWorkflowItem } from '../../../../hooks/business/useChat'
import { ToolCallCard, getStatusLabel } from '../ToolCallCard'
import { classifyToolFamily, type ToolFamily } from '../ToolCallCard/toolTaxonomy'
import styles from './ToolBatchGroup.module.css'

/** 家族固定展示顺序，避免因工具执行次序不同导致摘要文案跳动 */
const FAMILY_ORDER: ToolFamily[] = ['read', 'search', 'write', 'exec', 'agent', 'todo', 'image', 'other']

/** 家族 → 计数文案 */
const FAMILY_LABEL: Record<ToolFamily, (n: number) => string> = {
  read: (n) => `读取 ${n} 个文件`,
  search: (n) => `搜索 ${n} 次`,
  write: (n) => `编辑 ${n} 个文件`,
  exec: (n) => `执行 ${n} 条命令`,
  agent: (n) => `调用子 Agent ${n} 次`,
  todo: (n) => `更新任务 ${n} 次`,
  image: (n) => `生成图片 ${n} 张`,
  other: (n) => `调用 ${n} 次工具`,
}

/** 按家族计数，生成「读取 2 个文件 · 搜索 3 次」式摘要 */
function summarizeToolBatch(items: readonly AgentWorkflowItem[]): string {
  const counts = new Map<ToolFamily, number>()
  for (const item of items) {
    const family = classifyToolFamily(item.name)
    counts.set(family, (counts.get(family) ?? 0) + 1)
  }
  return FAMILY_ORDER.filter((f) => counts.has(f))
    .map((f) => FAMILY_LABEL[f](counts.get(f)!))
    .join(' · ')
}

export interface ToolBatchGroupProps {
  /** 组内工具项，已由 toWorkflowItem 转换为 AgentWorkflowItem */
  items: readonly AgentWorkflowItem[]
}

/** 渲染一批连续工具调用的折叠分组 */
const ToolBatchGroup: React.FC<ToolBatchGroupProps> = ({ items }) => {
  const [expanded, setExpanded] = useState(false)

  if (items.length === 0) return null

  const runningItems = items.filter((i) => i.status === 'running')
  const failedCount = items.filter((i) => i.status === 'failed').length
  const summaryText = summarizeToolBatch(items)

  // 摘要行右侧的「当前动作」：恰好 1 个 running 时展示其动作短句，多个时展示计数
  const currentActionText =
    runningItems.length === 1
      ? getStatusLabel(runningItems[0]!)
      : runningItems.length > 1
        ? `${runningItems.length} 个工具执行中`
        : ''

  return (
    <div className={clsx(styles.group, failedCount > 0 && styles['group--hasFailed'])}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={styles.icon}>{failedCount > 0 ? '✕' : '⋯'}</span>
        <span className={styles.summary}>{summaryText}</span>
        {currentActionText && <span className={styles.current}>{currentActionText}</span>}
        {failedCount > 0 && <span className={styles.failedBadge}>{failedCount} 失败</span>}
        <span className={styles.count}>{items.length}</span>
        <span className={styles.chevron}>{expanded ? '∧' : '∨'}</span>
      </button>
      {expanded && (
        <div className={styles.body}>
          {items.map((item) => (
            <ToolCallCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

export default ToolBatchGroup
export { ToolBatchGroup }
