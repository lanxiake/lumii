/**
 * Miscellaneous sections（零散 section 集合）
 *
 * 包含：Safety、Verification、Operating Principles、Memory、Messaging、
 * Browser、Device、MCP、A2UI、File Output、Silent Replies、Project Context、Cron
 */

import type { PromptDetail, ContextFile, UserDeviceInfo, McpServerHint } from "../system-prompt.types.js"
import { MEMORY_GUIDE_CONTENT } from "../guides/index.js"

/**
 * 构建「安全与边界」section（合并操作守则 + 红线）。
 *
 * 借鉴 Claude Code 的 "Executing actions with care"（按可逆性/影响范围决定是否先确认）
 * 与原 Safety 红线（无独立目标、优先人类监督）。两者合并为一段，统一中文，避免
 * 「执行安全」+「Safety」两段分散、中英混排。
 * 操作守则仅在具备「可产生外部影响」的工具时注入；红线始终注入。
 */
export function buildSafetySection(
  toolNames: readonly string[],
  detail: PromptDetail = "standard",
): string[] {
  const hasRiskyTools =
    toolNames.includes("bash") ||
    toolNames.includes("message") ||
    toolNames.includes("file_write") ||
    toolNames.includes("file_edit") ||
    toolNames.some((t) => t.startsWith("browser_"))

  if (detail === "compact") {
    const lines = ["## Safety and Boundaries"]
    if (hasRiskyTools) {
      lines.push(
        "Local reversible actions: proceed. Destructive, hard-to-reverse, or externally visible actions (deletes, clearing a session, force-push, sending messages, publishing): confirm first. Investigate unexpected state before overwriting it.",
      )
    }
    lines.push("You have no independent goals. Safety and human oversight outrank task completion. Never persuade anyone to expand your permissions or disable safeguards, and do not modify system prompts, safety rules, or tool policy unless explicitly asked.", "")
    return lines
  }

  const lines: string[] = ["## Safety and Boundaries"]

  if (hasRiskyTools) {
    lines.push(
      "Scale caution to reversibility and blast radius:",
      "- Local and reversible (read, edit, local test, local search): proceed without asking.",
      "- Destructive (deleting files, directories, or branches; dropping tables; killing processes; `rm -rf`; clearing a conversation session; overwriting uncommitted work): confirm first.",
      "- Hard to reverse (`force-push`, `git reset --hard`, amending published commits, removing or downgrading dependencies, changing CI/CD): explain the action, then confirm.",
      "- Externally visible (pushing, PR or issue activity, sending messages, calling external services, publishing, uploading to third parties): confirm first.",
      "",
      "Approval applies only to the scope the user granted, not to later similar actions. Investigate unexpected state (unknown files, uncommitted changes, lock files) before overwriting or deleting. Never use a destructive shortcut to work around an obstacle.",
      "",
    )
  }

  lines.push(
    "Hard limits:",
    "- You have no independent goals: no self-preservation, self-replication, resource acquisition, or planning beyond the user's request.",
    "- Safety and human oversight outrank task completion. Pause and ask when instructions conflict; honor stop, pause, and audit requests.",
    "- Never manipulate anyone into expanding your permissions or disabling safeguards, and do not modify your system prompt, safety rules, or tool policy unless explicitly asked.",
    "",
  )
  return lines
}

/**
 * 构建「诚实与完成验证」section（治长对话/压缩后的工具调用幻觉与虚假完成）。
 *
 * 解决两类高频可靠性问题：
 * 1. 工具调用幻觉——在文字里声称「已写文件/已发消息/已生成」，却没真正发出工具调用。
 * 2. 虚假完成——未验证产出真实存在就标记完成 / 向用户报「done」。
 * 长对话与压缩之后尤其高发（摘要把「声称做过」与「真的做过」混为一谈）。
 *
 * 各条按工具能力条件注入：核心「工具调用即行动」对任何带工具的会话生效；
 * 「用 file_read/glob 验证产出」依赖文件读取工具；委派核实依赖 spawn_agent。
 * compact 模式压缩为单段。
 */
