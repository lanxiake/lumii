/**
 * Agent Collaboration & Task Orchestration sections
 */

import type { CustomAgentInfo, RouterResultLite } from "../system-prompt.types.js"

/**
 * 过滤注入「Multi-Agent Collaboration」段的 Agent 列表。
 *
 * - 默认入口 `assistant` 不能作为子 Agent 被委派，需从列表中移除。
 * - 当 `allowedSubAgents` 非空时：仅约束 `builtin:*` 是否出现；用户在 AI 团队自建的 Agent
 *   （非 builtin 命名空间、非 assistant）始终保留，避免白名单误配导致模型看不到用户 Agent。
 */
export function filterAgentsForCollaborationPrompt(
  agents: readonly CustomAgentInfo[],
  allowedSubAgents?: readonly string[],
): CustomAgentInfo[] {
  const withoutEntryAgent = agents.filter((a) => a.id !== "assistant")
  if (!allowedSubAgents?.length) {
    return withoutEntryAgent
  }
  return withoutEntryAgent.filter((a) => {
    if (a.id.startsWith("builtin:")) {
      return allowedSubAgents.includes(a.id)
    }
    return true
  })
}

/**
 * Build the Multi-Agent Collaboration section.
 *
 * 职责：列出可用 Agent + 选择规则 + 结果处理。
 * 不包含任务规划流程（由 buildTaskOrchestrationSection 负责）。
 */
export function buildAgentCollaborationSection(
  agents: readonly CustomAgentInfo[],
  toolNames: readonly string[],
): string[] {
  if (agents.length === 0) return []

  const builtinAgents = agents.filter((a) => a.id.startsWith("builtin:"))
  const userAgents = agents.filter((a) => !a.id.startsWith("builtin:"))

  const renderAgent = (a: CustomAgentInfo) =>
    `- **${a.name}** (id: \`${a.id}\`): ${a.description ?? "General-purpose assistant"}`

  // 内建与用户自定义 Agent 统一在同一列表，按类型分组
  const agentListLines: string[] = []
  if (builtinAgents.length > 0) {
    agentListLines.push("**系统内置专家 (Built-in):**", "")
    agentListLines.push(...builtinAgents.map(renderAgent))
    agentListLines.push("")
  }
  if (userAgents.length > 0) {
    agentListLines.push("**用户自定义 Agent (User-defined, AI Team panel):**", "")
    agentListLines.push(...userAgents.map(renderAgent))
    agentListLines.push("")
  }

  const hasExecutionPlan = toolNames.includes("create_execution_plan")
  const hasDelegate = toolNames.includes("delegate_to_agent")

  const lines: string[] = [
    "## Multi-Agent Collaboration",
    "",
    "You are the orchestrator: delegate work, synthesize results, and communicate with the user.",
    "Delegate by default. Handle a task yourself only when it needs ≤ 2 tool calls, no specialist agent matches, and it is a single direct answer.",
    "",
    "### Available Agents",
    "",
    ...agentListLines,
    "### Selection",
    "",
    "Delegate with `spawn_agent` (`agentType` = agent id):",
    "- Code exploration, search, file reading → `builtin:explore`",
    "- Planning, design, architecture, unclear scope → `builtin:plan`",
    "- Build, test, verify, debug → `builtin:verify`",
    "- A user-defined agent whose name or description matches the domain → prefer it over built-ins",
    "- No match → omit `agentType` and describe the role in `prompt`",
    "",
    "`spawn_agent` is the only delegation mechanism; do not delegate via `send_message`.",
    "",
    "### Writing a Delegation Prompt",
    "",
    "A sub-agent cannot see this conversation. Brief it like a colleague who just walked in:",
    "- State the goal, the background, and what is already known or ruled out.",
    "- Give concrete anchors: file paths, line numbers, function names, keywords.",
    "- Never outsource understanding. Specify what to change and where, rather than 'fix the bug based on your findings'.",
    "- Specify the expected output form and length.",
    "",
    "### Handling Results",
    "",
    "Synthesize sub-agent output rather than pasting it, report the key points concisely, and continue based on the outcome.",
    "If a sub-agent fails, retry with clearer instructions, switch agents, or tell the user.",
    "",
  ]

  // 高级编排模式（仅在相关工具存在时注入）
  if (hasExecutionPlan || hasDelegate) {
    lines.push("### Advanced Orchestration", "")

    if (hasExecutionPlan) {
      lines.push(
        "**Automatic execution plan (for complex multi-step work):** call `create_execution_plan`, wait for user approval, then the system schedules parallel and sequential steps and passes upstream output downstream. Report results when it finishes.",
        "",
      )
    }

    if (hasDelegate) {
      lines.push(
        "**Manual step-by-step delegation:** call `delegate_to_agent` per step and decide the next step from each result.",
        "",
      )
    }
  }

  return lines
}

/**
 * Build the Task Orchestration section.
 *
 * 职责：何时创建任务列表、如何规划依赖、如何收尾。
 * 不包含委派规则（由 buildAgentCollaborationSection 负责）。
 */
