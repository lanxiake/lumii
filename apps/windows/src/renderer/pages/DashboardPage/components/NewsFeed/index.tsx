/**
 * NewsFeed - 最近资讯（概览页）
 *
 * **按期（期刊）渲染**：每次 Agent 推送 = 一期，一期有自己的综述、时间与条目。
 * 默认展开最新一期，更早的按期折叠（只显示时间 + 条数 + 综述首行）。
 *
 * 为什么不是一条流水：卡片是累积的，流水把所有批次平铺成一条长列，用户分不清
 * 「今天推了什么」；而且综述只有一份、每次抓取覆盖，上一期讲过什么直接丢失。
 * 按期之后三件事同时成立：边界清晰（本期 = 最新一期）、综述不再丢（每期各记一份）、
 * 保留策略可按期做（不会把一期裁成半个）。
 *
 * 点条目把解读请求预填进对话页输入框；期头的「查看原文」打开本期没有的链接入口。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Newspaper, RefreshCw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import { NewsPreferencesPanel } from '../NewsPreferences'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
import { fetchFeedMeta, fetchFeedBatches, refreshDashboardFeed } from '../../../../services/dashboard-feed-service'
import type { DashboardFeedBatch, DashboardFeedBatchCursor } from '@main/dashboard-feed-store'
import { openExternalUrl } from '../../../../utils/markdown-external-link'
import styles from './NewsFeed.module.css'

/** Dashboard 通用 feed 条目 */
interface FeedItem {
  id: string
  title: string
  summary?: string
  href?: string
  source?: string
  timestamp?: number
  kind?: string
}

/** 每页拉几期（一期十几条，5 期约一屏半） */
const BATCH_PAGE_SIZE = 5
/** 滑动分页上限：最多展示这么多期 */
const MAX_BATCHES = 60

