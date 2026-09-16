/**
 * Step2Planning — AI 流式生成 Agent 团队（本地 Agent Runtime）
 *
 * 会话与事件编排收在 services/agent-json-task，这里只关心预览与错误态。
 */

import React, { useState, useEffect, useMemo } from 'react'
import type { GeneratedAgent, McpServerOption } from './types'
import { buildPrompt, parseStreamingJson } from './utils'
import { runAgentJsonTask } from '../../../../services/agent-json-task'
import { Bot, AlertTriangle, X } from 'lucide-react'
import styles from './GenerateTeamWizard.module.css'

interface Step2PlanningProps {
  requirement: string
  userSkills: { id: string; name: string; description?: string }[]
  mcpServers: McpServerOption[]
  onBack: () => void
  onNext: (agents: GeneratedAgent[]) => void
}

export const Step2Planning: React.FC<Step2PlanningProps> = ({
  requirement,
  userSkills,
  mcpServers,
  onBack,
  onNext,
}) => {
  const [agents, setAgents] = useState<GeneratedAgent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  /** 与 requirement 一起决定 prompt，序列化避免引用变化导致重复请求 */
  const skillsKey = useMemo(
    () => JSON.stringify(userSkills.map((s) => ({ id: s.id, name: s.name, description: s.description }))),
    [userSkills],
  )
  const mcpKey = useMemo(() => JSON.stringify(mcpServers.map((s) => s.name)), [mcpServers])

  useEffect(() => {
    let settled = false
    setIsLoading(true)
    setError(null)
    setAgents([])

    const task = runAgentJsonTask<GeneratedAgent[]>({
      title: 'AI Team Gen',
      prompt: buildPrompt(requirement, userSkills, mcpServers),
      parse: (text) => {
        const { complete, data } = parseStreamingJson(text)
        return complete ? data : null
      },
      onPartial: (data) => {
        if (!settled) setAgents(data)
      },
    })

    task.done
      .then((data) => {
        if (settled) return
        settled = true
        setIsLoading(false)
        // 流式阶段已经出过结果就保留，避免最终解析覆盖掉用户看到的那份
        setAgents((prev) => (prev.length > 0 ? prev : data))
      })
      .catch((err: Error) => {
        if (settled) return
        settled = true
        setIsLoading(false)
        setError(err.message)
      })

    return () => {
      settled = true
      task.cancel()
    }
  }, [requirement, skillsKey, mcpKey, retryToken])

  const handleRetry = () => {
    setError(null)
    setIsLoading(true)
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
