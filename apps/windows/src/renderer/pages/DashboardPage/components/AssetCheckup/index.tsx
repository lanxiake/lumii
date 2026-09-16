/**
 * AssetCheckup - 资产体检（概览页「近期关注」卡的第四个分段）
 *
 * 显示「灵栖维护」最近一次巡检的结论与发现，并标出与上一期相比：
 * 新出现 / 仍在 / 已解决。已解决由两期数据直接算出来，不需要用户手工标记——
 * 这也是报告要落库而不是只留在会话里的原因。
 *
 * 这里只渲染**内容**（不含 Card 与标题）：标题与分段切换由「近期关注」卡提供，
 * 卡片自身有固定高度上限，所以本组件高度铺满父级、内部滚动。
 *
 * 点条目把追问请求预填进对话页（与资讯卡同一套交互），用户可以直接问「第 2 条怎么处理」。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
import { fetchMaintenanceOverview, type MaintenanceOverview } from '../../../../services/maintenance-report-service'
import type { MaintenanceFinding, MaintenanceSeverity } from '@main/maintenance-report-store'
import styles from './AssetCheckup.module.css'

/** 资产类别的中文名（与后端 MAINTENANCE_SCOPES 对齐） */
const SCOPE_LABELS: Record<string, string> = {
  full: '全部资产',
  memory: '记忆',
  wiki: '资料库',
  guides: '用户指南',
  settings: '客户端设置',
  workspace: '工作区',
}

/** 触发来源的中文名 */
const TRIGGER_LABELS: Record<string, string> = {
  manual: '手动',
  cron: '定时',
  autonomous: '自主',
}

const SEVERITY_LABELS: Record<MaintenanceSeverity, string> = {
  high: '高风险',
  medium: '中等',
  low: '轻微',
}

function formatWhen(iso?: string): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 3600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 拼给 AI 的追问请求（带上问题、依据与建议，避免它再问一遍上下文） */
function buildFollowUpPrompt(finding: MaintenanceFinding): string {
  return [
    `维护体检发现了一个问题：${finding.title}`,
    finding.evidence ? `依据：${finding.evidence}` : '',
    finding.suggestion ? `已有建议：${finding.suggestion}` : '',
    '',
    '请帮我确认这个问题现在还在不在，并说明该怎么处理。',
  ]
    .filter(Boolean)
    .join('\n')
}

export interface AssetCheckupPanelProps {
  onViewChange?: (view: ViewType) => void
}

