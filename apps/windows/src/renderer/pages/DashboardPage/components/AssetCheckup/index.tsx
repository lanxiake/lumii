/**
 * AssetCheckup - 资产体检（概览页）
 *
 * 显示「灵栖维护」最近一次巡检的结论与发现，并标出与上一期相比：
 * 新出现 / 仍在 / 已解决。已解决由两期数据直接算出来，不需要用户手工标记——
 * 这也是报告要落库而不是只留在会话里的原因。
 *
 * 点条目把追问请求预填进对话页（与资讯卡同一套交互），用户可以直接问「第 2 条怎么处理」。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { HeartPulse, RefreshCw, ShieldCheck } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
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

export interface AssetCheckupProps {
  onViewChange?: (view: ViewType) => void
}

export const AssetCheckup: React.FC<AssetCheckupProps> = ({ onViewChange }) => {
  const [data, setData] = useState<MaintenanceOverview>({ reports: [], diff: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  /** 展示到第几期（默认只看最新一期，历史按期折叠） */
  const [visibleCount, setVisibleCount] = useState(1)

  const load = useCallback(async () => {
    const overview = await fetchMaintenanceOverview(5)
    setData(overview)
    return overview
  }, [])

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

  /** 追问：跳对话页并把问题预填进输入框（新开会话，体检追问是独立话题） */
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

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <HeartPulse size={14} strokeWidth={1.8} className={styles['head-icon']} />
        <span className={styles.title}>资产体检</span>
        <span className={styles.tag}>
          {latest
            ? `${SCOPE_LABELS[latest.scope] ?? latest.scope} · ${TRIGGER_LABELS[latest.trigger] ?? latest.trigger} · ${formatWhen(latest.createdAt)}`
            : '尚未体检'}
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

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <div className={styles.empty}>正在读取体检记录…</div>
      ) : !latest ? (
        <div className={styles.empty}>
          还没有体检记录。对「灵栖维护」说一句「帮我做一次资产体检」即可。
        </div>
      ) : (
        <div className={styles.scroll}>
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
                <span className={styles['report-meta']}>
                  {reportIndex === 0 ? '最近一次 · ' : ''}
                  {formatWhen(report.createdAt)}
                </span>
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
                      <button
                        type="button"
                        className={styles['finding-body']}
                        onClick={() => ask(finding)}
                        title="点击让 Lumii 确认这个问题"
                      >
                        <span
                          className={`${styles.severity} ${styles[`severity--${finding.severity}`]}`}
                        >
                          {SEVERITY_LABELS[finding.severity]}
                        </span>
                        <span className={styles['finding-main']}>
                          <span className={styles['finding-title']}>{finding.title}</span>
                          {finding.evidence && (
                            <span className={styles['finding-evidence']}>{finding.evidence}</span>
                          )}
                          {finding.suggestion && (
                            <span className={styles['finding-suggestion']}>→ {finding.suggestion}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {report.checked.length > 0 && (
                <div className={styles.checked}>
                  已查无问题：{report.checked.join('；')}
                </div>
              )}
            </div>
          ))}

          {data.reports.length > visibleCount && (
            <button
              type="button"
              className={styles.more}
              onClick={() => setVisibleCount((n) => n + 1)}
            >
              查看上一期体检（还有 {data.reports.length - visibleCount} 期）
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

export default AssetCheckup
