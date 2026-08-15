/**
 * OptimizeTeamWizard — 对现有 Agent 团队进行集体优化
 *
 * 两步流程：
 * 1. 选择要优化的 Agent + 输入优化方向 + 选择模式
 * 2. AI 流式生成优化版本 → 逐个确认应用
 */

import React, { useState, useEffect, useRef } from 'react'
import type {
  AgentIdleEvent,
  AgentMessageDeltaEvent,
  AgentMessageEndEvent,
  AgentErrorEvent,
} from '@/shared/agent-runtime-events'
import { buildOptimizePrompt, parseStreamingJson } from '../GenerateTeamWizard/utils'
import { Sparkles, AlertTriangle, Check, X, ChevronDown, ChevronUp } from 'lucide-react'
import styles from './OptimizeTeamWizard.module.css'

interface AgentItem {
  id: string
  name: string
  emoji?: string
  description?: string
  systemPrompt?: string
}

interface OptimizedAgent {
  id: string
  name?: string
  description?: string
  systemPrompt?: string
  [key: string]: unknown
}

type OptimizeMode = 'refine' | 'regenerate'
type ApplyStatus = 'pending' | 'applying' | 'success' | 'error' | 'skipped'

interface OptimizeTeamWizardProps {
  userAgents: AgentItem[]
  onClose: () => void
  onComplete: () => void
}

function isSameSession(key: string | undefined, expected: string | null): boolean {
  if (!expected) return false
  return key === expected
}

