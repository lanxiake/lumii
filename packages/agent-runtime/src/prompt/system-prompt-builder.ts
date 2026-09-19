/**
 * 客户端系统提示词构建器
 *
 * 对齐网关 `buildAgentSystemPrompt("full")` 的核心 section，
 * 适配客户端 Agent Runtime 场景（无网关特有功能）。
 */

import type {
  ClientSystemPromptParams,
  SystemPromptResult,
  PromptSectionTag,
  PromptStyle,
} from "./system-prompt.types.js"
import { isLeanStyle, CACHE_BOUNDARY_MARKER, PROMPT_SECTION_TAGS } from "./system-prompt.types.js"
import type { PromptSectionId, PromptSectionStat } from "./prompt-sections.js"
import { MEMORY_PLACEHOLDER } from "../memory/memory-injector.js"
import { DEFAULT_SOUL_CONTENT } from "./default-soul.js"
import { NO_DELEGATION_TOOLS_NOTE } from "../agent/builtin/prompts.js"
import { extractToolName } from "../security/param-permission-parser.js"
import {
  categorizeTools,
  buildProgressiveLoadingSection,
  buildSystemRulesSection,
  buildToolNamingContractSection,
} from "./sections/tooling-section.js"
import {
  buildSkillsSection,
  buildSkillActivationSection,
  buildSelfLearningSection,
  skillKey,
} from "./sections/skills-section.js"
import {
  filterAgentsForCollaborationPrompt,
  buildAgentCollaborationSection,
  buildTaskOrchestrationSection,
  buildRoutingRationaleSection,
} from "./sections/agent-collaboration-section.js"
import {
  buildRuntimeSection,
  buildContextManagementSection,
  buildActiveTasksSection,
  buildWorkspaceSection,
} from "./sections/runtime-section.js"
import {
  buildSafetySection,
  buildVerificationSection,
  buildOperatingPrinciplesSection,
  buildMemorySection,
  buildWikiKnowledgeSection,
  buildMessagingSection,
  buildBrowserSection,
  buildMcpSection,
  buildA2UISection,
  buildFileOutputSection,
  buildSilentRepliesSection,
  buildProjectContextSection,
  buildUserDevicesSection,
  buildDeviceControlSection,
} from "./sections/misc-sections.js"

// 导出类型供外部使用
export type {
  ClientSystemPromptParams,
  SystemPromptResult,
  SkillInfo,
  SkillActivationHint,
  CustomAgentInfo,
  WorkspaceLayout,
  ContextFile,
  UserDeviceInfo,
  McpToolInfo,
  McpServerHint,
  ActiveTaskInfo,
  PromptStyle,
  PromptSectionTag,
  RouterResultLite,
} from "./system-prompt.types.js"
export { CACHE_BOUNDARY_MARKER, PROMPT_SECTION_TAGS } from "./system-prompt.types.js"
export { PROMPT_SECTIONS } from "./prompt-sections.js"
export type {
  PromptSectionId,
  PromptSectionGroup,
  PromptSectionMeta,
  PromptSectionStat,
  PromptExpandRoute,
} from "./prompt-sections.js"

// 导出工具函数供外部使用
export { filterAgentsForCollaborationPrompt } from "./sections/agent-collaboration-section.js"

/**
 * 用成对标签包裹一个分区的内容行；内容为空时返回空数组（不产生空标签）。
 */
function tagged(tag: PromptSectionTag, lines: readonly string[]): string[] {
  const body = lines.filter((l) => l != null)
  if (body.length === 0 || body.every((l) => !l.trim())) return []
  return [`<${tag}>`, ...body, `</${tag}>`, ""]
}

/** 内建 Agent 的简短 systemPrompt 列表 — 这些不应覆盖 SOUL 内容 */
const BUILTIN_SHORT_PROMPTS = new Set([
  "You are MtBot, a helpful AI assistant.",
  "You are MtBot Coder, an expert programming assistant.",
  "You are MtBot Researcher, an expert at finding and synthesizing information.",
])

/**
 * 构建客户端 Agent Runtime 的结构化系统提示词
 *
 * 返回 SystemPromptResult，将提示词分为静态/动态两部分：
 * - 静态部分（跨轮次不变）：Identity/Tooling/Skills/Safety/A2UI 等
 * - 动态部分（每轮可能变化）：Memory/Active Tasks/Runtime/User Devices 等
 *
 * 这种分离使宿主层可以：
 * 1. 缓存静态部分，仅重建动态部分（降低每轮构建开销）
 * 2. 利用 Anthropic API prompt caching（降低 API 延迟和成本）
 */
