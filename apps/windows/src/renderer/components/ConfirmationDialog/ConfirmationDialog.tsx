/**
 * Agent Runtime 高危工具确认卡片（行内）
 *
 * 对齐原型审批卡：左侧警示条、倒计时、允许 / 拒绝 / 总是允许。
 */

import React, { useEffect, useState } from 'react'
import styles from './ConfirmationDialog.module.css'

export interface ConfirmationDialogProps {
  readonly open: boolean
  /** 顶部标题 */
  readonly title?: string
  /** 主说明（来自权限管线） */
  readonly description: string
  readonly toolName: string
  /** 毫秒；超时后由 Store 清除，主进程默认拒绝 */
  readonly timeoutMs: number
  /** 权限来自非当前 UI 会话时的提示（如微信后台频道） */
  readonly sessionHint?: string
  /** 仅本次允许 */
  readonly onAllowOnce: () => void | Promise<void>
  /** 总是允许（同类 24h 免询问） */
  readonly onAllowAlways: () => void | Promise<void>
  readonly onDeny: () => void | Promise<void>
}

/**
 * 将内置工具名映射为简短中文说明（仅展示用）
 */
function toolTitle(toolName: string): string {
  const map: Record<string, string> = {
    bash: '执行 Shell 命令',
    file_read: '读取文件',
    file_write: '写入文件',
    file_edit: '编辑文件',
    glob: '文件搜索',
    grep: '内容搜索',
    web_fetch: '网络请求',
    web_search: '网络搜索',
    todo_write: '更新任务列表',
    spawn_agent: '创建子 Agent',
    send_message: '发送消息',
  }
  return map[toolName] ?? `执行工具 ${toolName}`
}

/**
 * 将剩余秒数格式化为可读倒计时（≥60s 显示 Xm Ys）
 */
function formatCountdown(totalSec: number): string {
  const s = Math.max(0, totalSec)
  if (s < 60) return `等待 ${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `等待 ${m}m ${rem}s` : `等待 ${m}m`
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  open,
  title = '需要确认',
  description,
  toolName,
  timeoutMs,
  sessionHint,
  onAllowOnce,
  onAllowAlways,
  onDeny,
}) => {
  const [busy, setBusy] = useState(false)
  const [leftSec, setLeftSec] = useState(() => Math.max(1, Math.ceil(timeoutMs / 1000)))

  useEffect(() => {
    if (!open) {
      setBusy(false)
      setLeftSec(Math.max(1, Math.ceil(timeoutMs / 1000)))
      return
    }
    setLeftSec(Math.max(1, Math.ceil(timeoutMs / 1000)))
    const t = setInterval(() => {
      setLeftSec((s) => (s <= 1 ? 1 : s - 1))
    }, 1000)
    return () => clearInterval(t)
  }, [open, timeoutMs])

  if (!open) return null

  /** 包装异步决策，避免连点 */
  async function run(action: () => void | Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.card} role="alertdialog" aria-label={title}>
      <div className={styles.head}>
        <span className={styles.glyph} aria-hidden>⚠</span>
        <span className={styles.title}>{title}</span>
        <span className={styles.countdown}>{formatCountdown(leftSec)}</span>
      </div>

      <div className={styles.lead}>{toolTitle(toolName)}</div>
      <pre className={styles.code}>
        <code>{description.startsWith('$') ? description : `$ ${description}`}</code>
      </pre>

      <div className={styles.meta}>
        <span className={styles.tool}>{toolName}</span>
        {sessionHint ? <span className={styles.hint}>{sessionHint}</span> : null}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles['btn--allow']}`}
          disabled={busy}
          onClick={() => void run(onAllowOnce)}
        >
          <span aria-hidden>✓</span>
          允许
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles['btn--deny']}`}
          disabled={busy}
          onClick={() => void run(onDeny)}
        >
          <span aria-hidden>×</span>
          拒绝
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles['btn--always']}`}
          disabled={busy}
          title="同类操作 24 小时内免询问"
          onClick={() => void run(onAllowAlways)}
        >
          总是允许
        </button>
      </div>
    </div>
  )
}
