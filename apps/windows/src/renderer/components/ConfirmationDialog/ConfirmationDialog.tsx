/**
 * Agent Runtime 高危工具确认卡片（行内）
 *
 * 对齐原型审批卡：左侧警示条、倒计时、允许 / 拒绝 / 总是允许。
 */

import React, { useEffect, useRef, useState } from 'react'
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
  /**
   * 一次性高亮：滚进视野 + 2s 描边。
   *
   * 由宠物窗口的「去审批」送上来的（`app-ui:goto` 带 `focusPermissionRequestId`）——
   * 把用户从桌面宠物**送到这张卡前面**的最后一步。它是**边沿触发**的
   * （`false → true` 只跑一次动画），所以组件内部不必自己熄掉；
   * 但那个"意图"要由调用方清（见 `MultiSessionRuntimeState.focusPermissionRequestId`）。
   */
  readonly highlight?: boolean
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
  if (map[toolName]) return map[toolName]!
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (mcp) return `MCP ${mcp[1]} · ${mcp[2]}`
  return `执行工具 ${toolName}`
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
  highlight = false,
  onAllowOnce,
  onAllowAlways,
  onDeny,
}) => {
  const [busy, setBusy] = useState(false)
  const [leftSec, setLeftSec] = useState(() => Math.max(1, Math.ceil(timeoutMs / 1000)))
  const cardRef = useRef<HTMLDivElement>(null)

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

  /**
   * 滚进视野。用 `block: 'nearest'` 而不是 `'center'`：卡片本来就在屏幕底部
   * （`ChatBottomOverlay`），居中滚动会把整页往上推移一大截，看起来像"页面跳了"。
   */
  useEffect(() => {
    if (!open || !highlight) return
    cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [open, highlight])

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
    <div
      ref={cardRef}
      className={highlight ? `${styles.card} ${styles.highlight}` : styles.card}
      // 验证脚本的锚点（`verify/pet-sprite/check-notice-focus.mjs`）——别删
      data-highlight={highlight ? 'true' : undefined}
      role="alertdialog"
      aria-label={title}
    >
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
