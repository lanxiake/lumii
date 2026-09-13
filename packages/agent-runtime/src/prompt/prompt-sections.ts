/**
 * 系统提示词段元数据表（提示词风格实验 P0-T2）
 *
 * 稳定段 ID 用于：段级计量（sectionStats）、宿主调试日志、terse 引导句
 * （`prompt_guide(section: "<id>")`）与实验页只读清单。一经发布不可改名。
 *
 * 渲染函数仍留在 system-prompt-builder.ts / sections/*.ts 原处，
 * 本表只承载元数据（id / 分组 / 分区 / terse 支持 / 展开方式）——
 * 不做「渲染函数迁入注册表」的完整重构（见实施计划 §0.4 修订 1）。
 */

export type PromptSectionGroup =
  | "identity"
  | "rules"
  | "capabilities"
  | "collaboration"
  | "memory"
  | "runtime"
  | "channel"

export type PromptSectionId =
  // —— 静态段 ——
  | "identity"
  | "permissionMode"
  | "tooling"
  | "systemRules"
  | "toolPreference"
  | "operatingPrinciples"
  | "bundledCapabilities"
  | "progressUpdates"
  | "verification"
  | "toolNamingContract"
  | "progressiveLoading"
  | "mcp"
  | "skills"
  | "selfLearning"
  | "taskOrchestration"
  | "subagentRole"
  | "agentCollaboration"
  | "deviceControl"
  | "safety"
  | "language"
  | "taskCompletion"
  | "messaging"
  | "wiki"
  | "browser"
  | "cron"
  | "fileOutput"
  | "silentReplies"
  // —— 动态段 ——
  | "memory"
  | "workspace"
  | "projectContext"
  | "userDevices"
  | "activeTasks"
  | "runtime"
  | "contextManagement"
  | "skillActivation"
  | "routingRationale"
  | "criticalReminder"

/** 展开方式：terse 段引导句指向的展开路径 */
export type PromptExpandRoute = "prompt-guide" | "existing-tool"

export interface PromptSectionMeta {
  readonly id: PromptSectionId
  readonly group: PromptSectionGroup
  readonly zone: "static" | "dynamic"
  /**
   * 是否具备 terse 渲染（首批 5 段已落地：operatingPrinciples / progressiveLoading /
   * fileOutput / browser / messaging；其余段 P2 覆盖）。
   * 红线段（safety / verification / language / taskCompletion）永久 false。
   */
  readonly terse: boolean
  /** 展开方式（terse 为 true 时必填） */
  readonly expandVia?: PromptExpandRoute
}

/** 单段计量（sectionStats 元素） */
export interface PromptSectionStat {
  readonly id: PromptSectionId
  readonly zone: "static" | "dynamic"
  /** 该段渲染字符数（行以 \n 连接后的长度） */
  readonly chars: number
}

export const PROMPT_SECTIONS: readonly PromptSectionMeta[] = [
  // —— 静态段（渲染顺序与 builder 中 emit 顺序一致） ——
  { id: "identity", group: "identity", zone: "static", terse: false },
  { id: "permissionMode", group: "rules", zone: "static", terse: false },
  { id: "tooling", group: "capabilities", zone: "static", terse: true, expandVia: "prompt-guide" },
  { id: "systemRules", group: "rules", zone: "static", terse: false },
  { id: "toolPreference", group: "capabilities", zone: "static", terse: false },
  { id: "operatingPrinciples", group: "rules", zone: "static", terse: true, expandVia: "prompt-guide" },
  { id: "bundledCapabilities", group: "capabilities", zone: "static", terse: false },
  { id: "progressUpdates", group: "rules", zone: "static", terse: false },
  { id: "verification", group: "rules", zone: "static", terse: false },
  { id: "toolNamingContract", group: "rules", zone: "static", terse: false },
  { id: "progressiveLoading", group: "capabilities", zone: "static", terse: true, expandVia: "prompt-guide" },
  { id: "mcp", group: "capabilities", zone: "static", terse: false },
  { id: "skills", group: "capabilities", zone: "static", terse: false },
  { id: "selfLearning", group: "capabilities", zone: "static", terse: false },
  { id: "taskOrchestration", group: "collaboration", zone: "static", terse: false },
  { id: "subagentRole", group: "collaboration", zone: "static", terse: false },
  { id: "agentCollaboration", group: "collaboration", zone: "static", terse: false },
  { id: "deviceControl", group: "collaboration", zone: "static", terse: false },
  { id: "safety", group: "rules", zone: "static", terse: false },
  { id: "language", group: "rules", zone: "static", terse: false },
  { id: "taskCompletion", group: "rules", zone: "static", terse: false },
  { id: "messaging", group: "channel", zone: "static", terse: true, expandVia: "existing-tool" },
  { id: "wiki", group: "capabilities", zone: "static", terse: false },
  { id: "browser", group: "capabilities", zone: "static", terse: true, expandVia: "prompt-guide" },
  { id: "cron", group: "capabilities", zone: "static", terse: false },
  { id: "fileOutput", group: "rules", zone: "static", terse: true, expandVia: "prompt-guide" },
  { id: "silentReplies", group: "rules", zone: "static", terse: false },
  // —— 动态段 ——
  { id: "memory", group: "memory", zone: "dynamic", terse: false },
  { id: "workspace", group: "runtime", zone: "dynamic", terse: false },
  { id: "projectContext", group: "runtime", zone: "dynamic", terse: false },
  { id: "userDevices", group: "runtime", zone: "dynamic", terse: false },
  { id: "activeTasks", group: "runtime", zone: "dynamic", terse: false },
  { id: "runtime", group: "runtime", zone: "dynamic", terse: false },
  { id: "contextManagement", group: "runtime", zone: "dynamic", terse: false },
  { id: "skillActivation", group: "capabilities", zone: "dynamic", terse: false },
  { id: "routingRationale", group: "collaboration", zone: "dynamic", terse: false },
  { id: "criticalReminder", group: "rules", zone: "dynamic", terse: false },
]
