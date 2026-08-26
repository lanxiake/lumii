/**
 * RecentFocus - 近期关注
 *
 * 三个分段各自一个真实数据源，不做「AI 归纳过」的假象：
 * - 工作记忆：`agent:memories:list` 的 project/reference/general（= WORK_MEMORY_CATEGORIES）
 * - Wiki：`wiki:page:list` 最近整理好的页面
 * - 定时任务：`cron:list` + `cron:runs` 的执行记录，点击看产出正文
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { Modal } from '../../../../components/ui/Modal/Modal'
import { useMemoryUsage } from '../../../../hooks/business/useMemoryUsage'
import { useWikiPage } from '../../../../hooks/business/useWikiPage'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
import clsx from 'clsx'
import styles from './RecentFocus.module.css'

type TabId = 'work' | 'wiki' | 'cron'

const TABS: ReadonlyArray<{ id: TabId; label: string; view: ViewType; action: string }> = [
  { id: 'work', label: '工作记忆', view: 'memories', action: '管理记忆' },
  { id: 'wiki', label: 'Wiki', view: 'memories', action: '打开 Wiki' },
  { id: 'cron', label: '定时任务', view: 'cron', action: '任务中心' },
]

/** 与 packages/agent-runtime WORK_MEMORY_CATEGORIES 对齐 */
const WORK_CATEGORIES = ['project', 'reference', 'general']

const MAX_ITEMS = 10

/** 三个数据源归一后的列表项 */
interface FocusItem {
  readonly id: string
  readonly text: string
  readonly at: number
  /** 0~1，映射到圆点不透明度 */
  readonly weight: number
  /** 有值则可点开详情 */
  readonly detail?: { readonly title: string; readonly body: string; readonly meta: string }
}

function formatWhen(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

const EMPTY_HINT: Record<TabId, string> = {
  work: '还没有工作记忆。多聊几轮，Lumii 会记下当前任务与用到的资源。',
  wiki: '还没有整理好的资料。上传文件、任务产物与搜索结果会自动归档到 Wiki。',
  cron: '还没有执行记录。定时任务跑过之后，产出会出现在这里。',
}

export interface RecentFocusProps {
  onViewChange?: (view: ViewType) => void
}

export const RecentFocus: React.FC<RecentFocusProps> = ({ onViewChange }) => {
  const { listMemories } = useMemoryUsage()
  const { listPages } = useWikiPage()
  const [activeTab, setActiveTab] = useState<TabId>('work')
  const [items, setItems] = useState<readonly FocusItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState<number>()
  const [detail, setDetail] = useState<FocusItem['detail']>()

  const loadWork = useCallback(async (): Promise<readonly FocusItem[]> => {
    const rows = await listMemories()
    return rows
      .filter((m) => WORK_CATEGORIES.includes(m.category))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_ITEMS)
      .map((m) => ({ id: m.id, text: m.content, at: m.createdAt, weight: m.importance }))
  }, [listMemories])

  const loadWiki = useCallback(async (): Promise<readonly FocusItem[]> => {
    const rows = await listPages()
    return [...rows]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_ITEMS)
      .map((p) => ({ id: p.id, text: p.title, at: p.updatedAt, weight: 0.7 }))
  }, [listPages])

  /**
   * 定时任务执行记录：cron:list 拿任务名，再逐任务拉最近执行。
   * ponytail: N+1 请求（N=任务数，通常 <10，与 CronPage/HistoryTab 同款做法）；
   * 任务数上百再加一条「跨任务查最近执行」的 IPC。
   */
  const loadCron = useCallback(async (): Promise<readonly FocusItem[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []
    const jobList = (await api.sendCommand({ type: 'cron:list', includeDisabled: true })) as {
      jobs?: ReadonlyArray<{ id: string; name: string }>
    }
    const jobs = jobList?.jobs ?? []
    const perJob = await Promise.all(
      jobs.map(async (job) => {
        try {
          const r = (await api.sendCommand({ type: 'cron:runs', id: job.id, limit: MAX_ITEMS })) as {
            entries?: ReadonlyArray<{
              id: string
              status: string
              startedAt: number
              durationMs?: number
              summary?: string
              error?: string
            }>
          }
          return (r?.entries ?? []).map((run): FocusItem => {
            const failed = run.status === 'error'
            const body = (failed ? run.error : run.summary) || '本次执行没有留下产出内容。'
            return {
              id: run.id,
              text: `${job.name} · ${failed ? '失败' : '成功'}`,
              at: run.startedAt,
              weight: failed ? 1 : 0.55,
              detail: {
                title: job.name,
                body,
                meta: [
                  new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false }),
                  failed ? '失败' : '成功',
                  run.durationMs != null ? `耗时 ${(run.durationMs / 1000).toFixed(1)}s` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
              },
            }
          })
        } catch {
          return [] as FocusItem[]
        }
      }),
    )
    return perJob
      .flat()
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_ITEMS)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const load = activeTab === 'work' ? loadWork : activeTab === 'wiki' ? loadWiki : loadCron
    void load()
      .catch(() => [] as readonly FocusItem[])
      .then((rows) => {
        if (!alive) return
        setItems(rows)
        setLoadedAt(Date.now())
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [activeTab, loadWork, loadWiki, loadCron])

  const current = useMemo(() => TABS.find((t) => t.id === activeTab) ?? TABS[0], [activeTab])

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <span className={styles.title}>近期关注</span>
        <div className={styles.seg} role="tablist" aria-label="近期关注分类">
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

      {loading && items.length === 0 ? (
        <div className={styles.empty}>正在读取…</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>{EMPTY_HINT[activeTab]}</div>
      ) : (
        <ul className={styles.list}>
          {items.map((it) => {
            const clickable = Boolean(it.detail)
            return (
              <li
                key={it.id}
                className={clsx(styles.item, clickable && styles['item--clickable'])}
                onClick={clickable ? () => setDetail(it.detail) : undefined}
                title={clickable ? '点击查看执行结果' : undefined}
              >
                <span className={styles.dot} style={{ opacity: 0.35 + it.weight * 0.65 }} />
                <span className={styles.content}>{it.text}</span>
                <span className={styles.when}>{formatWhen(it.at)}</span>
              </li>
            )
          })}
        </ul>
      )}

      <div className={styles.foot}>
        <span>{loadedAt ? `最近读取 ${formatWhen(loadedAt)}` : '最近读取 —'}</span>
        <button type="button" className={styles.link} onClick={() => onViewChange?.(current.view)}>
          {current.action}
        </button>
      </div>

      <Modal
        open={Boolean(detail)}
        title={detail?.title}
        width={620}
        onClose={() => setDetail(undefined)}
      >
        <p className={styles['detail-meta']}>{detail?.meta}</p>
        <pre className={styles['detail-body']}>{detail?.body}</pre>
      </Modal>
    </Card>
  )
}

export default RecentFocus
