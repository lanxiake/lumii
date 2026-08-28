/**
 * Runtime & Workspace sections
 */

import type { ClientSystemPromptParams, WorkspaceLayout, ActiveTaskInfo } from "../system-prompt.types.js"

/**
 * Build the Runtime section (detailed format).
 * Format: Runtime: agent=xxx | host=xxx | os=xxx | model=xxx | channel=xxx | thinking=off | date=2026-04-05
 *
 * @param params - 系统提示词构建参数
 * @param currentModelId - 当前实际使用的模型 ID（覆盖 params.modelId，用于每轮动态刷新）
 */
export function buildRuntimeSection(params: ClientSystemPromptParams, currentModelId?: string): string[] {
  const parts: string[] = []
  const ri = params.runtimeInfo

  if (ri?.agentId) parts.push(`agent=${ri.agentId}`)
  if (ri?.host) parts.push(`host=${ri.host}`)
  if (params.osInfo) parts.push(`os=${params.osInfo}`)
  // 优先使用每轮传入的当前模型 ID（用户切换模型后立即生效）
  const effectiveModelId = currentModelId ?? params.modelId
  if (effectiveModelId) parts.push(`model=${effectiveModelId}`)
  if (ri?.channel) parts.push(`channel=${ri.channel}`)
  parts.push(`thinking=${ri?.thinkingLevel ?? "low"}`)
  const todayDate = new Date().toISOString().slice(0, 10)
  parts.push(`date=${todayDate}`)

  // Windows 客户端上下文说明：让模型明确自己运行在桌面客户端里，
  // 用于判断工具（如 nodes / message / file_write 的 workspace 路径）的语义。
  const isWindowsClient =
    ri?.channel === "windows-agent-runtime" || /MtBot Windows/i.test(ri?.host ?? "")

  const clientContextLines: string[] = []
  if (isWindowsClient) {
    clientContextLines.push(
      "",
      "**Client context:** You are running inside the **MtBot Windows desktop client** (Electron). The local workspace, user files (uploads/outputs/files), user-installed skills, and user-defined agents below all live on this machine. Prefer local tools (`file_*`, `bash`, `glob`, `grep`) for anything involving the user's files. Use `message` / `channel_send` only when explicitly targeting a channel.",
    )
  }

  return [
    "## Runtime",
    `Runtime: ${parts.join(" | ")}`,
    "",
    `**Today's date is ${todayDate}.** When searching or referencing time-sensitive information, always use the current year unless the user specifies otherwise.`,
    ...clientContextLines,
    "",
  ]
}

/**
 * 构建「上下文自动压缩」section（对齐 Claude Code 的 Context management）。
 *
 * 告知 Agent：对话接近上下文上限时系统会自动压缩历史并以摘要继续，
 * 无需提前收尾或中途交接；若需要被压缩掉的精确原文，可用记忆检索回查。
 * 仅当具备记忆检索工具时才给出"回查原文"指针，避免对无记忆能力的会话误导。
 */
export function buildContextManagementSection(toolNames: readonly string[]): string[] {
  const canRecall =
    toolNames.includes("memory_search") || toolNames.includes("memory_read")
  const hasFileWrite = toolNames.includes("file_write")
  const persistTarget = hasFileWrite ? "`file_write` or memory" : "memory"

  const lines = [
    "## Context Compaction",
    `When the conversation grows, the system may summarize older history and continue with that summary. Continue normally; do not stop early or hand off. Keep important decisions, paths, and results in ${persistTarget} because compaction is lossy.`,
  ]
  if (canRecall) {
    lines.push(
      "To recover exact compacted details, use `memory_search` to obtain a `drawer_id`, then read the archived transcript with `memory_read`.",
    )
  }
  lines.push("")
  return lines
}

/**
 * 构建活跃任务 section（注入动态部分，防止目标偏移）
 *
 * 此 section 每轮由宿主层实时注入最新状态，是 task_complete 调用规则的权威位置。
 * LLM 应以本 section 的内容为准，忽略对话历史中的旧状态。
 */