export function buildClientSystemPromptStructured(params: ClientSystemPromptParams): SystemPromptResult {
  const {
    agentDefinition,
    toolNames,
    cwd,
    skills,
    customAgents,
    userMemoryContent,
    contextFiles,
  } = params

  // ─── Pre-LLM Router 接入 ────────────────────────────────────
  // Router 结果只用于动态路由建议（Routing rationale）与澄清提示。
  // P2 缓存修复（2026-09-13）：不再用它过滤静态 skills/agents 列表——
  // 按轮过滤会改写静态前缀（高置信任务回合与闲聊回合字节不同），使整份
  // 系统提示词的 cache_control 断点失配；静态列表保持恒定完整。
  const routerOk = !!params.routerResult && params.routerResult.fallback === "none"
  const routerHighConf = routerOk && params.routerResult!.confidence >= 0.6
  const routerClarify = routerOk && !!params.routerResult!.needsClarification
  const useRouter = routerHighConf || routerClarify
  const runtimeChannel = params.runtimeInfo?.channel?.trim().toLowerCase()
  const style = params.promptStyle ?? "detailed"

  // 如果 agentDefinition.systemPrompt 是内建简短默认值，使用 SOUL 内容
  const rawPrompt = agentDefinition.systemPrompt?.trim()
  const identityLine =
    !rawPrompt || BUILTIN_SHORT_PROMPTS.has(rawPrompt)
      ? (params.soulContent?.trim() || DEFAULT_SOUL_CONTENT)
      : rawPrompt

  // 按 Agent 定义过滤工具名称（disallowedTools 黑名单 + tools 白名单）
  const afterBlacklist = agentDefinition.disallowedTools?.length
    ? toolNames.filter((t) => !agentDefinition.disallowedTools!.includes(t))
    : toolNames

  // 如果设置了 tools 白名单，进一步过滤（支持参数级语法如 "bash(git:*)"）
  const effectiveToolNames = (agentDefinition.tools && agentDefinition.tools.length > 0)
    ? (() => {
        const allowedToolNames = new Set(agentDefinition.tools!.map(extractToolName))
        return afterBlacklist.filter((t) => allowedToolNames.has("*") || allowedToolNames.has(t))
      })()
    : afterBlacklist

  const toolLines = categorizeTools(effectiveToolNames, style)

  // 技能正文与动态激活提示共用（P2 重排上提：段序调整不影响计算顺序）
  const readToolName = effectiveToolNames.includes("file_read")
    ? "file_read"
    : effectiveToolNames.includes("read")
      ? "read"
      : "file_read"

  // ========== 输出缓冲与段级计量（段 ID 见 prompt-sections.ts） ==========
  const staticLines: string[] = []
  const dynamicLines: string[] = []
  const stats: PromptSectionStat[] = []
  /** 段级写入：空数组跳过（与原 push 行为一致），同时记录段级计量 */
  const emit = (zone: "static" | "dynamic", id: PromptSectionId, lines: string[]): void => {
    if (lines.length === 0) return
    if (zone === "static") staticLines.push(...lines)
    else dynamicLines.push(...lines)
    stats.push({ id, zone, chars: lines.join("\n").length })
  }

  // ========== 静态部分（实例生命周期内不变） ==========
  // 段序（P2 结构重排，2026-09-13）：① 身份 → ② 规则 → ③ 能力索引 → ④ 协作 → ⑤ 渠道。
  // 同类相邻（对齐 PROMPT_SECTIONS.group）；identity 恒为首；重排为缓存中性变更
  // （渲染仍确定性，仅段序不同 = 一次性重建）。

  // ═══ ① 身份 ═══

  // === 1.1. Identity ===
  const identityLines = [identityLine]
  // personality 注入（拼接在 identity 之后）
  if (agentDefinition.personality) {
    identityLines.push("", agentDefinition.personality)
    // personality 与工具能力对不上时补更正：assistant 的 personality 写死了「必须用 spawn_agent 委派」，
    // 而子 Agent / 自主进化受限实例继承它却已被摘掉该工具，模型会照指令去调一个不存在的工具
    // （2026-09-19 实测：子 Agent 调 spawn_agent → "Tool spawn_agent not found"）。
    if (
      agentDefinition.personality.includes("spawn_agent") &&
      !effectiveToolNames.includes("spawn_agent")
    ) {
      identityLines.push("", NO_DELEGATION_TOOLS_NOTE)
    }
  }
  emit("static", "identity", identityLines)

  // === 1.2. permissionMode 感知提示 ===
  const permissionModeLines: string[] = []
  if (agentDefinition.permissionMode === "readOnly") {
    permissionModeLines.push(
      "",
      "## Permission Mode: Read-Only",
      "You are in read-only mode. Never create, modify, or delete files; only search and read.",
    )
  } else if (agentDefinition.permissionMode === "acceptEdits") {
    permissionModeLines.push(
      "",
      "## Permission Mode: Auto-Edit",
      "You may apply file edits automatically without per-edit user confirmation.",
    )
  }
  emit("static", "permissionMode", permissionModeLines)

  // ═══ ② 规则块（行为契约与红线） ═══

  // === 2.1. 系统运行规则（对齐 Claude Code # System：工具被拒不重试 / 标签语义 / 防臆造 URL / 防注入） ===
  emit("static", "systemRules", ["", ...buildSystemRulesSection(effectiveToolNames)])

  // === 2.2. 工作原则（做任务的工程原则） ===
  // 子 Agent 已有专门的角色约束，避免与执行风格冲突，仅主 Agent 注入。
  // 代码细则仅当具备代码类工具时注入（能力驱动条件注入）。
  if (!params.isSubAgent) {
    const hasCodeTools =
      effectiveToolNames.includes("file_edit") ||
      effectiveToolNames.includes("file_write") ||
      effectiveToolNames.includes("bash")
    emit("static", "operatingPrinciples", ["", ...buildOperatingPrinciplesSection(style, hasCodeTools)])
  }

  // === 2.3. 进度更新（迁移映射 #5：terse 档用原 compact 精简文案） ===
  if (isLeanStyle(style)) {
    emit("static", "progressUpdates", [
      "## Progress Updates",
      "Before the first tool call, state the intent in one sentence. During execution, speak only for key findings, direction changes, or blockers. End with the result and next step; omit filler.",
      "",
    ])
  } else {
    emit("static", "progressUpdates", [
      "## Progress Updates",
      "Before the first tool call, state what you will do and why. Batch independent calls. During execution, report only key findings, direction changes, or blockers. End with a concise result, output location, and next step. Do not narrate hidden reasoning or use filler.",
      "",
    ])
  }

  // === 2.4. 诚实与完成验证（治长对话/压缩后的工具调用幻觉与虚假完成；子 Agent 也需遵守） ===
  emit("static", "verification", [...buildVerificationSection(effectiveToolNames)])

  // === 2.5. 工具命名契约：仅 detailed 档注入（terse 档不注入，迁移映射 #7） ===
  if (style === "detailed") {
    emit("static", "toolNamingContract", [...buildToolNamingContractSection(effectiveToolNames)])
  }

  // === 2.6. 安全与边界（操作守则 + 红线，合并为一段） ===
  emit("static", "safety", [...buildSafetySection(effectiveToolNames)])

  // === 2.7. Language & Task Completion ===
  emit("static", "language", [
    "## Language",
    "Always respond in **Chinese (Simplified)** unless the user explicitly writes in another language.",
    "This applies to all text output: explanations, summaries, tool narration, and error messages.",
    "",
  ])
  emit("static", "taskCompletion", [
    "## Task Completion",
    "`task_complete` is the only completion signal and must be called. See the Session Tasks section for timing.",
    "- Before calling it, confirm outputs exist and actions actually ran (see Honesty and Verification).",
    "- Provide a 1–3 sentence summary: what was done, key result or output file, any important caveat.",
    "- Client todo updates and desktop notifications depend on this call; saying 'done' in text does not trigger them.",
    "",
  ])

  // === 2.8. Silent Replies（NO_REPLY 协议） ===
  emit("static", "silentReplies", [...buildSilentRepliesSection()])

  // === 2.9. File Output Standards（始终注入，不依赖 task/spawn 工具） ===
  emit("static", "fileOutput", [...buildFileOutputSection(effectiveToolNames, style)])

  // ═══ ③ 能力索引块 ═══
  // Cron / Scheduled Tasks 已索引化：规则在 Tooling 的 TOOL_SUMMARIES/GROUP_NOTES，无独立段。

  // === 3.1. Tooling ===
  emit("static", "tooling", [
    "",
    ...tagged("tooling", [
      "## Tooling",
      "",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "",
      ...toolLines,
    ]),
  ])

  // === 3.2. 工具选择优先级（主 Agent 恒注入） ===
  if (!params.isSubAgent) {
    const hasWebTools = effectiveToolNames.includes("web_search") || effectiveToolNames.includes("web_fetch")
    const hasSkillTools = effectiveToolNames.includes("skill_search")
    const hasMemoryTools = effectiveToolNames.includes("memory_search")
    // 「优先用专用文件工具而非 bash」已由 Tooling → File Tools 的组注承担，
    // 此处只保留信息获取的优先级链路，避免同一条规则说两遍。
    if (hasSkillTools || hasMemoryTools || hasWebTools) {
      emit("static", "toolPreference", [
        "",
        "**Tool preference:**",
        "- 信息获取优先级：成套任务先 `skill_search` → 历史偏好先 `memory_search` → 时效事实用 `web_search` → 指定网页用 `web_fetch`",
        "",
      ])
    }
  }

  // === 3.3. Progressive Loading & Context Management ===
  emit("static", "progressiveLoading", [...buildProgressiveLoadingSection(effectiveToolNames, style)])

  // === 3.4. MCP Server Instructions ===
  if (params.mcpServerHints && params.mcpServerHints.length > 0) {
    emit("static", "mcp", [...tagged("mcp_servers", buildMcpSection(params.mcpServerHints, style))])
  }

  // === 3.5. Skills（按白名单过滤）===
  if (skills && skills.length > 0) {
    const allowedSkills = agentDefinition.skills
    const baseSkills = skills
    const filteredSkills = allowedSkills && allowedSkills.length > 0
      ? baseSkills.filter((s) => allowedSkills.includes(s.name))
      : baseSkills

    if (filteredSkills.length > 0) {
      const hasSkillTools = effectiveToolNames.includes("skill_search")
      emit("static", "skills", [
        ...tagged("skills", buildSkillsSection(filteredSkills, readToolName, hasSkillTools, style)),
      ])
    }
  }

  // === 3.6. Bundled Capabilities（Agent 自带技能包，仅在 bundledSkillIds 非空时插入） ===
  if (params.bundledSkillIds && params.bundledSkillIds.length > 0 && skills) {
    const bundledSet = new Set(params.bundledSkillIds.map((id) => id.trim()))
    const bundledSkills = skills.filter((s) => bundledSet.has(skillKey(s)))
    if (bundledSkills.length > 0) {
      const bundledLines = ["", "## Your bundled capabilities", ""]
      bundledLines.push(
        "The following skills are pre-loaded and activated for this Agent — use them directly without skill_search:",
      )
      for (const s of bundledSkills) {
        if (style === "minimal") {
          bundledLines.push(`- ${s.name}`)
          continue
        }
        const desc = s.description.length > 80 ? s.description.slice(0, 79) + "…" : s.description
        bundledLines.push(`- **${s.name}**: ${desc}`)
      }
      bundledLines.push("")
      emit("static", "bundledCapabilities", bundledLines)
    }
  }

  // === 3.7. 自我学习与进化（仅主 Agent） ===
  if (!params.isSubAgent) {
    emit("static", "selfLearning", [...tagged("skills", buildSelfLearningSection(effectiveToolNames, style))])
  }

  // === 3.8. Browser ===
  emit("static", "browser", [...buildBrowserSection(effectiveToolNames, style)])

  // === 3.9. Wiki ===
  emit("static", "wiki", [...buildWikiKnowledgeSection(effectiveToolNames, style)])

  // ═══ ④ 协作块 ═══

  // === 4.1. Task Orchestration（按能力条件化）===
  if (effectiveToolNames.includes("spawn_agent") || effectiveToolNames.includes("todo_write")) {
    emit("static", "taskOrchestration", [...buildTaskOrchestrationSection(effectiveToolNames, style)])
  }

  // === 4.2. Multi-Agent Collaboration ===
  if (params.isSubAgent) {
    // 子 Agent：仅注入角色约束，不列出 Agent 目录（防止递归委派 R1）
    emit("static", "subagentRole", [
      "## Role Constraint",
      "You are a sub-agent executing a delegated task. Execute directly using your tools.",
      "Do NOT spawn sub-agents, do NOT call todo_write, do NOT delegate further.",
      "",
      "## Task Completion Summary",
      "When you finish the task, reply with a concise summary — 1–3 sentences max.",
      "State: what was done, key result or file produced, any important caveat.",
      "No preamble, no lists, no padding. Straight to the point.",
      "",
    ])
  } else if (
    customAgents && customAgents.length > 0 &&
    (effectiveToolNames.includes("spawn_agent") || effectiveToolNames.includes("send_message"))
  ) {
    const baseAgents = customAgents
    const filteredAgents = filterAgentsForCollaborationPrompt(
      baseAgents,
      agentDefinition.allowedSubAgents,
    )

    if (filteredAgents.length > 0) {
      emit("static", "agentCollaboration", [
        ...tagged("subagents", buildAgentCollaborationSection(filteredAgents, effectiveToolNames, style)),
      ])
    }
  }

  // === 4.3. Device Node Control ===
  emit("static", "deviceControl", [...buildDeviceControlSection(params.userDevices, effectiveToolNames, style)])

  // ═══ ⑤ 渠道 ═══

  // === 5.1. Messaging 指导（静态规则） ===
  emit("static", "messaging", [...buildMessagingSection({ toolNames: effectiveToolNames, runtimeChannel, style })])

  // A2UI 动态 UI 能力（暂时屏蔽：效果不好，待优化后重新启用）
  // staticLines.push(...buildA2UISection(effectiveToolNames))

  // ========== 动态部分（每轮可能变化） ==========

  // === D1. Memory（摘要版或完整版，由 includeFullMemoryGuide 控制）===
  if (agentDefinition.memory?.scope !== "none") {
    // 工作记忆注入锚点（Task 3 P0）：injectMemories() 按占位符查找替换，
    // 必须落在 cache boundary 之后的 dynamic 段——工作记忆每轮变化，
    // 放进 static 段会让 prompt cache 每轮失效。
    emit("dynamic", "memory", [
      ...tagged(
        "memory",
        buildMemorySection(effectiveToolNames, userMemoryContent, params.includeFullMemoryGuide),
      ),
      MEMORY_PLACEHOLDER,
    ])
  }

  // === D2. Workspace ===
  if (cwd) {
    emit("dynamic", "workspace", [...buildWorkspaceSection(cwd, params.workspaceLayout, style)])
  }

  // === D3. Project Context（BOOTSTRAP.md 等） ===
  emit("dynamic", "projectContext", [...buildProjectContextSection(contextFiles)])

  // === D4. User Devices（设备在线状态可能变化） ===
  emit("dynamic", "userDevices", [...buildUserDevicesSection(params.userDevices, style)])

  // === D5. Active Tasks（活跃任务列表，防止目标偏移） ===
  emit("dynamic", "activeTasks", [...buildActiveTasksSection(params.activeTasks)])

  // === D6. Runtime（含日期等动态信息） ===
  emit("dynamic", "runtime", [...buildRuntimeSection(params, params.currentModelId, style)])

  // === D6.1. 上下文自动压缩告知（紧邻 Runtime，对齐 Claude Code Context management） ===
  emit("dynamic", "contextManagement", [...buildContextManagementSection(effectiveToolNames, style)])

  // === D6.5. Skill Activation（动态激活提示，对齐 CCR SkillTool/prompt.ts） ===
  if (params.skillActivations && params.skillActivations.length > 0) {
    emit("dynamic", "skillActivation", [
      ...buildSkillActivationSection(params.skillActivations, readToolName),
    ])
  }

  // === D6.6. Routing Rationale（Pre-LLM Router 输出，仅在 useRouter 时插入） ===
  if (useRouter && params.routerResult) {
    emit("dynamic", "routingRationale", [...buildRoutingRationaleSection(params.routerResult)])
  }

  // === D7. Critical Reminder（放在 prompt 最末尾） ===
  if (agentDefinition.criticalReminder) {
    emit("dynamic", "criticalReminder", ["", "## CRITICAL REMINDER", agentDefinition.criticalReminder])
  }

  // 拼接最终结果（保留空行分隔符，仅过滤 undefined/null）
  const filterLines = (lines: string[]) => lines.filter((l) => l != null).join("\n")
  const staticPrompt = filterLines(staticLines)
  const dynamicPrompt = filterLines(dynamicLines)
  const fullPrompt = dynamicPrompt
    ? `${staticPrompt}${CACHE_BOUNDARY_MARKER}${dynamicPrompt}`
    : staticPrompt

  return { staticPrompt, dynamicPrompt, fullPrompt, sectionStats: stats }
}

/**
 * 构建客户端 Agent Runtime 的完整系统提示词（向后兼容）
 *
 * 内部委托到 buildClientSystemPromptStructured，返回 fullPrompt 字符串。
 */
export function buildClientSystemPrompt(params: ClientSystemPromptParams): string {
  return buildClientSystemPromptStructured(params).fullPrompt
}
