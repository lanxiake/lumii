/**
 * 团队委托卡片（队长制）
 *
 * 主助手调用 spawn_agent 委托专家后，消息里渲染此卡片：谁在干 + 任务 + 状态 + 结果摘要。
 * 与转交卡片（propose_dev_handoff）同理，永远露在过程折叠区之外——
 * 委托是用户判断「团队此刻在干什么」的主要线索，被折叠进「调用 1 次工具」等于隐形。
 * 数据全部来自工具 part（args + jsonToolResult），历史回放可完整重现，无需额外事件链。
 *
 * 子 Agent 的执行过程（2026-09-14 起，见 docs/plans/专项Agent/08-委托可见性.md §4）：
 * 由 `runs` 传入、渲染在卡片下方。此前子消息的 parts 被拼接进父气泡，
 * 导致父的「执行过程」被污染且两个思考块同时显活；现在子过程只在这里出现。
 */

import React, { useMemo, useState } from 'react'
import { resolveBuiltinDisplayName } from '@mtbot/agent-runtime/browser'
import { SubAgentRunBlock } from '../SubAgentRun'
import type { SubAgentRun } from '../ChatContainer/sub-agent-runs'
import styles from './SpawnAgentCard.module.css'

interface SpawnToolPart {
  id: string
  args?: Record<string, unknown>
  result?: unknown
  status?: string
  isError?: boolean
}

export interface SpawnResultPayload {
  status?: string
  instanceId?: string
  mode?: string
  /** 规范化定义 id / 权威显示名（orchestrator 按定义解析后回传） */
  agentDefinitionId?: string
  agentName?: string
  output?: string
  message?: string
}

/** 从 jsonToolResult 的 content text 块取原始文本（成功与失败包装格式一致） */
function extractSpawnResultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const first = content.find(
        (c): c is { type?: string; text: string } =>
          !!c && typeof c === 'object' && (c as { type?: string }).type === 'text'
            && typeof (c as { text?: unknown }).text === 'string',
      )
      if (first) return first.text
    }
  }
  return undefined
}