export function buildActiveTasksSection(tasks?: readonly ActiveTaskInfo[]): string[] {
  if (!tasks?.length) return []

  const MAX_SESSION_TASKS = 10
  const MAX_TICKET_TASKS = 5

  const sessionTasks = tasks.filter((t) => t.scope === "session" || !t.scope).slice(0, MAX_SESSION_TASKS)
  const ticketTasks = tasks.filter((t) => t.scope === "ticket").slice(0, MAX_TICKET_TASKS)

  const lines: string[] = []

  if (sessionTasks.length > 0) {
    const incomplete = sessionTasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    )
    const allDone = incomplete.length === 0

    lines.push(
      "## Session Tasks",
      "> **[Live state, injected each turn. Trust this over any older status in the conversation.]**",
      "",
    )
    for (const t of sessionTasks) {
      const owner = t.owner ? ` (assigned: ${t.owner})` : ""
      lines.push(`- [${t.status}] ${t.subject}${owner}`)
    }
    lines.push("")

    // task_complete 调用规则（权威位置，紧跟任务列表）
    if (allDone) {
      lines.push(
        "**All tasks are done.** Verify key outputs actually exist (use `file_read`/`glob` when relevant), then call `task_complete` with a 1–3 sentence summary: what was done, key output, any caveat.",
        "",
      )
    } else {
      lines.push(
        `**${incomplete.length} task(s) still open (${incomplete.map((t) => `"${t.subject}"`).join(", ")}).**`,
        "Do not call `task_complete` until all tasks are finished.",
        "",
      )
    }
  }

  if (ticketTasks.length > 0) {
    lines.push(
      "## Work Orders",
      "> Cross-session work orders. Relevant only for multi-step tasks or when delegated via spawn_agent.",
      "",
    )
    for (const t of ticketTasks) {
      const owner = t.owner ? ` (assigned: ${t.owner})` : ""
      lines.push(`- [${t.status}] ${t.subject}${owner}`)
    }
    lines.push("")
  }

  return lines
}

/**
 * Build the Workspace section (gateway-aligned full version).
 * Includes file organization and strict naming rules.
 */
export function buildWorkspaceSection(cwd: string, layout?: WorkspaceLayout): string[] {
  const uploads = layout?.uploadsDir ?? "uploads"
  const outputs = layout?.outputsDir ?? "outputs"
  const files = layout?.filesDir ?? "files"

  return [
    "## Workspace",
    `Your working directory is: ${cwd}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",
    "### File Organization",
    "The workspace has the following directory structure:",
    `- \`${uploads}/\` — Files uploaded by the user (read from here)`,
    `- \`${outputs}/\` — Files generated by AI (ALWAYS write your output files here)`,
    `- \`${files}/\` — User's personal files (do not write here unless asked)`,
    "",
    `IMPORTANT: When creating, generating, or writing any file, place it under the \`${outputs}/\` subdirectory by default.`,
    "",
    `### Output Organization (inside \`${outputs}/\`)`,
    `Organize by PROJECT / TASK first, by file kind second. Never dump files flat into \`${outputs}/\`.`,
    "",
    `\`${outputs}/<project-or-task>/\` — one directory per project or user task, named after the task itself`,
    "Inside a task directory, split by kind only when the task actually produces several kinds of files:",
    "- `documents/` — reports, articles, notes, markdown, PDF, Word, slides",
    "- `data/` — CSV, JSON, XLSX, and other structured data",
    "- `images/`, `audio/`, `video/` — generated media",
    "- `code/` — scripts and source files meant as deliverables",
    "- `temp/` — scratch and intermediate files; delete these once the task is done",
    "For a small task producing only one or two files, keep them directly in the task directory — do not create single-file subdirectories.",
    "",
    "Rules for choosing the task directory:",
    "- Derive the name from the user's goal, short and stable (e.g. `q3-sales-report`, `竞品调研`), not from the full prompt text",
    "- Continuing or revising earlier work → reuse that SAME task directory instead of creating a near-duplicate; check with `glob` first if unsure which one it was",
    "- Only start a new task directory when the objective is genuinely different",
    `- Truly one-off files with no task context → place directly in \`${outputs}/\``,
    "",
    `For example: \`${outputs}/q3-sales-report/documents/report.html\`, \`${outputs}/q3-sales-report/data/analysis.csv\`, \`${outputs}/竞品调研/images/cover.png\``,
    "Only write to other locations if the user explicitly specifies a different path.",
    "Never create new top-level directories in the workspace root.",
    "",
    "### File & Directory Naming Rules",
    "When creating files or directories, follow these rules STRICTLY:",
    "- Use only safe characters: letters, digits, hyphens, underscores, dots, spaces, and CJK characters",
    '- NEVER use: colons (:：), slashes (/\\), angle brackets (<>), pipes (|), question marks (?), asterisks (*), quotes ("\'), or consecutive dots (..)',
    "- Keep names short and descriptive (under 50 characters)",
    "- Do NOT use the task description or full prompt text as a file/directory name",
    "",
  ]
}