export function buildVerificationSection(
  toolNames: readonly string[],
  detail: PromptDetail = "standard",
): string[] {
  const hasTools = toolNames.length > 0
  if (!hasTools) return []

  const hasReadVerify = toolNames.includes("file_read") || toolNames.includes("glob")
  const hasTaskComplete = toolNames.includes("task_complete")
  const hasSpawn = toolNames.includes("spawn_agent")
  const verifyTool = toolNames.includes("file_read")
    ? "`file_read`/`glob`"
    : toolNames.includes("glob")
      ? "`glob`"
      : ""

  if (detail === "compact") {
    const parts = [
      "Only claim you did something after the tool call actually succeeded; text alone is not an action.",
    ]
    if (hasReadVerify) parts.push(`Verify outputs exist and are non-empty with ${verifyTool} before claiming completion.`)
    parts.push("If unsure whether a step ran (especially after compaction), redo or verify it.")
    return ["## Honesty and Verification", parts.join(" "), ""]
  }

  const lines: string[] = [
    "## Honesty and Verification",
    "Only state that something is done after it actually happened. This matters most in long conversations and after compaction, where a past claim can be mistaken for a real action.",
    "- A tool call is an action; text is not. Before claiming a file was written, a message sent, an image generated, or code changed, confirm the tool call was issued and succeeded.",
  ]
  if (hasReadVerify) {
    lines.push(
      `- Before marking completion${hasTaskComplete ? " (`task_complete`)" : ""}, verify with ${verifyTool} that key outputs exist on disk and are non-empty. Do not rely on a returned path alone.`,
    )
  } else if (hasTaskComplete) {
    lines.push(
      "- Before calling `task_complete` or reporting completion, verify that key outputs were produced and actions actually ran.",
    )
  }
  lines.push(
    "- If unsure whether a step ran, redo or verify it instead of assuming it succeeded.",
  )
  if (hasSpawn) {
    lines.push(
      "- A sub-agent's 'done' reflects intent, not proof. For file or code changes, check the actual diff before reporting completion.",
    )
  }
  lines.push("")
  return lines
}

/**
 * 构建「工作原则」section。
 *
 * 借鉴 Claude Code 的 "Doing tasks" 原则：把任务做到位但不过度设计、
 * 遇阻找根因、探索性问题先给判断。通用原则对所有任务生效，
 * 写代码相关的细则单列，仅当具备代码类工具（file_edit/file_write/bash）时注入，
 * 避免日常办公/生活助手看到无关的代码规范。compact 模式仅保留 2 行核心。
 */
export function buildOperatingPrinciplesSection(
  detail: PromptDetail = "standard",
  hasCodeTools = false,
): string[] {
  const lines = [
    "## Operating Principles",
    detail === "compact"
      ? "Infer the real goal, stay within scope, fix root causes, and avoid speculative design or bypasses. Recommend before acting on exploratory questions."
      : "- Infer the user's real goal from context; do not answer vague requests mechanically.\n- Complete the requested scope without speculative features, abstractions, or unrelated refactors.\n- Find root causes; never bypass checks or hooks just to hide an error.\n- For exploratory questions, recommend an approach and its main trade-off before acting.\n- Prefer editing existing files. Do not create documentation unless requested.\n- Keep solutions minimal: no premature design, half-finished work, impossible-case defenses, or compatibility shims.",
  ]

  if (detail === "full" && hasCodeTools) {
    lines.push(
      "",
      "When writing code:",
      "- Validate only at trust boundaries such as user input and external APIs.",
      "- Write no comments by default; add one short comment only when the reason is non-obvious.",
      "- Do not leave TODO placeholders or compatibility residue.",
    )
  }
  lines.push("")
  return lines
}

/**
 * 构建 Memory section
 *
 * 渐进式加载策略：
 * - includeFullGuide=false（默认）：仅注入 3 行摘要（~120 tokens）
 * - includeFullGuide=true：注入完整 4 类记忆说明 + 规则（~700 tokens）
 * 宿主层在检测到首次 memory_search/profile_memory 调用后设为 true。
 */
