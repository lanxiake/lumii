/**
 * 本地 Agent Runtime 安全/工具审计简表（最近 20 条）
 *
 * 列表默认折叠；展开后每条可再点开查看完整参数摘要与响应，支持一键复制。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import styles from './SecurityLogViewer.module.css'

type AuditRow = {
  readonly id: number
  readonly agent_id: string
  readonly tool_name: string
  readonly result_summary: string | null
  readonly is_error: number
  readonly duration_ms: number | null
  readonly timestamp: string
}

/**
 * 加载并展示最近审计记录
 */
export const SecurityLogViewer: React.FC = () => {
  const [rows, setRows] = useState<readonly AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  const [copiedId, setCopiedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) {
        setError('当前环境无法访问本地审计数据')
        return
      }
      const result = await api.sendCommand({ type: 'storage:auditRecent', limit: 20 })
      setRows((result ?? []) as readonly AuditRow[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 复制单条记录的完整内容到剪贴板 */
  const handleCopy = useCallback(async (row: AuditRow) => {
    const text = [
      `时间: ${formatLocal(row.timestamp)}`,
      `工具: ${row.tool_name}`,
      `状态: ${row.is_error ? '失败/拒绝' : '成功'}`,
      row.duration_ms != null ? `耗时: ${row.duration_ms} ms` : null,
      `详情:\n${row.result_summary ?? '—'}`,
    ]
      .filter(Boolean)
      .join('\n')
    try {
      await window.electronAPI.clipboard.writeText(text)
      setCopiedId(row.id)
      window.setTimeout(() => setCopiedId((cur) => (cur === row.id ? null : cur)), 1500)
    } catch {
      /* 复制失败时静默，不阻断查看 */
    }
  }, [])

  /** 渲染单条审计记录（可展开查看详情 + 复制） */
  const renderItem = (r: AuditRow) => {
    const isOpen = openId === r.id
    return (
      <li key={r.id} className={styles.item}>
        <button
          type="button"
          className={styles.itemHead}
          onClick={() => setOpenId((cur) => (cur === r.id ? null : r.id))}
          aria-expanded={isOpen}
        >
          <span className={styles.caret}>{isOpen ? '▲' : '▼'}</span>
          <span className={styles.time}>{formatLocal(r.timestamp)}</span>
          <span className={styles.tool}>{r.tool_name}</span>
          {r.duration_ms != null ? (
            <span className={styles.duration}>{r.duration_ms} ms</span>
          ) : null}
          <span
            className={r.is_error ? styles.bad : styles.ok}
            title={r.is_error ? '失败/拒绝' : '成功'}
          >
            {r.is_error ? '✗' : '✓'}
          </span>
        </button>
        {isOpen ? (
          <div className={styles.detail}>
            <div className={styles.detailBar}>
              <span className={styles.detailLabel}>详情</span>
              <Button variant="secondary" size="sm" onClick={() => void handleCopy(r)}>
                {copiedId === r.id ? '已复制' : '复制'}
              </Button>
            </div>
            <pre className={styles.detailBody}>{r.result_summary ?? '—'}</pre>
          </div>
        ) : (
          <div className={styles.summary}>{r.result_summary ?? '—'}</div>
        )}
      </li>
    )
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
        >
          <span className={styles.caret}>{listOpen ? '▲' : '▼'}</span>
          最近的安全操作
          {rows.length > 0 ? <span className={styles.count}>{rows.length}</span> : null}
        </button>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      {listOpen ? (
        <>
          {!loading && rows.length === 0 && !error ? (
            <p className={styles.empty}>暂无记录。高危工具经您确认或拒绝后，会在此显示摘要。</p>
          ) : null}
          {rows.length > 0 ? <ul className={styles.list}>{rows.map(renderItem)}</ul> : null}
        </>
      ) : (
        <p className={styles.collapsedHint}>
          {rows.length > 0
            ? `已折叠 ${rows.length} 条记录，点击标题展开查看。`
            : '点击标题展开查看安全操作记录。'}
        </p>
      )}
    </div>
  )
}

/**
 * ISO 时间格式化为本地可读字符串
 */
function formatLocal(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return iso
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}