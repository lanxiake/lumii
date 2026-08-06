/**
 * Agent Runtime 高危工具确认卡片（行内，不再是弹窗）
 *
 * 对齐原型 `.apr`：挂在输入框上方的消息流末尾，不遮挡上下文。
 * 「允许执行」对应 24h 内同类工具自动允许（主进程 allow-always + PermissionMemory）
 */

import React, { useEffect, useState } from 'react'
import styles from './ConfirmationDialog.module.css'

export interface ConfirmationDialogProps {
  readonly open: boolean
  /** 顶部标题 */
  readonly title?: string
  /** 主说明（来自权限管线，通常为英文短句；可再展示本地化副标题） */
  readonly description: string
  readonly toolName: string
  /** 毫秒；超时后由 Store 清除，主进程默认拒绝 */
  readonly timeoutMs: number
  /** 权限来自非当前 UI 会话时的提示（如微信后台频道） */
  readonly sessionHint?: string
  readonly onAllow: () => void | Promise<void>
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

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  open,
  title = '需要确认',
  description,
  toolName,
  timeoutMs,
  sessionHint,
  onAllow,
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

  /** 允许执行（24h 内同类工具免询问） */
  async function handleAllow(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onAllow()
    } finally {
      setBusy(false)
    }
  }

  /** 拒绝本次执行 */
  async function handleDeny(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onDeny()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.card} role="alertdialog" aria-label={title}>
      <div className={styles.head}>
        <span className={styles.glyph}>!</span>
        <span className={styles.title}>{title}</span>
        <span className={styles.countdown}>{leftSec}s 后自动取消</span>
      </div>

      <div className={styles.lead}>{toolTitle(toolName)}</div>
      <pre className={styles.code}>
        <code>{description}</code>
      </pre>

      <div className={styles.meta}>
        <span className={styles.tool}>{toolName}</span>
        {sessionHint ? <span className={styles.hint}>{sessionHint}</span> : null}
        <span className={styles.hint}>允许后同类操作 24 小时内免询问</span>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles['btn--allow']}`}
          disabled={busy}
          onClick={() => void handleAllow()}
        >
          允许执行
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles['btn--deny']}`}
          disabled={busy}
          onClick={() => void handleDeny()}
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