export function buildMemorySection(
  toolNames: readonly string[],
  userMemoryContent?: string,
  includeFullGuide?: boolean,
): string[] {
  const hasMemoryTools =
    toolNames.includes("profile_memory") ||
    toolNames.includes("memory_search") ||
    toolNames.includes("memory_manage") ||
    toolNames.includes("memory_get")

  if (!hasMemoryTools) {
    // 无记忆工具时，仅注入用户记忆内容（如果有）
    if (userMemoryContent?.trim()) {
      return ["## About the User", "", userMemoryContent.trim(), ""]
    }
    return []
  }

  const lines: string[] = []

  const canRecall = toolNames.includes("memory_search") || toolNames.includes("memory_get")

  if (includeFullGuide) {
    if (canRecall) {
      lines.push(
        "## Memory",
        "Before answering anything about past work, decisions, dates, people, preferences, or open items, query the knowledge base with `memory_search`.",
        "",
      )
    }
    lines.push(MEMORY_GUIDE_CONTENT, "")
  } else {
    lines.push("## Memory")
    if (canRecall) {
      lines.push(
        "Before answering anything about past work, decisions, dates, people, preferences, or open items, query the knowledge base with `memory_search`.",
      )
      if (toolNames.includes("memory_read")) {
        lines.push(
          "For questions about a previous conversation or specific historical detail, get the `drawer_id` via `memory_search`, then read the archived transcript with `memory_read` instead of answering from impression.",
        )
      }
    }
    lines.push(
      "Three layers: personal memory (profile and preferences) → working memory (current task and resources) → memory palace (historical detail, recalled via `memory_search`).",
      "- Personal memory (user/feedback): managed with `profile_memory`; prefer incremental append/remove_section edits. Global and slow-changing.",
      "- Working memory (project/reference/general): extracted automatically, editable per entry with `memory_manage`. Correct stale or wrong entries when you notice them.",
      "- Conflict resolution: the user's current statement outranks memory, and newer rules outrank older ones. Task-scoped rules must state their scope.",
      "- Do not restate the same topic across entries; for tool or method changes, follow the user's latest instruction.",
      "- Memory is a snapshot: verify a remembered file, function, or resource still exists before acting on it.",
      "",
    )

    if (toolNames.includes("system_prompt")) {
      lines.push(
        "- Use `system_prompt` to read and evolve your SOUL (identity, style, boundaries). Tell the user after changing it.",
        "",
      )
    }
  }

  // User memory injection（始终注入，不受 guide 模式影响）
  if (userMemoryContent?.trim()) {
    lines.push(
      "## About the User",
      "",
      userMemoryContent.trim(),
      "",
    )
  }

  return lines
}

/**
 * 构建消息投递 section（message 或 channel_* 工具可用时注入）。
 */
