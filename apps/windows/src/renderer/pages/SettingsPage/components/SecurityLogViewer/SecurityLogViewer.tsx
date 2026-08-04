/**
 * 本地 Agent Runtime 安全/工具审计简表（最近 20 条）
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import styles from './SecurityLogViewer.module.css'

type AuditRow = {
  readonly id: number
  readonly tool_name: string
  readonly result_summary: string | null
  readonly is_error: number
  readonly timestamp: string
}

/**
 * 加载并展示最近审计记录
 */
export const SecurityLogViewer: React.FC = () => {
  const [rows, setRows] = useState<readonly AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <h4 className={styles.title}>最近的安全操作</h4>
        <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      {!loading && rows.length === 0 && !error ? (
        <p className={styles.empty}>暂无记录。高危工具经您确认或拒绝后，会在此显示摘要。</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.id} className={styles.item}>
              <div className={styles.row}>
                <span className={styles.time}>{formatLocal(r.timestamp)}</span>
                <span className={styles.tool}>{r.tool_name}</span>
                <span className={r.is_error ? styles.bad : styles.ok} title={r.is_error ? '失败/拒绝' : '成功'}>
                  {r.is_error ? '✗' : '✓'}
                </span>
              </div>
              <div className={styles.summary}>{r.result_summary ?? '—'}</div>
            </li>
          ))}
        </ul>
      ) : null}
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