function formatWhen(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/**
 * 期的时间标签：「今天 14:00」「昨天 09:30」「9 月 12 日 08:00」。
 * 期是人的阅读单位，显示成「3 小时前」会让「今天推了几期」看不出来。
 */
function batchLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '未知时间'
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000)
  if (days <= 0) return `今天 ${hhmm}`
  if (days === 1) return `昨天 ${hhmm}`
  if (days < 7) return `${days} 天前 ${hhmm}`
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hhmm}`
}

/** 期的来源标签；legacy 是 V43 之前的历史数据按天合成的期 */
const SOURCE_LABELS: Record<string, string> = {
  agent: '情报推送',
  // 不叫「定时任务」：期头右上角就有一个同名导航按钮，两个「定时任务」会打架
  cron: '定时推送',
  manual: '手动',
  legacy: '历史',
}

/** 拼给 AI 的解读请求（带上卡片标题、来源、摘要等完整信息） */
function buildInterpretPrompt(item: FeedItem): string {
  const lines = [
    `帮我解读这条内容：${item.title}`,
    item.source || item.href ? `来源：${[item.source, item.href].filter(Boolean).join(' · ')}` : '',
    item.kind ? `类型：${item.kind}` : '',
    item.timestamp ? `时间：${new Date(item.timestamp).toLocaleString()}` : '',
    item.summary ? `摘要：${item.summary}` : '',
    '',
    '请先说清它讲了什么，再说说值得关注的点。',
  ]
  return lines.filter(Boolean).join('\n')
}

export interface NewsFeedProps {
  onViewChange?: (view: ViewType) => void
}

export const NewsFeed: React.FC<NewsFeedProps> = ({ onViewChange }) => {
  const [title, setTitle] = useState('最近资讯')
  const [updatedAt, setUpdatedAt] = useState<number | undefined>()
  const [batches, setBatches] = useState<DashboardFeedBatch[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [error, setError] = useState<string>()
  /** 手动折叠/展开过的期（默认只展开最新一期） */
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({})
  // 触发「整页重置」的信号：抓取后必须从第一期重新拉，否则游标错位
  const [resetToken, setResetToken] = useState(0)

  const cursorRef = useRef<DashboardFeedBatchCursor | null>(null)
  const loadingMoreRef = useRef(false)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const reset = useCallback(() => {
    setBatches([])
    setHasMore(false)
    cursorRef.current = null
    setResetToken((t) => t + 1)
  }, [])

  const loadPage = useCallback(
    (before: DashboardFeedBatchCursor | null) => fetchFeedBatches('news', { limit: BATCH_PAGE_SIZE, before }),
    [],
  )

  // 首屏 / 重置后加载（拉 meta + 第一批期）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(undefined)
      try {
        const [meta, page] = await Promise.all([
          fetchFeedMeta('news'),
          fetchFeedBatches('news', { limit: BATCH_PAGE_SIZE, before: null }),
        ])
        if (cancelled) return
        if (meta) {
          setTitle(meta.title ?? '最近资讯')
          setUpdatedAt(meta.updatedAt)
        }
        setBatches(page.batches)
        cursorRef.current = page.nextCursor
        setHasMore(page.nextCursor !== null && page.batches.length > 0)
      } catch (err) {
        setError(err instanceof Error ? err.message : '读取资讯失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resetToken])

  // 触底加载更早的期
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (loadingMoreRef.current) return
        if (!hasMore || batches.length >= MAX_BATCHES) return
        loadingMoreRef.current = true
        setLoadingMore(true)
        const before = cursorRef.current
        void loadPage(before)
          .then((page) => {
            setBatches((prev) => {
              const seen = new Set(prev.map((b) => b.id))
              return [...prev, ...page.batches.filter((b) => !seen.has(b.id))]
            })
            cursorRef.current = page.nextCursor
            setHasMore(page.nextCursor !== null && page.batches.length > 0)
          })
          .catch((err) => setError(err instanceof Error ? err.message : '加载更多失败'))
          .finally(() => {
            loadingMoreRef.current = false
            setLoadingMore(false)
          })
      },
      { root: null, rootMargin: '120px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, batches.length, loadPage])

  const refresh = async () => {
    setRefreshing(true)
    setError(undefined)
    try {
      await refreshDashboardFeed()
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : '抓取失败')
    } finally {
      setRefreshing(false)
    }
  }

  /** 跳对话页并预填解读请求；解读资讯是独立话题，开新会话而不是接在当前对话后面 */
  const interpret = (item: FeedItem) => {
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: buildInterpretPrompt(item), newSession: true },
      }),
    )
    onViewChange?.('chat')
  }

  const toggleBatch = (id: string, currentlyExpanded: boolean) => {
    setCollapsedOverride((prev) => ({ ...prev, [id]: currentlyExpanded }))
  }

  /** 最新一期默认展开，其余默认折叠 */
  const isExpanded = useCallback(
    (batchId: string, index: number) => {
      const override = collapsedOverride[batchId]
      return override === undefined ? index === 0 : !override
    },
    [collapsedOverride],
  )

  const totalCount = useMemo(() => batches.reduce((sum, b) => sum + b.items.length, 0), [batches])

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <Newspaper size={14} strokeWidth={1.8} className={styles['head-icon']} />
        <span className={styles.title}>{title}</span>
        <span className={styles.tag}>
          {updatedAt
            ? `${batches.length} 期 · ${totalCount} 条 · 更新于 ${formatWhen(updatedAt)}`
            : '尚未抓取'}
        </span>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={refreshing}
          title="立即抓取一次"
          aria-label={refreshing ? '抓取中' : '立即抓取一次'}
        >
          <RefreshCw size={12} strokeWidth={2} className={refreshing ? styles.spin : undefined} />
        </button>
        {/* 偏好放这里而不是新开一张卡：用户是在看资讯的时候才想起「这条为什么推给我」，
            放在被质疑的那份内容旁边，比放在别处更容易被找到 */}
        <button
          type="button"
          className={styles.refresh}
          onClick={() => setPrefsOpen(true)}
          title="看资讯偏好会命中什么"
          aria-label="资讯偏好"
        >
          <SlidersHorizontal size={12} strokeWidth={2} />
        </button>
        <button type="button" className={styles.link} onClick={() => onViewChange?.('cron')}>
          定时任务
        </button>
      </div>

      <NewsPreferencesPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} />

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.empty}>正在读取资讯…</div>
      ) : batches.length === 0 ? (
        <div className={styles.empty}>
          还没有数据。资讯任务按排期运行，也可以点右侧刷新。
        </div>
      ) : (
        <div className={styles.scroll}>
          {batches.map((batch, index) => {
            const expanded = isExpanded(batch.id, index)
            return (
              <section key={batch.id} className={styles.batch}>
                <button
                  type="button"
                  className={styles['batch-head']}
                  onClick={() => toggleBatch(batch.id, expanded)}
                  aria-expanded={expanded}
                >
                  <span className={styles['batch-caret']} aria-hidden="true">
                    {expanded ? '▾' : '▸'}
                  </span>
                  <span className={styles['batch-time']}>{batchLabel(batch.createdAt)}</span>
                  <span className={styles['batch-source']}>
                    {SOURCE_LABELS[batch.source] ?? batch.source}
                  </span>
                  <span className={styles['batch-count']}>{batch.items.length} 条</span>
                  {index === 0 && <span className={styles['batch-latest']}>最新</span>}
                </button>

                {batch.summary && (
                  <div className={styles['batch-summary']} title={batch.summary}>
                    <Sparkles size={11} strokeWidth={1.8} />
                    <span>{batch.summary}</span>
                  </div>
                )}

                {expanded && (
                  <div className={styles.grid}>
                    {batch.items.map((item, itemIndex) => (
                      <div
                        key={item.id}
                        className={styles.card}
                        style={
                          index === 0 && itemIndex < 12
                            ? ({ ['--i' as string]: itemIndex } as React.CSSProperties)
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className={styles['card-body']}
                          onClick={() => interpret(item)}
                          title="点击让 Lumii 解读这条资讯"
                        >
                          <span className={styles.idx} aria-hidden="true">
                            {String(itemIndex + 1).padStart(2, '0')}
                          </span>
                          <span className={styles['card-main']}>
                            <span className={styles['card-title']}>{item.title}</span>
                            {item.summary && (
                              <span className={styles['card-excerpt']}>{item.summary}</span>
                            )}
                          </span>
                        </button>
                        <span className={styles['card-foot']}>
                          {item.source && <span className={styles.source}>{item.source}</span>}
                          {item.href && (
                            <button
                              type="button"
                              className={styles['card-open']}
                              onClick={() => openExternalUrl(item.href!)}
                              title="在浏览器中打开原文"
                            >
                              查看原文
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
          {(hasMore || loadingMore) && (
            <div ref={sentinelRef} className={styles.sentinel}>
              {loadingMore ? '加载更早的推送…' : ''}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export default NewsFeed
