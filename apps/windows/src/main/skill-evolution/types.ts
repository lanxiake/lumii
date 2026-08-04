/**
 * 技能自进化系统 — 核心类型定义
 */

export type SkillLifecycleState =
  | 'draft'            // 系统生成，未告知用户
  | 'pending_confirm'  // 已告知用户，等待确认
  | 'active'           // 用户确认，正常使用
  | 'deprecated'       // 用户废弃
  | 'rejected'         // 用户拒绝创建

export interface SkillMeta {
  version: string                  // semver，如 "1.0.2"
  createdAt: string                // ISO 8601
  sourceType: 'auto_extracted' | 'manual'
  state: SkillLifecycleState
  trustScore: number               // 0.0 ~ 1.0，非对称更新
  useCount: number
  feedbackStats: {
    positive: number
    partial: number
    negative: number
  }
  consecutiveNegative: number      // 连续负面反馈次数，熔断用
  evolutionHistory: EvolutionRecord[]
}

export interface EvolutionRecord {
  version: string
  at: string
  reason: string
  userFeedback?: string            // 用户原话
  patchOldString?: string          // 局部 Patch：原内容
  patchNewString?: string          // 局部 Patch：新内容
}

export interface HumanSummary {
  title: string                    // 如 "Git PR 审查"
  scenario: string                 // 适用场景，一句话
  steps: string[]                  // 步骤列表，自然语言
}

export interface SkillDraft {
  id: string                       // uuid
  skillMd: string                  // 生成的 SKILL.md 内容
  humanSummary: HumanSummary       // 用户友好摘要
  qualityScore: number             // 0-100
  createdAt: string
  category?: string                // 分类目录名（kebab-case），如 "内容创作与发布"
}

export type EvolutionEvent =
  | { type: 'skill_draft_ready'; draft: SkillDraft }
  | { type: 'improvement_ready'; skillName: string; naturalLanguageDiff: string }
  | { type: 'deprecation_suggested'; skillName: string; humanTitle: string }
  | { type: 'feedback_requested'; skillName: string; humanTitle: string }

/** LLM 调用函数签名（instanceId 供调用方选择合适的 stream） */
export type LLMCaller = (prompt: string, instanceId?: string) => Promise<string>

/** 对话消息（与 pi-agent-core AgentMessage 兼容的最小子集） */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolName?: string
}
