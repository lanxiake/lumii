/**
 * Step3Review — 精简编辑 + 批量创建
 */

import React, { useState } from 'react'
import type { GeneratedAgent, GeneratedAgentForm, CapabilityOption } from './types'
import { capabilitiesToSkillBlacklist, encodeGroupToDescription } from './utils'
import styles from './GenerateTeamWizard.module.css'

interface Step3ReviewProps {
  agents: GeneratedAgent[]
  capabilityOptions: CapabilityOption[]
  systemAgents: { id: string; name: string }[]
  userSkills: { id: string; name: string; description?: string }[]
  onBack: () => void
  onComplete: () => void
}

export const Step3Review: React.FC<Step3ReviewProps> = ({
  agents,
  capabilityOptions,
  systemAgents,
  userSkills,
  onBack,
  onComplete,
}) => {
  const [forms, setForms] = useState<GeneratedAgentForm[]>(
    agents.map((agent) => ({ ...agent, status: 'pending' as const })),
  )
  const [isCreating, setIsCreating] = useState(false)

  const updateForm = (index: number, patch: Partial<GeneratedAgentForm>) => {
    setForms((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }

  const handleCreateAll = async () => {
    const firstSystemAgentId = systemAgents[0]?.id
    if (!firstSystemAgentId) return

    setIsCreating(true)

    for (let i = 0; i < forms.length; i++) {
      const form = forms[i]
      updateForm(i, { status: 'creating' })

      try {
        const forkResp = await window.electronAPI.api.forkAgent(firstSystemAgentId, {
          name: form.name,
          description: form.description,
          systemPrompt: form.systemPrompt,
        } as any)

        // forkAgent 返回 ApiResponse<Agent>，需从 .data 中取 id
        const newAgentId: string | undefined =
          (forkResp as any)?.data?.id ?? (forkResp as any)?.id

        if (!newAgentId) throw new Error('Fork Agent 未返回有效 id')

        const enabledIds = new Set(form.capabilities)
        const skillBlacklist = capabilitiesToSkillBlacklist(enabledIds, capabilityOptions)

        // AI 返回的 skills 是技能 id（如 writing-plans），需映射为 name（编辑页面以 name 匹配）
        const skillIdToName = new Map(userSkills.map((s) => [s.id, s.name]))
        const skillFilterNames = (form.skills ?? [])
          .map((id) => skillIdToName.get(id))
          .filter((n): n is string => !!n)

        await window.electronAPI.api.updateAgent(newAgentId, {
          systemPrompt: form.systemPrompt,
          skillBlacklist: skillBlacklist.length > 0 ? skillBlacklist : null,
          skillFilter: skillFilterNames.length > 0 ? skillFilterNames : null,
          modelTier: form.modelTier,
        } as any)

        // 将分组信息写入 description 末尾（用于后续展示分组标识）
        if (form.groupId) {
          await window.electronAPI.api.updateAgent(newAgentId, {
            description: encodeGroupToDescription(form.description, form.groupId, form.groupName, form.groupRole),
          } as any)
        }

        updateForm(i, { id: newAgentId, status: 'success' })
      } catch {
        updateForm(i, { status: 'error' })
      }
    }

    setTimeout(() => onComplete(), 800)
  }

  const allDone = forms.every((f) => f.status === 'success' || f.status === 'error')

  return (
    <div className={styles.stepContainer}>
      <div className={styles.stepHeader}>
        <h3 className={styles.stepTitle}>确认并创建 Agent</h3>
        <p className={styles.stepDesc}>检查每个 Agent 的信息，然后批量创建</p>
      </div>

      <div className={styles.stepContent}>
        <div className={styles.agentEditGrid}>
          {forms.map((form, index) => (
            <div
              key={index}
              className={
                form.status === 'success' ? styles.agentEditCardSuccess : styles.agentEditCard
              }
            >
              <div className={styles.agentEditHeader}>
                <div className={styles.agentEmoji}>{form.emoji}</div>
                <div className={styles.agentEditName}>
                  <input
                    className={styles.nameInput}
                    value={form.name}
                    onChange={(e) => updateForm(index, { name: e.target.value })}
                    disabled={form.status !== 'pending'}
                  />
                </div>
                {form.status === 'creating' && (
                  <span className={styles.statusText} style={{ color: 'var(--mt-fg-3, var(--color-text-secondary))' }}>
                    创建中...
                  </span>
                )}
                {form.status === 'success' && (
                  <span className={styles.statusText} style={{ color: 'var(--mt-success, var(--color-success))' }}>
                    已创建
                  </span>
                )}
                {form.status === 'error' && (
                  <span className={styles.statusText} style={{ color: 'var(--mt-error-light, var(--color-error))' }}>
                    失败
                  </span>
                )}
              </div>

              <div className={styles.agentEditField}>
                <label className={styles.editLabel}>描述</label>
                <input
                  className={styles.editInput}
                  value={form.description}
                  onChange={(e) => updateForm(index, { description: e.target.value })}
                  disabled={form.status !== 'pending'}
                />
              </div>

              <div className={styles.agentEditField}>
                <label className={styles.editLabel}>系统提示词</label>
                <textarea
                  className={styles.editTextarea}
                  value={form.systemPrompt}
                  onChange={(e) => updateForm(index, { systemPrompt: e.target.value })}
                  rows={4}
                  disabled={form.status !== 'pending'}
                />
              </div>

              <div className={styles.configRow}>
                <div className={styles.modelTierBadge}>{form.modelTier}</div>
                <span className={styles.hint}>模型配置（创建后可调整）</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.stepFooter}>
        <button
          className={styles.backButton}
          onClick={onBack}
          disabled={isCreating}
          type="button"
        >
          上一步
        </button>
        <span className={styles.stepIndicator}>3 / 3</span>
        <button
          className={styles.createButton}
          onClick={handleCreateAll}
          disabled={isCreating || allDone}
          type="button"
        >
          {isCreating ? '创建中...' : '创建全部 Agent'}
        </button>
      </div>
    </div>
  )
}
