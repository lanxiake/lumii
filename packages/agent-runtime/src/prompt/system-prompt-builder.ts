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
  PromptDetail,
} from "./system-prompt.types.js"
import { CACHE_BOUNDARY_MARKER, PROMPT_SECTION_TAGS } from "./system-prompt.types.js"
import { MEMORY_PLACEHOLDER } from "../memory/memory-injector.js"
import { DEFAULT_SOUL_CONTENT } from "./default-soul.js"
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
  filterSkillsByRouter,
} from "./sections/skills-section.js"
import {
  filterAgentsForCollaborationPrompt,
  buildAgentCollaborationSection,
  buildTaskOrchestrationSection,
  filterAgentsByRouter,
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
  buildMessagingSection,
  buildBrowserSection,
  buildMcpSection,
  buildA2UISection,
  buildFileOutputSection,
  buildSilentRepliesSection,
  buildProjectContextSection,
  buildCronSection,
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
  PromptDetail,
  PromptSectionTag,
  RouterResultLite,
} from "./system-prompt.types.js"
export { CACHE_BOUNDARY_MARKER, PROMPT_SECTION_TAGS } from "./system-prompt.types.js"

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

  // ─── Pre-LLM Router 过滤 ────────────────────────────────────
  // 若宿主注入了 routerResult 且未降级，根据置信度决定行为：
  // - confidence ≥ 0.6 → 用 topAgents/topSkills 过滤主 prompt
  // - confidence < 0.6 但 needsClarification → 不过滤（让主 LLM 看完整能力），但注入澄清提示
  // - confidence < 0.6 且不澄清 → 走旧路径（与未提供 router 等同）
  const routerOk = !!params.routerResult && params.routerResult.fallback === "none"
  const routerHighConf = routerOk && params.routerResult!.confidence >= 0.6
  const routerClarify = routerOk && !!params.routerResult!.needsClarification
  const useRouter = routerHighConf || routerClarify
  // 仅在高置信度时才过滤；澄清模式不过滤（用户可能改主意）
  const routerFilteredSkills = routerHighConf
    ? filterSkillsByRouter(skills ?? [], params.routerResult!.topSkills)
    : skills
  const routerFilteredAgents = routerHighConf
    ? filterAgentsByRouter(customAgents ?? [], params.routerResult!.topAgents)
    : customAgents
  const runtimeChannel = params.runtimeInfo?.channel?.trim().toLowerCase()
  const detail = params.promptDetail ?? "standard"

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

  const toolLines = categorizeTools(effectiveToolNames)

  // ========== 静态部分（实例生命周期内不变） ==========
  const staticLines: string[] = []

  // === 1. Identity ===
  staticLines.push(identityLine)

  // personality 注入（拼接在 identity 之后）
  if (agentDefinition.personality) {
    staticLines.push("", agentDefinition.personality)
  }

  // permissionMode 感知提示
  if (agentDefinition.permissionMode === "readOnly") {
    staticLines.push(
      "",
      "## Permission Mode: Read-Only",
      "You are in read-only mode. Never create, modify, or delete files; only search and read.",
    )
  } else if (agentDefinition.permissionMode === "acceptEdits") {
    staticLines.push(
      "",
      "## Permission Mode: Auto-Edit",
      "You may apply file edits automatically without per-edit user confirmation.",
    )
  }

  // === 2. Tooling ===
  staticLines.push(
    "",
    ...tagged("tooling", [
      "## Tooling",
      "",
      "Tool names are case-sensitive. Call tools exactly as listed.",
      "",
      ...toolLines,
    ]),
  )

  // === 2.05. 系统运行规则（对齐 Claude Code # System：工具被拒不重试 / 标签语义 / 防臆造 URL / 防注入） ===
  staticLines.push("", ...buildSystemRulesSection(effectiveToolNames, detail))

  // === 2.1. 工具选择优先级（仅 standard/full 模式注入） ===
  if (detail !== "compact" && !params.isSubAgent) {
    const hasFileTools = effectiveToolNames.includes("file_read") || effectiveToolNames.includes("file_write")
    const hasWebTools = effectiveToolNames.includes("web_search") || effectiveToolNames.includes("web_fetch")
    const hasSkillTools = effectiveToolNames.includes("skill_search")
    const hasMemoryTools = effectiveToolNames.includes("memory_search")
    if (hasFileTools || hasWebTools || hasSkillTools || hasMemoryTools) {
      staticLines.push(
        "",
        "**Tool preference:**",
        "- Use dedicated file tools (`file_read`/`file_write`/`glob`/`grep`) instead of `bash` for file work; reserve `bash` for shell-only operations.",
      )
      if (hasSkillTools || hasMemoryTools || hasWebTools) {
        staticLines.push("- 信息获取优先级：成套任务先 `skill_search` → 历史偏好先 `memory_search` → 时效事实用 `web_search` → 指定网页用 `web_fetch`")
      }
      staticLines.push("")
    }
  }

  // === 2.2. 工作原则（做任务的工程原则，紧跟身份之后） ===
  // 子 Agent 已有专门的角色约束，避免与执行风格冲突，仅主 Agent 注入。
  // 代码细则仅当具备代码类工具时注入（能力驱动条件注入）。
  if (!params.isSubAgent) {
    const hasCodeTools =
      effectiveToolNames.includes("file_edit") ||
      effectiveToolNames.includes("file_write") ||
      effectiveToolNames.includes("bash")
    staticLines.push("", ...buildOperatingPrinciplesSection(detail, hasCodeTools))
  }

  // === 2.5. Bundled Capabilities（Agent 自带技能包，仅在 bundledSkillIds 非空时插入） ===
  if (params.bundledSkillIds && params.bundledSkillIds.length > 0 && skills) {
    const bundledSet = new Set(params.bundledSkillIds.map((id) => id.trim()))
    const bundledSkills = skills.filter((s) => bundledSet.has(skillKey(s)))
    if (bundledSkills.length > 0) {
      staticLines.push("", "## Your bundled capabilities", "")
      staticLines.push(
        "The following skills are pre-loaded and activated for this Agent — use them directly without skill_search:",
      )
      for (const s of bundledSkills) {
        const desc = s.description.length > 80 ? s.description.slice(0, 79) + "…" : s.description
        staticLines.push(`- **${s.name}**: ${desc}`)
      }
      staticLines.push("")
    }
  }

  if (detail === "compact") {
    staticLines.push(
      "## Progress Updates",
      "Before the first tool call, state the intent in one sentence. During execution, speak only for key findings, direction changes, or blockers. End with the result and next step; omit filler.",
      "",
    )
  } else {
    staticLines.push(
      "## Progress Updates",
      "Before the first tool call, state what you will do and why. Batch independent calls. During execution, report only key findings, direction changes, or blockers. End with a concise result, output location, and next step. Do not narrate hidden reasoning or use filler.",
      "",
    )
  }

  // === 2.6. 诚实与完成验证（治长对话/压缩后的工具调用幻觉与虚假完成；子 Agent 也需遵守） ===
  staticLines.push(...buildVerificationSection(effectiveToolNames, detail))

  staticLines.push(...buildToolNamingContractSection(effectiveToolNames, detail))

  // === 2.5. Progressive Loading & Context Management ===
  if (detail !== "compact") {
    staticLines.push(...buildProgressiveLoadingSection(effectiveToolNames, detail))
  }

  // === 3. MCP Server Instructions ===
  if (params.mcpServerHints && params.mcpServerHints.length > 0) {
    staticLines.push(...tagged("mcp_servers", buildMcpSection(params.mcpServerHints)))
  }

  // === 4. Skills（按白名单过滤，支持 promptDetail 详度控制）===
  const readToolName = effectiveToolNames.includes("file_read")
    ? "file_read"
    : effectiveToolNames.includes("read")
      ? "read"
      : "file_read"
  if (skills && skills.length > 0) {
    const allowedSkills = agentDefinition.skills
    const baseSkills = routerFilteredSkills ?? skills
    const filteredSkills = allowedSkills && allowedSkills.length > 0
      ? baseSkills.filter((s) => allowedSkills.includes(s.name))
      : baseSkills

    if (filteredSkills.length > 0) {
      const hasSkillTools = effectiveToolNames.includes("skill_list")
      staticLines.push(
        ...tagged("skills", buildSkillsSection(filteredSkills, readToolName, detail, hasSkillTools)),
      )
    }
  }

  // === 4.5. 自我学习与进化（仅主 Agent；compact 模式跳过以省 token） ===
  if (!params.isSubAgent && detail !== "compact") {
    staticLines.push(...tagged("skills", buildSelfLearningSection(effectiveToolNames)))
  }

  // === 5. Task Orchestration（按能力条件化）===
  if (effectiveToolNames.includes("spawn_agent") || effectiveToolNames.includes("todo_write")) {
    staticLines.push(...buildTaskOrchestrationSection(effectiveToolNames))
  }

  // === 6. Multi-Agent Collaboration ===
  if (params.isSubAgent) {
    // 子 Agent：仅注入角色约束，不列出 Agent 目录（防止递归委派 R1）
    staticLines.push(
      "## Role Constraint",
      "You are a sub-agent executing a delegated task. Execute directly using your tools.",
      "Do NOT spawn sub-agents, do NOT call todo_write, do NOT delegate further.",
      "",
      "## Task Completion Summary",
      "When you finish the task, reply with a concise summary — 1–3 sentences max.",
      "State: what was done, key result or file produced, any important caveat.",
      "No preamble, no lists, no padding. Straight to the point.",
      "",
    )
  } else if (
    customAgents && customAgents.length > 0 &&
    (effectiveToolNames.includes("spawn_agent") || effectiveToolNames.includes("send_message"))
  ) {
    const baseAgents = routerFilteredAgents ?? customAgents
    const filteredAgents = filterAgentsForCollaborationPrompt(
      baseAgents,
      agentDefinition.allowedSubAgents,
    )

    if (filteredAgents.length > 0) {
      staticLines.push(
        ...tagged("subagents", buildAgentCollaborationSection(filteredAgents, effectiveToolNames)),
      )
    }
  }

  // === 7. Device Node Control（compact 模式压缩为单行） ===
  if (detail === "compact") {
    if (params.userDevices?.length) {
      staticLines.push(
        "## Device Node Control",
        "Tools execute on user's primary device by default. Specify target device in tool params if needed.",
        "",
      )
    }
  } else {
    staticLines.push(...buildDeviceControlSection(params.userDevices, effectiveToolNames))
  }

  // === 8. 安全与边界（操作守则 + 红线，合并为一段） ===
  staticLines.push(...buildSafetySection(effectiveToolNames, detail))

  // === 8.5. Language & Task Completion ===
  staticLines.push(
    "## Language",
    "Always respond in **Chinese (Simplified)** unless the user explicitly writes in another language.",
    "This applies to all text output: explanations, summaries, tool narration, and error messages.",
    "",
    "## Task Completion",
    "`task_complete` is the only completion signal and must be called. See the Session Tasks section for timing.",
    "- Before calling it, confirm outputs exist and actions actually ran (see Honesty and Verification).",
    "- Provide a 1–3 sentence summary: what was done, key result or output file, any important caveat.",
    "- Client todo updates and desktop notifications depend on this call; saying 'done' in text does not trigger them.",
    "",
  )

  // === 9. Messaging 指导（静态规则） ===
  staticLines.push(...buildMessagingSection({ toolNames: effectiveToolNames, runtimeChannel }))
  staticLines.push(...buildBrowserSection(effectiveToolNames))

  // === 10. Cron / Scheduled Tasks（compact 模式精简） ===
  if (detail === "compact") {
    if (effectiveToolNames.includes("cron_create")) {
      staticLines.push(
        "## Scheduled Tasks",
        "Use `cron_create`/`cron_list`/`cron_delete` to manage recurring or one-time scheduled tasks.",
        "",
      )
    }
  } else {
    staticLines.push(...buildCronSection(effectiveToolNames))
  }

  // === 10.5. File Output Standards（始终注入，不依赖 task/spawn 工具） ===
  staticLines.push(...buildFileOutputSection(effectiveToolNames))

  // === 11. A2UI 动态 UI 能力（暂时屏蔽：效果不好，待优化后重新启用） ===
  // staticLines.push(...buildA2UISection(effectiveToolNames))

  // === 12. Silent Replies（NO_REPLY 协议） ===
  staticLines.push(...buildSilentRepliesSection())

  // ========== 动态部分（每轮可能变化） ==========
  const dynamicLines: string[] = []

  // === D1. Memory（摘要版或完整版，由 includeFullMemoryGuide 控制）===
  if (agentDefinition.memory?.scope !== "none") {
    dynamicLines.push(
      ...tagged(
        "memory",
        buildMemorySection(effectiveToolNames, userMemoryContent, params.includeFullMemoryGuide),
      ),
    )
    // 工作记忆注入锚点（Task 3 P0）：injectMemories() 按占位符查找替换，
    // 必须落在 cache boundary 之后的 dynamic 段——工作记忆每轮变化，
    // 放进 static 段会让 prompt cache 每轮失效。
    dynamicLines.push(MEMORY_PLACEHOLDER)
  }

  // === D2. Workspace ===
  if (cwd) {
    dynamicLines.push(...buildWorkspaceSection(cwd, params.workspaceLayout))
  }

  // === D3. Project Context（BOOTSTRAP.md 等） ===
  dynamicLines.push(...buildProjectContextSection(contextFiles))

  // === D4. User Devices（设备在线状态可能变化） ===
  dynamicLines.push(...buildUserDevicesSection(params.userDevices))

  // === D5. Active Tasks（活跃任务列表，防止目标偏移） ===
  dynamicLines.push(...buildActiveTasksSection(params.activeTasks))

  // === D6. Runtime（含日期等动态信息） ===
  dynamicLines.push(...buildRuntimeSection(params, params.currentModelId))

  // === D6.1. 上下文自动压缩告知（紧邻 Runtime，对齐 Claude Code Context management） ===
  if (detail !== "compact") {
    dynamicLines.push(...buildContextManagementSection(effectiveToolNames))
  }

  // === D6.5. Skill Activation（动态激活提示，对齐 CCR SkillTool/prompt.ts） ===
  if (params.skillActivations && params.skillActivations.length > 0) {
    dynamicLines.push(
      ...buildSkillActivationSection(params.skillActivations, readToolName),
    )
  }

  // === D6.6. Routing Rationale（Pre-LLM Router 输出，仅在 useRouter 时插入） ===
  if (useRouter && params.routerResult) {
    dynamicLines.push(...buildRoutingRationaleSection(params.routerResult))
  }

  // === D7. Critical Reminder（放在 prompt 最末尾） ===
  if (agentDefinition.criticalReminder) {
    dynamicLines.push("", "## CRITICAL REMINDER", agentDefinition.criticalReminder)
  }

  // 拼接最终结果（保留空行分隔符，仅过滤 undefined/null）
  const filterLines = (lines: string[]) => lines.filter((l) => l != null).join("\n")
  const staticPrompt = filterLines(staticLines)
  const dynamicPrompt = filterLines(dynamicLines)
  const fullPrompt = dynamicPrompt
    ? `${staticPrompt}${CACHE_BOUNDARY_MARKER}${dynamicPrompt}`
    : staticPrompt

  return { staticPrompt, dynamicPrompt, fullPrompt }
}

/**
 * 构建客户端 Agent Runtime 的完整系统提示词（向后兼容）
 *
 * 内部委托到 buildClientSystemPromptStructured，返回 fullPrompt 字符串。
 */
export function buildClientSystemPrompt(params: ClientSystemPromptParams): string {
  return buildClientSystemPromptStructured(params).fullPrompt
}
