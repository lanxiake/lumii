/**
 * Step2Planning — AI 流式生成 Agent 团队（本地 Agent Runtime）
 *
 * 使用临时会话：conversation:create → user:send → 监听 delta/idle → conversation:close
 */

import React, { useState, useEffect, useRef, useMemo } from 'react'
import type {
  AgentIdleEvent,
  AgentMessageDeltaEvent,
  AgentMessageEndEvent,
  AgentErrorEvent,
} from '@/shared/agent-runtime-events'
import type { GeneratedAgent } from './types'
import { buildPrompt, parseStreamingJson } from './utils'
import { Bot, AlertTriangle, X } from 'lucide-react'
import styles from './GenerateTeamWizard.module.css'

interface Step2PlanningProps {
  requirement: string
  userSkills: { id: string; name: string; description?: string }[]
  onBack: () => void
  onNext: (agents: GeneratedAgent[]) => void
}

/** 判断事件是否属于当前临时会话（避免与聊天页等并发运行串台） */
function isSameSession(
  eventSessionKey: string | undefined,
  expected: string | null,
): boolean {
  if (!expected) return false
  return eventSessionKey === expected
}

export const Step2Planning: React.FC<Step2PlanningProps> = ({
  requirement,
  userSkills,
  onBack,
  onNext,
}) => {
  const [agents, setAgents] = useState<GeneratedAgent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const bufferRef = useRef('')
  const lastTextRef = useRef('')

  /** 与 requirement 一起决定 prompt，序列化避免引用变化导致重复请求 */
  const skillsKey = useMemo(
    () => JSON.stringify(userSkills.map((s) => ({ id: s.id, name: s.name, description: s.description }))),
    [userSkills],
  )

  useEffect(() => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand || !api.onEventType) {
      setError('客户端 Agent 运行时不可用')
      setIsLoading(false)
      return
    }

    let cancelled = false
    let finished = false
    let sessionKey: string | null = null
    const unsubs: Array<() => void> = []

    const closeSession = async () => {
      const sk = sessionKey
      sessionKey = null
      if (!sk) return
      try {
        await api.sendCommand({ type: 'conversation:close', sessionKey: sk })
      } catch {
        // 关闭失败不影响 UI
      }
    }

    const onTurnFinished = () => {
      if (cancelled || finished) return
      finished = true
      setIsLoading(false)
      setAgents((prev) => {
        if (prev.length > 0) return prev
        const { complete, data } = parseStreamingJson(lastTextRef.current)
        if (complete && data) {
          return data
        }
        const raw = lastTextRef.current.trim()
        setError(raw || 'AI 返回格式异常，请重试')
        return prev
      })
      void closeSession()
    }

    const run = async () => {
      try {
        setIsLoading(true)
        setError(null)
        bufferRef.current = ''
        lastTextRef.current = ''
        setAgents([])

        const created = (await api.sendCommand({
          type: 'conversation:create',
          title: 'AI Team Gen',
        })) as { sessionKey: string }

        if (cancelled) {
          await api.sendCommand({ type: 'conversation:close', sessionKey: created.sessionKey })
          return
        }
        sessionKey = created.sessionKey

        const onDelta = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentMessageDeltaEvent
          if (!isSameSession(e.sessionKey, sessionKey)) return
          bufferRef.current += e.delta
          lastTextRef.current = bufferRef.current
          const { complete, data } = parseStreamingJson(bufferRef.current)
          if (complete && data) {
            setAgents(data)
          }
        }

        const onIdle = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentIdleEvent
          if (!isSameSession(e.sessionKey, sessionKey)) return
          onTurnFinished()
        }

        const onAgentError = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentErrorEvent
          if (!isSameSession(e.sessionKey, sessionKey)) return
          finished = true
          setError(e.errorMessage || 'Agent 运行错误')
          setIsLoading(false)
          void closeSession()
        }

        const onMessageEnd = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentMessageEndEvent
          if (!isSameSession(e.sessionKey, sessionKey)) return
          if (e.stopReason === 'error' || e.llmError) {
            finished = true
            setError(e.llmError?.message ?? '模型调用失败')
            setIsLoading(false)
            void closeSession()
          }
        }

        unsubs.push(api.onEventType('agent:message:delta', onDelta))
        unsubs.push(api.onEventType('agent:idle', onIdle))
        unsubs.push(api.onEventType('agent:error', onAgentError))
        unsubs.push(api.onEventType('agent:message:end', onMessageEnd))

        const prompt = buildPrompt(requirement, userSkills)
        await api.sendCommand({
          type: 'user:send',
          sessionKey: sessionKey!,
          content: prompt,
        })

        if (cancelled) {
          await closeSession()
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '发送失败')
          setIsLoading(false)
        }
        await closeSession()
      }
    }

    void run()

    return () => {
      cancelled = true
      for (const u of unsubs) {
        u()
      }
      void closeSession()
    }
  }, [requirement, skillsKey, retryToken])

  const handleRetry = () => {
    setError(null)
    setIsLoading(true)
    bufferRef.current = ''
    lastTextRef.current = ''
    setAgents([])
    setRetryToken((t) => t + 1)
  }

  const handleRemoveAgent = (index: number) => {
    setAgents((prev) => prev.filter((_, i) => i !== index))
  }

  if (error) {
    return (
      <div className={styles.stepContainer}>
        <div className={styles.errorState}>
          <div className={styles.errorIcon}><AlertTriangle size={48} /></div>
          <div className={styles.errorMessage}>{error}</div>
          <button className={styles.retryButton} onClick={handleRetry} type="button">
            重新生成
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.stepContainer}>
      <div className={styles.stepHeader}>
        <h3 className={styles.stepTitle}>AI 正在规划团队</h3>
        <p className={styles.stepDesc}>正在分析你的需求，实时生成 Agent 角色...</p>
      </div>

      <div className={styles.stepContent}>
        {isLoading && agents.length === 0 ? (
          <div className={styles.planningLoading}>
            <div className={styles.loadingAnimation}><Bot size={48} /></div>
            <div className={styles.loadingText}>AI 正在思考...</div>
          </div>
        ) : (
          <div className={styles.agentPreviewGrid}>
            {agents.map((agent, idx) => (
              <div key={idx} className={styles.agentPreviewCard}>
                <div className={styles.agentPreviewHeader}>
                  <div className={styles.agentEmoji}>{agent.emoji}</div>
                  <div className={styles.agentInfo}>
                    <div className={styles.agentName}>{agent.name}</div>
                    <div className={styles.agentDesc}>{agent.description}</div>
                  </div>
                  <button
                    className={styles.removeButton}
                    onClick={() => handleRemoveAgent(idx)}
                    type="button"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className={styles.agentMeta}>
                  <div className={styles.modelBadge}>{agent.modelTier}</div>
                  <div className={styles.capabilityCount}>{agent.capabilities.length} 项能力</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.stepFooter}>
        <button className={styles.backButton} onClick={onBack} type="button">
          上一步
        </button>
        <span className={styles.stepIndicator}>2 / 3</span>
        <button
          className={styles.nextButton}
          onClick={() => onNext(agents)}
          disabled={isLoading || agents.length === 0}
          type="button"
        >
          确认角色，进入编辑
        </button>
      </div>
    </div>
  )
}