/** 从 jsonToolResult 的 content text 块解析委托结果（与 HandoffCard 同一包装格式） */
export function parseSpawnResult(result: unknown): SpawnResultPayload | null {
  const text = extractSpawnResultText(result)
  if (!text) return null
  try {
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

export interface SpawnAgentCardProps {
  part: SpawnToolPart
  /**
   * 本条消息是否仍在流式输出。
   *
   * 判「执行中」的必要条件：`tool` part 的状态在中止/重启后会永久停在 `running`
   * （`finalizeAssistantParts` 只收尾 thinking/text），单看 `part.status` 会让卡片
   * 一直显示「执行中」。见 docs/plans/专项Agent/08-委托可见性.md §5。
   *
   * `undefined` = 未知（直接使用本组件时）→ 保持旧的宽松判据。
   */
  messageStreaming?: boolean
  /**
   * 本次委托对应子实例的运行轨迹（由 ChatMessage 按 result.instanceId 认领后传入）。
   * 渲染在卡片下方——这就是「被委派 Agent 的执行过程」的唯一落点。
   */
  runs?: readonly SubAgentRun[]
  /** 渲染某个子运行的轨迹正文（由 ChatMessage 提供，复用父回合的时间线渲染器） */
  renderRunBody?: (run: SubAgentRun) => React.ReactNode
}

export const SpawnAgentCard: React.FC<SpawnAgentCardProps> = ({
  part,
  messageStreaming,
  runs,
  renderRunBody,
}) => {
  const [expanded, setExpanded] = useState(false)

  const result = useMemo(() => parseSpawnResult(part.result), [part.result])
  /**
   * 结果原文。失败时主进程不一定回 JSON 载荷——`spawn_agent` 未注册时结果是裸文本
   * 「Tool spawn_agent not found」，parseSpawnResult 解析失败返回 null，但失败原因
   * 恰恰就在这段文本里（2026-09-19：子 Agent 试图再委派，卡片只见「委托执行失败」）。
   */
  const rawResultText = useMemo(
    () => extractSpawnResultText(part.result)?.trim() ?? '',
    [part.result],
  )

  const args = part.args ?? {}
  const agentType = typeof args.agentType === 'string' ? args.agentType.trim() : ''
  const rawName = typeof args.name === 'string' ? args.name.trim() : ''
  /**
   * 专家名解析优先级：
   * 1. 工具结果里的权威名 —— 主进程按定义解析，用户自建 Agent 也有名（最可靠）
   * 2. agentType 经内置表解析 —— 覆盖 `default`（→系统默认）与 `builtin:*`，
   *    这两类此前查表落空，卡片会退化成模型自填的 args.name（一串编码）
   * 3. 模型自填的 args.name —— 仅历史消息走这里（改动前的结果没有 agentName 字段）
   * 4. agentType 原样 → 兜底文案
   */
  const expertName =
    result?.agentName?.trim() ||
    resolveBuiltinDisplayName(agentType) ||
    rawName ||
    agentType ||
    '子 Agent'
  const isAsync = args.mode === 'async'
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  const task =
    (typeof args.description === 'string' && args.description.trim()) ||
    firstLine(prompt) ||
    '未提供任务描述'

  /**
   * 是否仍在执行：没有结果 + part 仍在跑 + 没有「消息已结束」的反证。
   * `messageStreaming === false` 是中止/重启残留的确定信号 —— 此时委托不会再有下文。
   */
  const hasResult = part.result !== undefined
  const isRunning = !hasResult && part.status === 'running' && messageStreaming !== false
  /**
   * 中断残留：既没有结果，消息也已不在流式。主动中断不是失败，单独成态。
   * 有结果但 `status === 'aborted'` 同样是中断——orchestrator 现已把被中止的委托
   * 标为独立终态（此前照常返回 ok，卡片显示「已完成」，2026-09-20 冒烟实测）。
   */
  const isInterrupted = (!hasResult && !isRunning) || result?.status === 'aborted'
  const isFailed = !isRunning && !isInterrupted && (part.isError === true || result?.status === 'error')
  const output = typeof result?.output === 'string' ? result.output.trim() : ''

  const statusText = isRunning
    ? '执行中'
    : isInterrupted
      ? '已中断'
      : isFailed
        ? '失败'
        : isAsync
          ? '已派发'
          : '已完成'
  const statusClass = isRunning
    ? styles['status--running']
    : isInterrupted
      ? styles['status--interrupted']
      : isFailed
        ? styles['status--failed']
        : styles['status--done']

  const failureText =
    result && typeof result.message === 'string' && result.message.trim()
      ? result.message.trim()
      : rawResultText || '委托执行失败'

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

      {/* 中断不是失败：文案要说明「不会有下文」，并提示出路是重新委托 */}
      {isInterrupted && (
        <div className={styles.hint}>本次委托已中断，没有产出。需要的话请重新委托。</div>
      )}

      {!isRunning && !isInterrupted && !isFailed && isAsync && (
        <div className={styles.hint}>已在后台执行，完成后会自动汇报。</div>
      )}

      {!isRunning && !isInterrupted && !isFailed && !isAsync && output && (
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
          {/* 失败原因给全文（折叠行的 160 字截断可能正好吃掉关键信息） */}
          {isFailed && (
            <div className={styles.detailBlock}>
              <span className={styles.detailLabel}>失败原因</span>
              <pre className={styles.detailPre}>{failureText}</pre>
            </div>
          )}
          {!isRunning && !isInterrupted && !isFailed && !isAsync && output && (
            <div className={styles.detailBlock}>
              <span className={styles.detailLabel}>产出</span>
              <pre className={styles.detailPre}>{output}</pre>
            </div>
          )}
        </div>
      )}

      {/* 该专家的执行过程：常驻卡片下方（自身可折叠），不再混进父气泡 */}
      {runs && runs.length > 0 && renderRunBody && (
        <div className={styles.runs}>
          {runs.map((run) => (
            <SubAgentRunBlock key={run.instanceId} run={run} embedded>
              {renderRunBody(run)}
            </SubAgentRunBlock>
          ))}
        </div>
      )}
    </div>
  )
}
