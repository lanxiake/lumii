/**
 * Pre-LLM Router 类型定义
 *
 * 详见 .qoder/design/Agent-Skill编排优化/02-技术设计.md §2.1
 */

/** 最近对话轮次摘要 */
export interface TurnSummary {
  /** 'user' / 'assistant' */
  readonly role: "user" | "assistant"
  /** 消息内容（已截断到 200 字符） */
  readonly content: string
}

/** Router 输入：Agent 候选信息 */
export interface RouterAgentInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly triggerExamples?: readonly string[]
  readonly category?: string
  readonly emoji?: string
}

/** Router 输入：Skill 候选信息 */
export interface RouterSkillInfo {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
}

/** Router 主入口的输入 */
export interface RouterInput {
  /** 当前轮用户原始输入 */
  readonly userInput: string
  /** 最近 N 轮对话摘要（≤ 3 条，可选） */
  readonly recentTurns?: readonly TurnSummary[]
  /** 全部可用 Agent */
  readonly availableAgents: readonly RouterAgentInfo[]
  /** 全部可用 Skill */
  readonly availableSkills: readonly RouterSkillInfo[]
}

/** Router 输出的单个候选项 */
export interface RouterCandidate {
  /** Agent ID 或 Skill ID */
  readonly id: string
  /** 评分 0-1 */
  readonly score: number
  /** 短句解释，≤ 80 字符，用户可见 */
  readonly reason: string
}

/** Router 失败降级原因 */
export type RouterFallback = "timeout" | "parse_error" | "llm_error" | "none"

/** Router 主出口 */
export interface RouterResult {
  /** 意图标签，自由文本，仅用于日志/统计 */
  readonly intent: string
  /** 置信度 0-1 */
  readonly confidence: number
  /** 推荐 Agent，≤ 3 个，按 score 降序 */
  readonly topAgents: readonly RouterCandidate[]
  /** 推荐 Skill，≤ 5 个，按 score 降序 */
  readonly topSkills: readonly RouterCandidate[]
  /** 是否需要反问用户澄清 */
  readonly needsClarification: boolean
  /** 反问问题（needsClarification=true 时存在） */
  readonly clarifyQuestion?: string
  /** 反问选项（≤ 4 个） */
  readonly clarifyOptions?: readonly string[]
  /** Router 调用耗时（ms） */
  readonly durationMs: number
  /** 是否降级 */
  readonly fallback: RouterFallback
}

/**
 * 将完整 RouterResult 转为 system-prompt-builder 需要的 lite 子集。
 * （主 prompt 构建器不关心 needsClarification / durationMs 等字段）
 */
export function toRouterResultLite(result: RouterResult): {
  readonly confidence: number
  readonly fallback: RouterFallback
  readonly intent: string
  readonly topAgents: ReadonlyArray<{ readonly id: string; readonly score: number; readonly reason: string }>
  readonly topSkills: ReadonlyArray<{ readonly id: string; readonly score: number; readonly reason: string }>
  readonly needsClarification: boolean
  readonly clarifyQuestion?: string
  readonly clarifyOptions?: ReadonlyArray<string>
} {
  return {
    confidence: result.confidence,
    fallback: result.fallback,
    intent: result.intent,
    topAgents: result.topAgents.map((c) => ({ id: c.id, score: c.score, reason: c.reason })),
    topSkills: result.topSkills.map((c) => ({ id: c.id, score: c.score, reason: c.reason })),
    needsClarification: result.needsClarification,
    clarifyQuestion: result.clarifyQuestion,
    clarifyOptions: result.clarifyOptions,
  }
}
