/**
 * RecentFocus - 近期关注（原型「近期关注」面板）
 *
 * 数据是 `agent:memories:list` 返回的真实记忆条目，按记忆自带的 category 分段。
 * 原型的「事务/计划/任务」是示意分类，运行时并不存在——这里用真实分类
 * （项目/偏好/约定），避免做出「AI 归纳过」的假象。
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { useMemoryUsage, type MemoryListItem } from '../../../../hooks/business/useMemoryUsage'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
import clsx from 'clsx'
import styles from './RecentFocus.module.css'

/** 面板分段 → 记忆 category（与 packages/agent-runtime MemoryCategory 对齐） */
const TABS: ReadonlyArray<{ id: string; label: string; categories: readonly string[] }> = [
  { id: 'project', label: '项目', categories: ['project'] },
  { id: 'user', label: '偏好', categories: ['user'] },
  { id: 'feedback', label: '约定', categories: ['feedback'] },
]

const MAX_ITEMS = 5

function formatWhen(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export interface RecentFocusProps {
  onViewChange?: (view: ViewType) => void
}

export const RecentFocus: React.FC<RecentFocusProps> = ({ onViewChange }) => {
  const { listMemories, loading } = useMemoryUsage()
  const [memories, setMemories] = useState<readonly MemoryListItem[]>([])
  const [activeTab, setActiveTab] = useState(TABS[0].id)
  const [loadedAt, setLoadedAt] = useState<number>()

  useEffect(() => {
    let alive = true
    void listMemories().then((rows) => {
      if (!alive) return
      setMemories(rows)
      setLoadedAt(Date.now())
    })
    return () => {
      alive = false
    }
  }, [listMemories])

  const items = useMemo(() => {
    const tab = TABS.find((t) => t.id === activeTab)
    if (!tab) return []
    return memories
      .filter((m) => tab.categories.includes(m.category))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ITEMS)
  }, [memories, activeTab])

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <span className={styles.title}>近期关注</span>
        <span className={styles.tag}>来自记忆</span>
        <div className={styles.seg} role="tablist" aria-label="记忆分类">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={clsx(styles['seg-btn'], activeTab === t.id && styles['seg-btn--on'])}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading && memories.length === 0 ? (
        <div className={styles.empty}>正在读取记忆…</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          这一类还没有记忆条目。多聊几轮，Lumii 会自己记下要点。
        </div>
      ) : (
        <ul className={styles.list}>
          {items.map((m) => (
            <li key={m.id} className={styles.item}>
              <span className={styles.dot} style={{ opacity: 0.35 + m.importance * 0.65 }} />
              <span className={styles.content}>{m.content}</span>
              <span className={styles.when}>{formatWhen(m.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.foot}>
        <span>{loadedAt ? `最近读取 ${formatWhen(loadedAt)}` : '最近读取 —'}</span>
        <button type="button" className={styles.link} onClick={() => onViewChange?.('memories')}>
          管理记忆
        </button>
      </div>
    </Card>
  )
}

export default RecentFocus