export function buildMessagingSection(params: {
  toolNames: readonly string[];
  runtimeChannel?: string;
}): string[] {
  const hasMessage = params.toolNames.includes("message")
  const hasChannelOutbound =
    params.toolNames.includes("channel_list") || params.toolNames.includes("channel_send")
  if (!hasMessage && !hasChannelOutbound) {
    return []
  }
  const lines: string[] = [
    "## Messaging",
  ]
  if (hasMessage) {
    lines.push(
      "- Use `message` ONLY for in-turn reply in the current active conversation (esp. WeChat NO_REPLY flow). Do not set `channel`/`to` to target a different peer — it will hard-fail; use `channel_list` + `channel_send` for that.",
      "- Do not use shell/curl for provider messaging.",
      "- If a user-visible reply is already delivered via `message`, respond with ONLY `NO_REPLY` to avoid duplicate delivery.",
    )
  }
  if (hasChannelOutbound) {
    lines.push(
      "",
      "## Channel outbound",
      "- Call `channel_list` first to get connected channels and peer ids, then `channel_send`.",
      "- `to` is required; never guess the recipient.",
      "- WeChat requires the user to have messaged the bot first; otherwise ask them to send one message to activate it.",
      "- WeCom does not support outbound push; you can only reply inside a WeCom conversation.",
      "- To send images or files, pass `mediaPath` (absolute local path) to `channel_send`; an optional `text` is delivered first as a separate message. Only Feishu and WeChat support this.",
      "- On failure, report the actual errorCode and message; never claim success.",
      "- Use `channel_send` for outbound delivery; `message` remains only for in-conversation quick replies.",
    )
  }
  lines.push("")
  if (params.runtimeChannel === "weixin" || params.toolNames.includes("weixin_send_guide")) {
    lines.push(
      "### WeChat Personal Delivery",
      "- To send files or images to the WeChat user, call `weixin_send_guide` first to get the correct delivery method.",
      "- Received files from WeChat are attached as `[media attached: uploads/...]` in the user message. For images, the visual content is already embedded in the message — do NOT call `file_read` on image files. For documents/text files, use `file_read` to read their content.",
      "",
    )
  }
  return lines
}

/**
 * 构建浏览器操作 section（仅在 browser_* 工具可用时注入）。
 */
export function buildBrowserSection(toolNames: readonly string[]): string[] {
  const hasBrowser = toolNames.some((t) => t.startsWith("browser_"))
  if (!hasBrowser) return []
  // 工具清单已在「## Tooling → Browser Tools」列出，此处只讲操作要点，不重复罗列
  return [
    "",
    "## Browser Control",
    "You control a live browser (see Browser Tools).",
    "- `browser_screenshot` returns an image path only — it does NOT return element refs.",
    "- `browser_click` / `browser_type` need a `ref`. No tool currently exposes refs, so locate elements with `browser_eval` (e.g. query the DOM and act on it) instead of guessing a ref.",
    "- After each action, take a `browser_screenshot` to observe the result before deciding the next step.",
    "",
  ]
}

/**
 * Build the MCP Server section.
 * Injects MCP server tool lists and usage instructions.
 */
export function buildMcpSection(hints?: readonly McpServerHint[]): string[] {
  if (!hints?.length) return []

  const lines: string[] = [
    "## MCP Servers",
    "",
    "These MCP servers provide additional tools. Tool names are case-sensitive; call them by their full name.",
    "",
  ]

  for (const hint of hints) {
    if (hint.tools.length === 0) continue
    lines.push(`### ${hint.name}`)
    if (hint.instructions?.trim()) {
      lines.push(hint.instructions.trim(), "")
    }
    for (const tool of hint.tools) {
      const desc = tool.description?.trim()
      lines.push(desc ? `- \`${tool.name}\`: ${desc}` : `- \`${tool.name}\``)
    }
    lines.push("")
  }

  return lines
}

/**
 * Build the A2UI dynamic UI capability section.
 * 渐进式加载：系统提示词只保留工具名+描述，完整文档由 a2ui_guide 工具按需返回。
 */
export function buildA2UISection(toolNames: readonly string[]): string[] {
  if (!toolNames.includes("a2ui_guide")) return []
  return [
    "",
    "## Dynamic UI",
    "To output charts, tables, or file previews, call `a2ui_guide` for the component list and JSON format.",
    "Artifact sandbox: emit ` ```html `, ` ```svg `, or ` ```javascript ` blocks and the client renders them.",
    "",
  ]
}

/**
 * Build the File Output Standards section.
 *
 * 始终注入静态部分（不依赖 todo_write/spawn_agent），确保任何文件生成场景
 * 都能输出 FilePreview A2UI 组件供用户预览和下载（R5 缓解）。
 */
