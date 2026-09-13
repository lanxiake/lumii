/**
 * 团队委托卡片（队长制）
 *
 * 主助手调用 spawn_agent 委托专家后，消息里渲染此卡片：谁在干 + 任务 + 状态 + 结果摘要。
 * 与转交卡片（propose_dev_handoff）同理，永远露在过程折叠区之外——
 * 委托是用户判断「团队此刻在干什么」的主要线索，被折叠进「调用 1 次工具」等于隐形。
 * 数据全部来自工具 part（args + jsonToolResult），历史回放可完整重现，无需额外事件链。
 */

import React, { useMemo, useState } from 'react'
import styles from './SpawnAgentCard.module.css'

export interface SpawnToolPart {
  id: string
  args?: Record<string, unknown>
  result?: unknown
  status?: string
  isError?: boolean
}

/**
 * 内置专家显示名（与 packages/agent-runtime/src/agent/builtin/definitions.ts 的 name 对齐）。
 * 渲染层不引入运行时包解析定义：委托卡片只需展示名，缺失时回退模型给的 args.name。
 */
const BUILTIN_AGENT_NAMES: Record<string, string> = {
  'code-dev': '灵栖开发',
  'system-keeper': '灵栖维护',
  'info-curator': '灵栖情报',
  chronicler: '灵栖记事',
  assistant: '灵栖',
}

interface SpawnResultPayload {
  status?: string
  instanceId?: string
  mode?: string
  output?: string
  message?: string
}

/** 从 jsonToolResult 的 content text 块解析委托结果（与 HandoffCard 同一包装格式） */
function parseSpawnResult(result: unknown): SpawnResultPayload | null {
  try {
    let text: string | undefined
    if (typeof result === 'string') {
      text = result
    } else if (result && typeof result === 'object') {
      const content = (result as { content?: unknown }).content
      if (Array.isArray(content)) {
        const first = content.find(
          (c): c is { type?: string; text: string } =>
            !!c && typeof c === 'object' && (c as { type?: string }).type === 'text'
              && typeof (c as { text?: unknown }).text === 'string',
        )
        text = first?.text
      }
    }
    if (!text) return null
    const parsed = JSON.parse(text) as SpawnResultPayload
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 单行截断 */
function truncate(text: string, max: number): string {
  const one = text.replace(/\s*\n+\s*/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** 取正文首段（委托任务与产出摘要都只展示开头） */
function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0) ?? ''
}

export const SpawnAgentCard: React.FC<{ part: SpawnToolPart }> = ({ part }) => {
  const [expanded, setExpanded] = useState(false)

  const args = part.args ?? {}
  const agentType = typeof args.agentType === 'string' ? args.agentType.trim() : ''
  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  const expertName = BUILTIN_AGENT_NAMES[agentType] || rawName || agentType || '子 Agent'
  const isAsync = args.mode === 'async'
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  const task =
    (typeof args.description === 'string' && args.description.trim()) ||
    firstLine(prompt) ||
    '未提供任务描述'

  const result = useMemo(() => parseSpawnResult(part.result), [part.result])
  const isRunning = part.status === 'running' || part.result === undefined
  const isFailed = !isRunning && (part.isError === true || result?.status === 'error')
  const output = typeof result?.output === 'string' ? result.output.trim() : ''

  const statusText = isRunning ? '执行中' : isFailed ? '失败' : isAsync ? '已派发' : '已完成'
  const statusClass = isRunning
    ? styles['status--running']
    : isFailed
      ? styles['status--failed']
      : styles['status--done']

  const failureText =
    result && typeof result.message === 'string' && result.message.trim()
      ? result.message.trim()
      : '委托执行失败'

  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        title={expanded ? '收起委托详情' : '展开委托详情'}
      >
        <span className={styles.badge}>团队委托</span>
        <span className={styles.expert}>{expertName}</span>
        {isAsync && <span className={styles.modeTag}>后台</span>}
        <span className={`${styles.status} ${statusClass}`}>{statusText}</span>
        <span className={styles.toggle}>{expanded ? '收起' : '详情'}</span>
      </button>

      <div className={styles.task}>{truncate(task, 90)}</div>

      {isRunning && (
        <div className={styles.hint}>
          {isAsync ? '已交给这位专家在后台执行，完成后会自动汇报。' : '正在等待这位专家执行…'}
        </div>
      )}

      {isFailed && <div className={styles.errorText}>{truncate(failureText, 160)}</div>}

      {!isRunning && !isFailed && isAsync && (
        <div className={styles.hint}>已在后台执行，完成后会自动汇报。</div>
      )}

      {!isRunning && !isFailed && !isAsync && output && (
        <div className={styles.summary}>{truncate(firstLine(output), 110)}</div>
      )}

      {expanded && (
        <div className={styles.details}>
          {prompt && (
            <div className={styles.detailBlock}>
              <span className={styles.detailLabel}>任务</span>
              <pre className={styles.detailPre}>{prompt}</pre>
            </div>
          )}
          {!isRunning && !isFailed && !isAsync && output && (
            <div className={styles.detailBlock}>
              <span className={styles.detailLabel}>产出</span>
              <pre className={styles.detailPre}>{output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
