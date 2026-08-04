/**
 * Agent Runtime 高危工具确认弹窗（极简：允许 / 取消）
 *
 * 「允许」对应 24h 内同类工具自动允许（主进程 allow-always + PermissionMemory）
 */

import React, { useEffect, useState } from 'react'
import { Modal } from '../ui/Modal/Modal'
import { Button } from '../ui/Button/Button'
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
  title = '确认操作',
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

  const footer = (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => void handleDeny()}>
        取消
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => void handleAllow()}>
        允许执行
      </Button>
    </>
  )

  async function handleAllow(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await onAllow()
    } finally {
      setBusy(false)
    }
  }

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
    <Modal open={open} title={`⚠️ ${title}`} footer={footer} maskClosable={false} width={440}>
      <div className={styles.body}>
        <p className={styles.lead}>AI 想要执行：<strong>{toolTitle(toolName)}</strong></p>
        <div className={styles.detail}>
          <span className={styles.label}>说明</span>
          <p className={styles.desc}>{description}</p>
        </div>
        <div className={styles.meta}>
          <span>🛠️ 工具：<code>{toolName}</code></span>
        </div>
        {sessionHint ? <p className={styles.hint}>{sessionHint}</p> : null}
        <p className={styles.hint}>
          点击「允许执行」后，同类操作在 24 小时内可自动执行，无需再次确认。
        </p>
        <p className={styles.countdown}>{leftSec} 秒内未操作将自动取消</p>
      </div>
    </Modal>
  )
}