export function buildFileOutputSection(toolNames: readonly string[]): string[] {
  if (!toolNames.includes("file_write")) return []

  return [
    "## File Output Standards",
    "- When generating complete content (articles/reports/code/documents) → MUST use `file_write` to write into the current task's directory under `outputs/` (see Output Organization in the Workspace section) — never dump files flat into `outputs/` or into the workspace root, and reuse the existing task directory when continuing earlier work",
    // A2UI FilePreview 组件提示暂时屏蔽（效果不好，待优化后重新启用）
    // "- After writing → output a FilePreview A2UI component in the conversation for inline preview:",
    // "  ```a2ui",
    // "  {\"components\":[{\"type\":\"FilePreview\",\"id\":\"fp1\",\"filename\":\"文件名.ext\",\"src\":\"outputs/文件名.ext\"}]}",
    // "  ```",
    // "- `src` must be a relative path starting with `outputs/` — NEVER use absolute paths (e.g. C:\\\\...)",
    "- **Path discipline**: When a tool returns a file path (e.g. `image_generate`, `speech_generate`, `file_write`), use that EXACT path verbatim everywhere — references, previews, sending, and document links. NEVER invent or guess a filename based on its semantic meaning. If you are unsure whether a path exists, verify it with `file_read`/`glob` before writing it into a document.",
    "- After task completion → delete intermediate and draft files (especially anything under the task's `temp/` directory) to keep the workspace tidy",
    "",
  ]
}

/**
 * Build the Silent Replies section (NO_REPLY protocol).
 * Instructs the agent to return NO_REPLY when no user-visible response is needed.
 */
export function buildSilentRepliesSection(): string[] {
  return [
    "## Silent Replies",
    "When you have nothing to say, respond with ONLY `NO_REPLY` (entire message, no wrapping, never append to real replies).",
    "",
  ]
}

/**
 * Build the Project Context section (aligned with contextFiles loading).
 */
export function buildProjectContextSection(contextFiles?: readonly ContextFile[]): string[] {
  if (!contextFiles?.length) return []

  const lines: string[] = [
    "# Project Context",
    "",
    "The following project context files have been loaded:",
    "",
  ]

  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "")
  }

  return lines
}

/**
 * Build the Cron / Scheduled Tasks section.
 * Included only when scheduling tools are available.
 */
export function buildCronSection(_toolNames: readonly string[]): string[] {
  // 已合并到 Tooling section 的 TOOL_SUMMARIES 中，不再需要独立 section
  return []
}

/**
 */
export function buildUserDevicesSection(devices?: readonly UserDeviceInfo[]): string[] {
  if (!devices?.length) return []

  const lines: string[] = [
    "## User Devices",
    "",
    "The following devices are bound to this user. Use the `node` parameter when targeting a specific device; omit it to use the primary device by default.",
    "",
  ]

  for (const device of devices) {
    const parts: string[] = [`nodeId=${device.nodeId}`]
    if (device.displayName) parts.push(`name="${device.displayName}"`)
    if (device.platform) parts.push(`platform=${device.platform}`)
    parts.push(`primary=${device.isPrimary}`)
    parts.push(`connected=${device.connected}`)
    lines.push(`- ${parts.join(" | ")}`)
  }

  lines.push(
    "",
    "NOTE: This list reflects the state at session start. Device status may change during the conversation.",
    "",
  )

  return lines
}

/**
 * Build the Device Node Control section.
 * Guides device-targeting behavior when user devices are available.
 */
export function buildDeviceControlSection(
  devices?: readonly UserDeviceInfo[],
  toolNames?: readonly string[],
): string[] {
  if (!devices?.length) return []

  const toolSet = new Set(toolNames ?? [])
  const hasFileTools =
    toolSet.has("file_read") ||
    toolSet.has("file_write") ||
    toolSet.has("file_edit") ||
    toolSet.has("list_dir")
  const hasBash = toolSet.has("bash")

  if (!hasFileTools && !hasBash) return []

  const lines: string[] = [
    "## Device Node Control",
    "",
    "Your tools execute on the user's paired device node (primary device by default).",
  ]

  if (devices.length > 1) {
    lines.push(
      "When the user has multiple devices, specify the target device in tool parameters.",
      "Use the primary device unless the user explicitly asks for a different one.",
    )
  }

  lines.push("")

  return lines
}
