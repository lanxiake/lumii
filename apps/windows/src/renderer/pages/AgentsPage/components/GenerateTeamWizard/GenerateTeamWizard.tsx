/**
 * GenerateTeamWizard — AI 生成 Agent 团队向导主容器
 *
 * 向导状态通过 localStorage 持久化，关闭再打开可恢复上次进度。
 * 完成后清除持久化数据。
 */

import React, { useState, useEffect } from 'react'
import { Step1Requirement } from './Step1Requirement'
import { Step2Planning } from './Step2Planning'
import { Step3Review } from './Step3Review'
import type { GeneratedAgent, CapabilityOption } from './types'
import styles from './GenerateTeamWizard.module.css'

interface WizardProps {
  systemAgents: { id: string; name: string }[]
  capabilityOptions: CapabilityOption[]
  userSkills: { id: string; name: string; description?: string }[]
  onClose: () => void
  onComplete: () => void
}

interface WizardDraft {
  step: 1 | 2 | 3
  requirement: string
  generatedAgents: GeneratedAgent[]
}

function draftKey(userId: string) {
  return `mtbot_generate_team_draft_${userId}`
}

function loadDraft(userId: string): WizardDraft | null {
  try {
    const raw = localStorage.getItem(draftKey(userId))
    if (!raw) return null
    return JSON.parse(raw) as WizardDraft
  } catch {
    return null
  }
}

function saveDraft(userId: string, draft: WizardDraft) {
  try {
    localStorage.setItem(draftKey(userId), JSON.stringify(draft))
  } catch {
    // ignore quota errors
  }
}

function clearDraft(userId: string) {
  localStorage.removeItem(draftKey(userId))
}

export const GenerateTeamWizard: React.FC<WizardProps> = ({
  systemAgents,
  capabilityOptions,
  userSkills,
  onClose,
  onComplete,
}) => {
  // 独立版无账号体系，草稿键固定归属本地用户
  const userId = 'local-user'

  // 挂载时从 localStorage 恢复草稿
  const draft = loadDraft(userId)

  // Step2 streaming 尚未完成不可恢复，有已生成的 agents 则直接到 Step3，否则回到 Step1
  const initialStep: 1 | 2 | 3 = draft
    ? draft.generatedAgents.length > 0
      ? 3
      : 1
    : 1

  const [step, setStep] = useState<1 | 2 | 3>(initialStep)
  const [requirement, setRequirement] = useState(draft?.requirement ?? '')
  const [generatedAgents, setGeneratedAgents] = useState<GeneratedAgent[]>(
    draft?.generatedAgents ?? [],
  )

  // 每当状态变化时持久化草稿
  useEffect(() => {
    if (!requirement && step === 1) return // 空状态不写
    saveDraft(userId, { step, requirement, generatedAgents })
  }, [step, requirement, generatedAgents, userId])

  const handleStep1Next = (req: string) => {
    setRequirement(req)
    setStep(2)
  }

  const handleStep2Next = (agents: GeneratedAgent[]) => {
    setGeneratedAgents(agents)
    setStep(3)
  }

  const handleComplete = () => {
    clearDraft(userId)
    onComplete()
    onClose()
  }

  const handleClose = () => {
    // 中途关闭保留草稿，下次恢复
    onClose()
  }

  return (
    <div className={styles.wizardOverlay} onClick={handleClose}>
      <div className={styles.wizardModal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.wizardHeader}>
          <h2 className={styles.wizardTitle}>✨ AI 生成团队</h2>
          <button className={styles.wizardClose} onClick={handleClose} type="button">
            ✕
          </button>
        </div>
        <div className={styles.wizardBody}>
          {step === 1 && (
            <Step1Requirement initialRequirement={requirement} onNext={handleStep1Next} />
          )}
          {step === 2 && (
            <Step2Planning
              requirement={requirement}
              userSkills={userSkills}
              onBack={() => setStep(1)}
              onNext={handleStep2Next}
            />
          )}
          {step === 3 && (
            <Step3Review
              agents={generatedAgents}
              capabilityOptions={capabilityOptions}
              systemAgents={systemAgents}
              userSkills={userSkills}
              onBack={() => {
                setGeneratedAgents([])
                setStep(2)
              }}
              onComplete={handleComplete}
            />
          )}
        </div>
      </div>
    </div>
  )
}
