/**
 * 转交卡片（F2 队长制）
 *
 * 主助手调用 propose_dev_handoff 后，消息里渲染此卡片：任务摘要 + 目标项目 + 状态。
 *
 * 2026-09-15：转交改为**自动执行**（主进程发起，不再等用户点确认），所以卡片默认是
 * 「已交给灵栖开发 · 去会话查看」的状态展示。宿主未注入自动执行入口时（测试 / 裁剪场景），
 * 工具仍返回 `status: 'proposed'`，此时卡片退回带确认按钮的旧形态——两条路径都保留。
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
  | { phase: 'autoStarted'; sessionKey?: string; title?: string }
  | { phase: 'confirming' }
  | { phase: 'done'; sessionKey?: string; title?: string }
  | { phase: 'failed'; message: string }

interface ParsedProposal {
  handoffId?: string
  projectName?: string
  status?: string
  devSessionKey?: string
  title?: string
}

/** 从工具结果里解析提案字段（jsonToolResult 包装为 { content: [{ text: JSON }] }） */
function parseProposed(result: unknown): ParsedProposal {
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
    const parsed = JSON.parse(text) as Record<string, unknown>
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
    return {
      ...(str(parsed.handoffId) ? { handoffId: str(parsed.handoffId)! } : {}),
      ...(str(parsed.projectName) ? { projectName: str(parsed.projectName)! } : {}),
      ...(str(parsed.status) ? { status: str(parsed.status)! } : {}),
      ...(str(parsed.devSessionKey) ? { devSessionKey: str(parsed.devSessionKey)! } : {}),
      ...(str(parsed.title) ? { title: str(parsed.title)! } : {}),
    }
  } catch {
    return {}
  }
}

export const HandoffCard: React.FC<HandoffCardProps> = ({ part }) => {
  const actions = useChatMessageActions()

  const summary = typeof part.args?.summary === 'string' ? part.args.summary : ''
  const proposed = useMemo(() => parseProposed(part.result), [part.result])

  const initial = useMemo<CardState>(() => {
    if (part.status === 'running' || part.result === undefined) return { phase: 'preparing' }
    if (part.isError) return { phase: 'failed', message: '转交发起失败，请让主助手重试。' }

    // 自动执行：工具已在主进程发起，卡片只做状态展示
    if (proposed.status === 'started') {
      return {
        phase: 'autoStarted',
        ...(proposed.devSessionKey ? { sessionKey: proposed.devSessionKey } : {}),
        ...(proposed.title ? { title: proposed.title } : {}),
      }
    }
    // 工具侧执行失败（如未绑定编码工具）
    if (proposed.status === 'error' || !proposed.handoffId) {
      return { phase: 'failed', message: '转交未能发起，请让主助手重试。' }
    }
    // 宿主未启用自动执行 → 保留「待确认」形态
    return { phase: 'ready', handoffId: proposed.handoffId }
  }, [part.status, part.result, part.isError, proposed])

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
        <span className={styles.target}>
          {proposed.projectName ? `灵栖开发 · ${proposed.projectName}` : '灵栖开发 · 绑定项目会话'}
        </span>
      </div>
      {summary && <div className={styles.summary}>{summary}</div>}

      {state.phase === 'preparing' && <div className={styles.hint}>正在准备转交提案…</div>}

      {state.phase === 'autoStarted' && (
        <div className={styles.row}>
          <span className={styles.doneText}>
            {state.title ? `已交给灵栖开发 · ${state.title}` : '已交给灵栖开发，正在开发会话中执行'}
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
