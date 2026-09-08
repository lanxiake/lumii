/**
 * NewsFeed - 最近资讯（概览页）
 *
 * 左右对称两列卡片（含序号），摘要两行便于扫读。
 * 点卡片把解读请求预填进对话页输入框。
 *
 * 数据来自 SQLite 累积存储（最多 1000 条），前端不做缓存：挂载即拉首屏一页，
 * 底部哨兵触底后游标分页加载下一页，最多展示 1000 条。首屏之后只增量渲染新一页。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Newspaper, RefreshCw, Sparkles } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
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

interface FeedCursor {
  timestamp: number
  id: string
}

/** 滑动分页上限：用户最多查看最近 1000 条 */
const MAX_VISIBLE = 1000
/** 每页条数（首屏与后续一致） */
const PAGE_SIZE = 12

function formatWhen(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/**
 * 拼给 AI 的解读请求（带上卡片标题、来源、摘要等完整信息）
 */
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
  const [summary, setSummary] = useState<string | undefined>()
  const [updatedAt, setUpdatedAt] = useState<number | undefined>()
  const [items, setItems] = useState<FeedItem[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  // 触发「整页重置」的信号：抓取后必须从第 0 条重新拉，否则游标错位
  const [resetToken, setResetToken] = useState(0)

  const cursorRef = useRef<FeedCursor | null>(null)
  const loadingMoreRef = useRef(false)
  // 加载哨兵（底部触底即拉下一页）
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const reset = useCallback(() => {
    setItems([])
    setHasMore(false)
    cursorRef.current = null
    setResetToken((t) => t + 1)
  }, [])

  // 加载一页：before 为 null 拉首屏；否则拉下一页累加
  const loadPage = useCallback(async (before: FeedCursor | null) => {
    const res = await window.electronAPI?.dashboardFeed?.page('news', {
      limit: PAGE_SIZE,
      before,
    })
    if (!res) throw new Error('资讯接口不可用')
    if (!res.success) throw new Error(res.error ?? '读取资讯失败')
    return res.data ?? { feedId: 'news', items: [], nextCursor: null }
  }, [])

  // 首屏 / 重置后加载（拉 meta + 第一页）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(undefined)
      try {
        const api = window.electronAPI?.dashboardFeed
        if (!api) throw new Error('资讯接口不可用')
        const [metaRes, pageRes] = await Promise.all([
          api.meta('news'),
          api.page('news', { limit: PAGE_SIZE, before: null }),
        ])
        if (cancelled) return
        const meta = metaRes?.success ? metaRes.data : null
        if (meta) {
          setTitle(meta.title ?? '最近资讯')
          setSummary(meta.summary)
          setUpdatedAt(meta.updatedAt)
        }
        if (!pageRes?.success) throw new Error(pageRes?.error ?? '读取资讯失败')
        const page = pageRes.data ?? { feedId: 'news', items: [], nextCursor: null }
        setItems(page.items)
        cursorRef.current = page.nextCursor
        setHasMore(page.nextCursor !== null && page.items.length > 0)
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

  // 触底加载下一页
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        if (loadingMoreRef.current) return
        if (!hasMore || items.length >= MAX_VISIBLE) return
        loadingMoreRef.current = true
        setLoadingMore(true)
        const before = cursorRef.current
        void loadPage(before)
          .then((page) => {
            setItems((prev) => {
              const seen = new Set(prev.map((i) => i.id))
              const merged = [...prev, ...page.items.filter((i) => !seen.has(i.id))]
              return merged.slice(0, MAX_VISIBLE)
            })
            cursorRef.current = page.nextCursor
            setHasMore(page.nextCursor !== null && page.items.length > 0)
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
  }, [hasMore, items.length, loadPage])

  const refresh = async () => {
    setRefreshing(true)
    setError(undefined)
    try {
      const res = await window.electronAPI?.dashboardFeed?.refresh()
      if (res?.success) {
        // 抓取是 DB 累积合并，抓完从第 0 条重新拉，避免游标错位
        reset()
      } else {
        setError(res?.error ?? '抓取失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '抓取失败')
    } finally {
      setRefreshing(false)
    }
  }

  /** 跳对话页并预填解读请求；解读资讯是独立话题，开新会话而不是接在当前对话后面。 */
  const interpret = (item: FeedItem) => {
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: buildInterpretPrompt(item), newSession: true },
      }),
    )
    onViewChange?.('chat')
  }

  // 首屏可见项才保留入场错落动画；后续页直接显示，避免整列表重放动画的性能负担
  const firstScreenCount = Math.min(items.length, PAGE_SIZE)
  const cardDelay = useMemo(
    () => (index: number) => (index < firstScreenCount ? index : undefined),
    [firstScreenCount],
  )

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <Newspaper size={14} strokeWidth={1.8} className={styles['head-icon']} />
        <span className={styles.title}>{title}</span>
        <span className={styles.tag}>
          {updatedAt ? `更新于 ${formatWhen(updatedAt)}` : '尚未抓取'}
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
        <button type="button" className={styles.link} onClick={() => onViewChange?.('cron')}>
          定时任务
        </button>
      </div>

      {summary && (
        <div className={styles.digest}>
          <Sparkles size={12} strokeWidth={1.8} />
          <span>{summary}</span>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.empty}>正在读取资讯…</div>
      ) : items.length === 0 ? (
        <div className={styles.empty}>
          还没有数据。当前工作流每 2 小时运行一次，也可以点右侧刷新。
        </div>
      ) : (
        <div className={styles.scroll}>
          <div className={styles.grid}>
            {items.map((item, index) => (
              <div
                key={item.id}
                className={styles.card}
                style={
                  cardDelay(index) === undefined
                    ? undefined
                    : ({ ['--i' as string]: cardDelay(index) } as React.CSSProperties)
                }
              >
                <button
                  type="button"
                  className={styles['card-body']}
                  onClick={() => interpret(item)}
                  title="点击让 Lumii 解读这条资讯"
                >
                  <span className={styles.idx} aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
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
                  <span className={styles.when}>{formatWhen(item.timestamp)}</span>
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
          {(hasMore || loadingMore) && (
            <div ref={sentinelRef} className={styles.sentinel}>
              {loadingMore ? '加载更多…' : ''}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export default NewsFeed