export const AssetCheckupPanel: React.FC<AssetCheckupPanelProps> = ({ onViewChange }) => {
  const [data, setData] = useState<MaintenanceOverview>({ reports: [], diff: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  /** 展示到第几期（默认只看最新一期，历史按期按需展开） */
  const [visibleCount, setVisibleCount] = useState(1)

  const load = useCallback(async () => {
    const overview = await fetchMaintenanceOverview(5)
    setData(overview)
    return overview
  }, [])

  // 只在挂载时拉一次：分段切换会卸载/重挂本组件，等于「进这个 Tab 就取最新的」
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(undefined)
      try {
        await load()
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取体检报告失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    setError(undefined)
    try {
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新失败')
    } finally {
      setRefreshing(false)
    }
  }

  /** 追问：跳对话页并把问题预填进输入框（体检追问是独立话题，新开会话） */
  const ask = (finding: MaintenanceFinding) => {
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: buildFollowUpPrompt(finding), newSession: true },
      }),
    )
    onViewChange?.('chat')
  }

  const latest = data.reports[0]
  const diff = data.diff
  const visibleReports = data.reports.slice(0, visibleCount)

  if (loading) return <div className={styles.state}>正在读取体检记录…</div>
  if (error) return <div className={styles.state}>{error}</div>
  if (!latest) {
    return (
      <div className={styles.state}>
        还没有体检记录。对「灵栖维护」说一句「帮我做一次资产体检」即可。
      </div>
    )
  }

  return (
    /**
     * 根元素**同时是**滚动容器：卡片是内容高度的 flex 列，多包一层 flex:1 的中间层
     * 会让高度算不出来、内容被卡片 overflow:hidden 裁掉（实测：分段里只剩元信息行）。
     * 与同卡的 `.list` 保持同一形态——一个 flex:1 + overflow-y:auto 的直系子元素。
     */
    <div className={styles.panel}>
      <div className={styles.meta}>
        <span className={styles['meta-text']}>
          {SCOPE_LABELS[latest.scope] ?? latest.scope} · {TRIGGER_LABELS[latest.trigger] ?? latest.trigger} ·{' '}
          {formatWhen(latest.createdAt)}
        </span>
        <button
          type="button"
          className={styles.refresh}
          onClick={() => void refresh()}
          disabled={refreshing}
          title="刷新"
          aria-label={refreshing ? '刷新中' : '刷新'}
        >
          <RefreshCw size={12} strokeWidth={2} className={refreshing ? styles.spin : undefined} />
        </button>
      </div>

      {/* 跨期差分：新增 / 仍在 / 已解决——已解决不必用户标记，两期数据一比就知道 */}
      {diff && (diff.added.length > 0 || diff.resolved.length > 0) && (
        <div className={styles.diff}>
          {diff.added.length > 0 && (
            <span className={`${styles['diff-chip']} ${styles['diff-chip--added']}`}>
              新增 {diff.added.length}
            </span>
          )}
          {diff.persisting.length > 0 && (
            <span className={styles['diff-chip']}>仍在 {diff.persisting.length}</span>
          )}
          {diff.resolved.length > 0 && (
            <span className={`${styles['diff-chip']} ${styles['diff-chip--resolved']}`}>
              已解决 {diff.resolved.length}
            </span>
          )}
        </div>
      )}

      {visibleReports.map((report, reportIndex) => (
          <div key={report.id} className={styles.report}>
            <div className={styles['report-head']}>
              <span className={styles['report-summary']}>{report.summary}</span>
              {reportIndex > 0 && (
                <span className={styles['report-meta']}>{formatWhen(report.createdAt)}</span>
              )}
            </div>

            {report.findings.length === 0 ? (
              <div className={styles.clean}>
                <ShieldCheck size={13} strokeWidth={2} />
                未发现问题
              </div>
            ) : (
              <ul className={styles.findings}>
                {report.findings.map((finding) => (
                  <li key={`${report.id}:${finding.key}`} className={styles.finding}>
                    {/*
                      这一格只有 ~110px 高（卡片上限 220 减去分段头尾），所以每条发现压成一行：
                      严重度点 + 标题。依据与建议放进 title 悬停看，正文完整版在点开后的对话里。
                      铺开三段式会把发现整体挤到折叠线以下，用户只看到一段综述。
                    */}
                    <button
                      type="button"
                      className={styles['finding-body']}
                      onClick={() => ask(finding)}
                      title={[finding.title, finding.evidence, finding.suggestion && `→ ${finding.suggestion}`]
                        .filter(Boolean)
                        .join('\n')}
                    >
                      <span className={`${styles.severity} ${styles[`severity--${finding.severity}`]}`}>
                        {SEVERITY_LABELS[finding.severity]}
                      </span>
                      <span className={styles['finding-title']}>{finding.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {report.checked.length > 0 && (
              <div className={styles.checked} title={report.checked.join('；')}>
                已查无问题：{report.checked.length} 项
              </div>
            )}
          </div>
        ))}

        {data.reports.length > visibleCount && (
          <button type="button" className={styles.more} onClick={() => setVisibleCount((n) => n + 1)}>
            查看上一期体检（还有 {data.reports.length - visibleCount} 期）
          </button>
        )}
    </div>
  )
}

export default AssetCheckupPanel