export function buildTaskOrchestrationSection(toolNames: readonly string[]): string[] {
  const hasSpawn = toolNames.includes("spawn_agent")
  const hasTodo = toolNames.includes("todo_write")

  if (!hasSpawn && !hasTodo) return []

  const lines: string[] = [
    "## Task Orchestration",
    "",
    "### When to Create a Task List",
    "- Create one when the task spans 3+ steps or needs multiple agents.",
    "- Skip it for single-output tasks (answer a question, produce one file).",
    "",
    "For very complex work (multiple components, architectural decisions, or unclear scope), spawn `builtin:plan` first, then build the task list from its plan.",
    "",
    "### Planning",
    "",
    "Register the whole plan in one `todo_write action=batch_create` call (3–10 tasks) after identifying subtasks and dependencies:",
    "- `parallel=true` for concurrent tasks; `dependsOnIndex=[0,1]` for dependencies (0-based).",
    "- `owner` = agent id when delegating to a specialist.",
    "- Do not create tasks one by one with repeated `action=create`.",
    "",
  ]

  if (hasSpawn) {
    lines.push(
      "Prefer `spawn_agent mode=sync` when you need the result in the same turn.",
      "Use `mode=async` only for parallel long work; the system will inject a",
      "`[SUBAGENT_COMPLETE]` follow-up/new turn when each child finishes.",
      "Do not invent results before that notification arrives.",
      "When using todos with async children, mark tasks complete only after the",
      "corresponding `[SUBAGENT_COMPLETE]` arrives.",
      "Execute in dependency order: start independent parallel work with `mode=async`, then continue serial steps after their `[SUBAGENT_COMPLETE]` notifications (or use `mode=sync` when you must block).",
      "The task list belongs to the orchestrator; sub-agents must not call `todo_write`.",
      "",
    )
  } else {
    lines.push(
      "Then execute in dependency order. The task list belongs to the orchestrator.",
      "",
    )
  }

  lines.push(
    "Finally, mark everything complete or cancelled with `todo_write action=batch_update`, then call `task_complete`.",
    "",
  )

  return lines
}

/**
 * 按 Router 推荐 ID 过滤 Agent。
 * 输入空数组时返回空数组（让上层走"无可用 Agent"分支）。
 */
export function filterAgentsByRouter(
  all: readonly CustomAgentInfo[],
  topAgents: ReadonlyArray<{ readonly id: string }>,
): readonly CustomAgentInfo[] {
  if (topAgents.length === 0) return []
  const ids = new Set(topAgents.map((t) => t.id))
  return all.filter((a) => ids.has(a.id))
}

/**
 * 构建 "Routing rationale" section。
 * 说明 Router 的决策与候选，主 LLM 可参考也可 override。
 */
export function buildRoutingRationaleSection(routerResult: RouterResultLite): string[] {
  const lines: string[] = ["", "## Routing rationale", ""]
  lines.push(
    `Router pre-screened the user's input (intent="${routerResult.intent ?? "unknown"}", confidence=${(routerResult.confidence * 100).toFixed(0)}%).`,
  )
  if (routerResult.topAgents.length > 0) {
    const agentsLine = routerResult.topAgents
      .map((c) => `\`${c.id}\` (${(c.score * 100).toFixed(0)}%${c.reason ? ` — ${c.reason}` : ""})`)
      .join(", ")
    lines.push(`Recommended Agents: ${agentsLine}`)
  }
  if (routerResult.topSkills.length > 0) {
    const skillsLine = routerResult.topSkills
      .map((c) => `\`${c.id}\` (${(c.score * 100).toFixed(0)}%${c.reason ? ` — ${c.reason}` : ""})`)
      .join(", ")
    lines.push(`Recommended Skills: ${skillsLine}`)
  }
  lines.push("")
  // 澄清模式：Router 认为输入可能有歧义。这只是「软建议」——
  // 主 LLM 应先尝试用只读工具（explore / grep / memory_search / file_read）
  // 从已有对话历史和工作空间上下文中自行消歧，确实无法判断时再反问用户。
  // 注意：绝不能因为这段提示就拒绝调用工具——尤其在对话已进行多轮、
  // 上下文已足够推断意图时（Router 的预筛仅基于当前单条输入，常误判为闲聊/模糊）。
  if (routerResult.needsClarification && routerResult.clarifyQuestion) {
    lines.push("**Possible ambiguity flagged by Router** (heuristic, based on the latest input alone).")
    lines.push(
      "First try to resolve it yourself: use read-only tools (explore / grep / memory_search / file_read) and the conversation history to infer intent.",
    )
    lines.push(
      `Only if you still genuinely cannot tell, ask the user — suggested question: "${routerResult.clarifyQuestion}"`,
    )
    if (routerResult.clarifyOptions && routerResult.clarifyOptions.length > 0) {
      lines.push("Possible options to offer:")
      routerResult.clarifyOptions.forEach((opt, i) => lines.push(`  ${i + 1}. ${opt}`))
    }
    lines.push(
      "Do NOT refuse to act or sit idle waiting for clarification when the context already implies the answer — that frustrates the user.",
    )
  } else {
    lines.push(
      "Prefer the highest-scored recommendation. You MAY choose differently if you believe another approach better fits.",
    )
  }
  return lines
}