export const OptimizeTeamWizard: React.FC<OptimizeTeamWizardProps> = ({
  userAgents,
  onClose,
  onComplete,
}) => {
  const [step, setStep] = useState<1 | 2>(1)

  // Step1 state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(userAgents.map((a) => a.id)))
  const [requirement, setRequirement] = useState('')
  const [mode, setMode] = useState<OptimizeMode>('refine')

  // Step2 state
  const [optimized, setOptimized] = useState<OptimizedAgent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applyStatuses, setApplyStatuses] = useState<Record<string, ApplyStatus>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const bufferRef = useRef('')
  const sessionKeyRef = useRef<string | null>(null)

  const selectedAgents = userAgents.filter((a) => selectedIds.has(a.id))

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleGenerate = () => {
    if (selectedAgents.length === 0 || !requirement.trim()) return
    setStep(2)
  }

  // 流式生成优化版本
  useEffect(() => {
    if (step !== 2) return

    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand || !api.onEventType) {
      setError('客户端 Agent 运行时不可用')
      return
    }

    let cancelled = false
    let finished = false
    const unsubs: Array<() => void> = []

    const closeSession = async () => {
      const sk = sessionKeyRef.current
      sessionKeyRef.current = null
      if (!sk) return
      try { await api.sendCommand({ type: 'conversation:close', sessionKey: sk }) } catch { /* ignore */ }
    }

    const run = async () => {
      setIsLoading(true)
      setError(null)
      bufferRef.current = ''
      setOptimized([])

      try {
        const created = (await api.sendCommand({ type: 'conversation:create', title: 'AI Team Optimize' })) as { sessionKey: string }
        if (cancelled) { await api.sendCommand({ type: 'conversation:close', sessionKey: created.sessionKey }); return }
        sessionKeyRef.current = created.sessionKey

        const onDelta = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentMessageDeltaEvent
          if (!isSameSession(e.sessionKey, sessionKeyRef.current)) return
          bufferRef.current += e.delta
          const { complete, data } = parseStreamingJson(bufferRef.current)
          if (complete && data) setOptimized(data as unknown as OptimizedAgent[])
        }

        const onIdle = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentIdleEvent
          if (!isSameSession(e.sessionKey, sessionKeyRef.current)) return
          finished = true
          setIsLoading(false)
          void closeSession()
        }

        const onAgentError = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentErrorEvent
          if (!isSameSession(e.sessionKey, sessionKeyRef.current)) return
          finished = true
          setError(e.errorMessage || 'Agent 运行错误')
          setIsLoading(false)
          void closeSession()
        }

        const onMessageEnd = (raw: unknown) => {
          if (cancelled || finished) return
          const e = raw as AgentMessageEndEvent
          if (!isSameSession(e.sessionKey, sessionKeyRef.current)) return
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

        const prompt = buildOptimizePrompt(
          selectedAgents.map((a) => ({ id: a.id, name: a.name, description: a.description, systemPrompt: a.systemPrompt })),
          requirement,
          mode,
        )
        await api.sendCommand({ type: 'user:send', sessionKey: sessionKeyRef.current!, content: prompt })
        if (cancelled) await closeSession()
      } catch (err) {
        if (!cancelled) { setError(err instanceof Error ? err.message : '发送失败'); setIsLoading(false) }
        await closeSession()
      }
    }

    void run()
    return () => {
      cancelled = true
      for (const u of unsubs) u()
      void closeSession()
    }
  }, [step])

  const handleApplyAll = async () => {
    if (optimized.length === 0) return
    setIsApplying(true)

    for (const item of optimized) {
      if (!item.id) continue
      setApplyStatuses((prev) => ({ ...prev, [item.id]: 'applying' }))
      try {
        const patch: Record<string, unknown> = {}
        if (item.name) patch.name = item.name
        if (item.description) patch.description = item.description
        if (item.systemPrompt) patch.systemPrompt = item.systemPrompt
        await window.electronAPI.api.updateAgent(item.id, patch as any)
        setApplyStatuses((prev) => ({ ...prev, [item.id]: 'success' }))
      } catch {
        setApplyStatuses((prev) => ({ ...prev, [item.id]: 'error' }))
      }
    }

    setIsApplying(false)
    setTimeout(() => onComplete(), 800)
  }

  const handleSkip = (id: string) => {
    setApplyStatuses((prev) => ({ ...prev, [id]: 'skipped' }))
  }

  const allHandled = optimized.length > 0 && optimized.every((o) => o.id && ['success', 'error', 'skipped'].includes(applyStatuses[o.id] ?? ''))

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}><Sparkles size={16} /> 优化 AI 团队</h3>
          <button className={styles.closeBtn} onClick={onClose} type="button"><X size={14} /></button>
        </div>

        <div className={styles.body}>
          {step === 1 && (
            <div className={styles.step1}>
              <div className={styles.section}>
                <div className={styles.sectionLabel}>选择要优化的 Agent（{selectedIds.size}/{userAgents.length}）</div>
                <div className={styles.agentList}>
                  {userAgents.map((agent) => (
                    <div
                      key={agent.id}
                      className={`${styles.agentItem} ${selectedIds.has(agent.id) ? styles.agentItemSelected : ''}`}
                      onClick={() => toggleSelect(agent.id)}
                    >
                      <span className={styles.agentItemEmoji}>{agent.emoji ?? ''}</span>
                      <span className={styles.agentItemName}>{agent.name}</span>
                      {selectedIds.has(agent.id) && <Check size={12} className={styles.checkIcon} />}
                    </div>
                  ))}
                </div>
              </div>

              <div className={styles.section}>
                <div className={styles.sectionLabel}>优化方向</div>
                <textarea
                  className={styles.textarea}
                  placeholder="描述你希望如何优化这些 Agent，例如：让所有 Agent 更专注于安全性，或者优化描述让用户更容易理解何时使用..."
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  rows={3}
                />
              </div>

              <div className={styles.section}>
                <div className={styles.sectionLabel}>优化模式</div>
                <div className={styles.modeGroup}>
                  <label className={`${styles.modeOption} ${mode === 'refine' ? styles.modeOptionActive : ''}`}>
                    <input type="radio" value="refine" checked={mode === 'refine'} onChange={() => setMode('refine')} />
                    <div>
                      <div className={styles.modeTitle}>追加优化</div>
                      <div className={styles.modeDesc}>在现有基础上改进，保持核心职责不变</div>
                    </div>
                  </label>
                  <label className={`${styles.modeOption} ${mode === 'regenerate' ? styles.modeOptionActive : ''}`}>
                    <input type="radio" value="regenerate" checked={mode === 'regenerate'} onChange={() => setMode('regenerate')} />
                    <div>
                      <div className={styles.modeTitle}>重新生成</div>
                      <div className={styles.modeDesc}>完全重写，适合大幅调整方向</div>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className={styles.step2}>
              {isLoading && optimized.length === 0 && (
                <div className={styles.loading}>
                  <Sparkles size={32} className={styles.loadingIcon} />
                  <div className={styles.loadingText}>AI 正在优化团队...</div>
                </div>
              )}

              {error && (
                <div className={styles.errorState}>
                  <AlertTriangle size={32} />
                  <div className={styles.errorText}>{error}</div>
                  <button className={styles.retryBtn} onClick={() => { setStep(1); setError(null) }} type="button">返回重试</button>
                </div>
              )}

              {optimized.length > 0 && (
                <div className={styles.diffList}>
                  {optimized.map((item) => {
                    const original = userAgents.find((a) => a.id === item.id)
                    const status = applyStatuses[item.id] ?? 'pending'
                    const isExpanded = expandedId === item.id
                    return (
                      <div key={item.id} className={`${styles.diffCard} ${styles[`diffCard--${status}`]}`}>
                        <div className={styles.diffHeader} onClick={() => setExpandedId(isExpanded ? null : item.id)}>
                          <span className={styles.diffEmoji}>{original?.emoji ?? ''}</span>
                          <span className={styles.diffName}>{item.name ?? original?.name}</span>
                          <span className={`${styles.diffStatus} ${styles[`diffStatus--${status}`]}`}>
                            {status === 'pending' && '待应用'}
                            {status === 'applying' && '应用中...'}
                            {status === 'success' && '✓ 已应用'}
                            {status === 'error' && '✗ 失败'}
                            {status === 'skipped' && '已跳过'}
                          </span>
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </div>
                        {isExpanded && (
                          <div className={styles.diffBody}>
                            {item.description && item.description !== original?.description && (
                              <div className={styles.diffField}>
                                <div className={styles.diffFieldLabel}>描述</div>
                                <div className={styles.diffOld}>{original?.description}</div>
                                <div className={styles.diffNew}>{item.description}</div>
                              </div>
                            )}
                            {item.systemPrompt && item.systemPrompt !== original?.systemPrompt && (
                              <div className={styles.diffField}>
                                <div className={styles.diffFieldLabel}>系统提示词</div>
                                <div className={styles.diffOld}>{original?.systemPrompt?.slice(0, 200)}...</div>
                                <div className={styles.diffNew}>{String(item.systemPrompt).slice(0, 200)}...</div>
                              </div>
                            )}
                            {status === 'pending' && (
                              <button className={styles.skipBtn} onClick={() => handleSkip(item.id)} type="button">跳过此项</button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          {step === 1 && (
            <>
              <button className={styles.cancelBtn} onClick={onClose} type="button">取消</button>
              <button
                className={styles.primaryBtn}
                onClick={handleGenerate}
                disabled={selectedIds.size === 0 || !requirement.trim()}
                type="button"
              >
                开始优化
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button className={styles.cancelBtn} onClick={() => setStep(1)} disabled={isApplying} type="button">上一步</button>
              <button
                className={styles.primaryBtn}
                onClick={handleApplyAll}
                disabled={isLoading || isApplying || optimized.length === 0 || allHandled}
                type="button"
              >
                {isApplying ? '应用中...' : '全部应用'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
