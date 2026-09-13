/**
 * 转交确认卡片（F2 队长制）
 *
 * 主助手调用 propose_dev_handoff 后，消息里渲染此卡片：任务摘要 + 「交给灵栖开发」按钮。
 * 点击 → handoff:confirm 命令 → 新建/复用开发会话并开始执行；成功后提供「去会话查看」。
 * 卡片状态本地维护（ready → confirming → done/failed），不回读服务端。
 */

import React, { useMemo, useState } from 'react'
import { useChatMessageActions } from '../../contexts/ChatMessageActionsContext'
import styles from './HandoffCard.module.css'

export interface HandoffToolPart {
  id: string
  args?: Record<string, unknown>
  result?: unknown
  status?: string
  isError?: boolean
}

interface HandoffCardProps {
  part: HandoffToolPart
}

type CardState =
  | { phase: 'preparing' }
  | { phase: 'ready'; handoffId: string }
  | { phase: 'confirming' }
  | { phase: 'done'; sessionKey?: string; title?: string }
  | { phase: 'failed'; message: string }

/** 从工具结果里解析 handoffId（jsonToolResult 包装为 { content: [{ text: JSON }] }） */
function parseProposed(result: unknown): { handoffId?: string } {
  try {
    let text: string | undefined
    if (typeof result === 'string') {
      text = result
    } else if (result && typeof result === 'object') {
      const content = (result as { content?: unknown }).content
      if (Array.isArray(content)) {
        const first = content[0] as { text?: unknown } | undefined
        if (typeof first?.text === 'string') text = first.text
      }
    }
    if (!text) return {}
    const parsed = JSON.parse(text) as { handoffId?: unknown }
    return typeof parsed.handoffId === 'string' ? { handoffId: parsed.handoffId } : {}
  } catch {
    return {}
  }
}

export const HandoffCard: React.FC<HandoffCardProps> = ({ part }) => {
  const actions = useChatMessageActions()

  const summary = typeof part.args?.summary === 'string' ? part.args.summary : ''
  const initial = useMemo<CardState>(() => {
    if (part.status === 'running' || part.result === undefined) return { phase: 'preparing' }
    const { handoffId } = parseProposed(part.result)
    if (part.isError || !handoffId) {
      return { phase: 'failed', message: '提案生成失败，请让主助手重新发起。' }
    }
    return { phase: 'ready', handoffId }
  }, [part.status, part.result, part.isError])

  const [override, setOverride] = useState<CardState | null>(null)
  const state = override ?? initial

  const handleConfirm = async () => {
    if (state.phase !== 'ready') return
    const handoffId = state.handoffId
    setOverride({ phase: 'confirming' })
    const res = await actions.confirmHandoff(handoffId)
    if (res.ok) {
      setOverride({ phase: 'done', sessionKey: res.sessionKey, title: res.title })
    } else {
      setOverride({ phase: 'failed', message: res.error || '转交执行失败' })
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.badge}>开发任务转交</span>
        <span className={styles.target}>灵栖开发 · 绑定项目会话</span>
      </div>
      {summary && <div className={styles.summary}>{summary}</div>}

      {state.phase === 'preparing' && <div className={styles.hint}>正在准备转交提案…</div>}

      {state.phase === 'ready' && (
        <div className={styles.row}>
          <span className={styles.hint}>点击确认后，将在开发会话中开始执行（直接调用绑定的编码 CLI）。</span>
          <button type="button" className={styles.primaryBtn} onClick={() => void handleConfirm()}>
            交给灵栖开发
          </button>
        </div>
      )}

      {state.phase === 'confirming' && (
        <div className={styles.row}>
          <span className={styles.hint}>正在转交…</span>
        </div>
      )}

      {state.phase === 'done' && (
        <div className={styles.row}>
          <span className={styles.doneText}>
            {state.title ? `已转交 · ${state.title}` : '已转交，开发任务已开始'}
          </span>
          {state.sessionKey && (
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => actions.openSession(state.sessionKey!)}
            >
              去会话查看
            </button>
          )}
        </div>
      )}

      {state.phase === 'failed' && <div className={styles.errorText}>{state.message}</div>}
    </div>
  )
}
