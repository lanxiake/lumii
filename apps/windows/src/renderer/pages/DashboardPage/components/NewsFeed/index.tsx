/**
 * NewsFeed - 最近资讯（概览页，替换原「用量与花费」位置）
 *
 * 数据由主进程「资讯抓取与综述」定时任务写入 ~/.lumii/news/latest.json，
 * 这里只读快照 + 提供「立即抓取」。点卡片会把解读请求预填进对话页输入框，
 * 不自动发送——让用户看得见要问什么，也能改。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Newspaper, RefreshCw, Sparkles } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
import styles from './NewsFeed.module.css'

/** Dashboard 通用 feed 条目；资讯只是默认的一种内容。 */
interface FeedItem {
  id: string
  title: string
  summary?: string
  href?: string
  source?: string
  timestamp?: number
  kind?: string
}

interface DashboardFeedSnapshot {
  feedId: string
  title: string
  updatedAt: number
  items: FeedItem[]
  summary?: string
}

/** 卡片区最多展示几条，多了会顶破一屏布局 */
const MAX_CARDS = 6

function formatWhen(ts?: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/**
 * 拼给 AI 的解读请求。带上链接让 web_fetch 能取原文，
 * 摘要作为兜底：抓不到网页时至少还有标题和摘要可谈。
 */
function buildInterpretPrompt(item: FeedItem): string {
  return [
    `帮我解读这条内容：${item.title}`,
    item.source || item.href ? `来源：${[item.source, item.href].filter(Boolean).join(' · ')}` : '',
    item.summary ? `摘要：${item.summary}` : '',
    '',
    '请先说清它讲了什么，再说说值得关注的点。',
  ]
    .filter(Boolean)
    .join('\n')
}

export interface NewsFeedProps {
  onViewChange?: (view: ViewType) => void
}

export const NewsFeed: React.FC<NewsFeedProps> = ({ onViewChange }) => {
  const [snapshot, setSnapshot] = useState<DashboardFeedSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    try {
      const res = await window.electronAPI?.dashboardFeed?.latest()
      if (!res) {
        setError('资讯接口不可用')
      } else if (res.success) {
        setSnapshot(res.data ?? null)
        setError(undefined)
      } else {
        setError(res.error ?? '读取资讯失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取资讯失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    setError(undefined)
    try {
      const res = await window.electronAPI?.dashboardFeed?.refresh()
      if (res?.success) setSnapshot(res.data?.snapshot ?? null)
      else setError(res?.error ?? '抓取失败')
    } catch (err) {
      setError(err instanceof Error ? err.message : '抓取失败')
    } finally {
      setRefreshing(false)
    }
  }

  /** 跳对话页并预填解读请求，由 ChatPage 侧监听同名事件写入草稿 */
  const interpret = (item: FeedItem) => {
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', { detail: { text: buildInterpretPrompt(item) } }),
    )
    onViewChange?.('chat')
  }

  const items = (snapshot?.items ?? []).slice(0, MAX_CARDS)

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <Newspaper size={13} strokeWidth={1.8} className={styles['head-icon']} />
        <span className={styles.title}>{snapshot?.title ?? '最近资讯'}</span>
        <span className={styles.tag}>
          {snapshot ? `更新于 ${formatWhen(snapshot.updatedAt)}` : '尚未抓取'}
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
          流水线
        </button>
      </div>

      {snapshot?.summary && (
        <div className={styles.digest}>
          <Sparkles size={11} strokeWidth={1.8} />
          <span>{snapshot.summary}</span>
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
        <div className={styles.grid}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.card}
              onClick={() => interpret(item)}
              title="点击让 Lumii 解读这条资讯"
            >
              <span className={styles.marker} aria-hidden="true" />
              <span className={styles['card-main']}>
                <span className={styles['card-title']}>{item.title}</span>
                {item.summary && <span className={styles['card-excerpt']}>{item.summary}</span>}
                <span className={styles['card-foot']}>
                  {item.source && <span className={styles.source}>{item.source}</span>}
                  <span className={styles.when}>{formatWhen(item.timestamp)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  )
}

export default NewsFeed
