/**
 * Skills section 构建函数（技能列表、激活提示、自我学习）
 */

import type { SkillInfo, SkillActivationHint, PromptDetail } from "../system-prompt.types.js"

/**
 * 构建 Skills section
 *
 * 两种模式：
 * - 工具化模式（hasSkillTools=true）：系统提示词只保留 ~40 tokens 的工具引导文本，
 *   技能列表/内容通过 skill_list/skill_search/skill_invoke 工具按需获取。
 * - 静态模式（向后兼容）：宿主未注册 skill_* 工具时，回退到原有静态列表注入。
 *   description 截断到 150 字符。
 */
export function buildSkillsSection(
  skills: readonly SkillInfo[],
  readToolName: string,
  _promptDetail: PromptDetail = "standard",
  hasSkillTools = false,
): string[] {
  if (skills.length === 0) return []

  const MAX_INLINE = 30  // 最多内联展示条数
  const MAX_DESC = 120   // 描述截断长度

  // 工具化模式：展示技能列表（按使用频率排序，最多 50 条）+ 搜索说明
  if (hasSkillTools) {
    // 按 usageCount 降序排序，未提供时视为 0
    const sorted = [...skills].sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))
    const visible = sorted.slice(0, MAX_INLINE)
    const hiddenCount = sorted.length - visible.length

    const lines: string[] = [
      "## Skills",
      "",
      "Available skills, ordered by usage. When a skill matches the task, you MUST use it instead of improvising the workflow.",
      "",
    ]

    for (const s of visible) {
      const raw = (s.description || "").replace(/\n+/g, " ").trim()
      const desc = raw.length <= MAX_DESC ? raw : raw.slice(0, MAX_DESC - 1) + "…"
      if (s.executable && s.id) {
        lines.push(`- **${s.name}**: ${desc} → \`execute_skill({id: "${s.id}", params: {...}})\``)
      } else {
        lines.push(`- **${s.name}**: ${desc}`)
      }
    }

    if (hiddenCount > 0) {
      lines.push("", `(${hiddenCount} more skills not shown — use \`skill_search\` to find them.)`)
    }

    lines.push(
      "",
      "**Skip skill lookup** for plain conversation, simple questions, or tasks finishable in ≤ 2 tool calls.",
      "",
      "**Usage:** pick the matching skill → `skill_invoke(name)` to load its full SKILL.md → follow those instructions.",
      "To find more skills, call `skill_search(keywords)` with both English and Chinese terms.",
      "Search syntax: comma = OR, space = AND. Prefer multi-term OR searches.",
      "",
    )
    return lines
  }

  // 静态模式（向后兼容，无 skill_search 工具时）：注入完整技能列表
  const MAX_DESC_STATIC = 150
  const baseDir = extractSkillBaseDir(skills)

  const hasExecutable = skills.some((s) => s.executable)

  const lines: string[] = [
    "## Skills",
    "**IMPORTANT: Always check this skill list before responding to any user request.**",
    "If a skill clearly matches the user's task, you MUST use it.",
    "Only handle the task directly if no skill applies.",
    "",
  ]

  if (hasExecutable) {
    lines.push(
      "Skills marked with **[executable]** MUST be invoked via `execute_skill` tool — do NOT try to run them manually.",
      `Use \`${readToolName}\` to read a skill's SKILL.md for parameter details: \`${readToolName}({path: "{skillPath}/SKILL.md"})\``,
      "",
    )
  } else {
    lines.push(
      `Use \`${readToolName}\` to read a skill's SKILL.md first, then follow its guidance.`,
      "",
    )
  }

  for (const s of skills) {
    const raw = s.description.replace(/\n+/g, " ").trim()
    const desc = raw.length <= MAX_DESC_STATIC ? raw : raw.slice(0, MAX_DESC_STATIC - 1) + "…"
    let skillPath = baseDir && s.location.startsWith(baseDir)
      ? s.location.slice(baseDir.length).replace(/^[/\\]/, "")
      : s.location
    skillPath = skillPath.replace(/[/\\]SKILL\.md$/i, "")

    if (s.executable && s.id) {
      lines.push(`- **${s.name}** [executable] (\`${skillPath}\`): ${desc} → \`execute_skill({id: "${s.id}", params: {...}})\``)
    } else {
      lines.push(`- **${s.name}** (\`${skillPath}\`): ${desc}`)
    }
  }

  if (baseDir) {
    lines.push("", `Skills directory: ${baseDir} (read: {path}/SKILL.md)`)
  }

  lines.push("")
  return lines
}

/**
 * 构建技能激活提示 section（动态部分）
 *
 * 参考 CCR `src/tools/SkillTool/prompt.ts` 的显式激活文本，
 * 但使用结构化列表输出以便 LLM 稳定解析。
 *
 * - `mandatory` 分层使用 MUST 强约束
 * - `suggested` 分层使用 SHOULD 弱约束
 * - 无激活命中时不输出任何 section（避免空标题浪费 token）
 */
export function buildSkillActivationSection(
  hints: readonly SkillActivationHint[],
  readToolName: string,
): string[] {
  if (!hints || hints.length === 0) return []

  const mandatory = hints.filter((h) => h.tier === "mandatory")
  const suggested = hints.filter((h) => h.tier === "suggested")

  const lines: string[] = ["", "## Skill Activation"]

  if (mandatory.length > 0) {
    lines.push(
      "The following skills MUST be loaded before continuing — use " +
        `\`${readToolName}\` to read each SKILL.md and follow its guidance:`,
    )
    for (const h of mandatory) {
      const reason = formatActivationReason(h.reason)
      const detail = h.detail ? ` — ${h.detail}` : ""
      lines.push(`- **${h.skillName}** (${reason})${detail}`)
    }
  }

  if (suggested.length > 0) {
    if (mandatory.length > 0) lines.push("")
    lines.push(
      "Consider loading these skills if they apply to the current task " +
        `(use \`${readToolName}\` to read SKILL.md):`,
    )
    for (const h of suggested) {
      const reason = formatActivationReason(h.reason)
      const detail = h.detail ? ` — ${h.detail}` : ""
      lines.push(`- ${h.skillName} (${reason})${detail}`)
    }
  }

  return lines
}

function formatActivationReason(reason: SkillActivationHint["reason"]): string {
  switch (reason) {
    case "path_glob":
      return "path match"
    case "intent_match":
      return "intent match"
    case "user_explicit":
      return "user asked"
    case "rule":
      return "rule"
    default:
      return "match"
  }
}

/**
 * 从 SkillInfo[] 的 location 中提取公共基础目录
 *
 * 支持两种目录层级：
 * - 无分类：`/path/to/skills/skill-name/SKILL.md`  → 去掉末尾 2 段
 * - 有分类：`/path/to/skills/category/skill-name/SKILL.md` → 去掉末尾 3 段
 *
 * 通过对所有 location 取公共前缀来自动适配混合情况。
 */
function extractSkillBaseDir(skills: readonly SkillInfo[]): string | null {
  if (skills.length === 0) return null

  const sep = skills[0].location.includes("\\") ? "\\" : "/"

  // 每个 location 去掉末尾的 SKILL.md 文件名，再去掉技能目录名，得到候选基础目录
  // 无分类：去掉 2 段；有分类：去掉 3 段
  const candidates = skills.map((s) => {
    const parts = s.location.split(sep)
    // 至少需要 3 段（baseDir/skillName/SKILL.md）
    if (parts.length < 3) return null
    // 去掉末尾 2 段（skillName/SKILL.md）得到候选
    return parts.slice(0, -2).join(sep)
  }).filter((p): p is string => p !== null)

  if (candidates.length === 0) return null

  // 取所有候选的公共前缀目录
  const first = candidates[0]
  let commonDir = first
  for (const c of candidates.slice(1)) {
    // 逐段比较，找到最长公共前缀
    const aParts = commonDir.split(sep)
    const bParts = c.split(sep)
    let i = 0
    while (i < aParts.length && i < bParts.length && aParts[i] === bParts[i]) i++
    commonDir = aParts.slice(0, i).join(sep)
    if (!commonDir) return null
  }

  return commonDir || null
}

export function buildSelfLearningSection(toolNames: readonly string[]): string[] {
  const hasMemory = toolNames.includes("profile_memory") || toolNames.includes("memory_search")
  const hasSoul = toolNames.includes("system_prompt")
  const hasSkillTools = toolNames.includes("skill_search") || toolNames.includes("skill_list")
  if (!hasMemory && !hasSoul && !hasSkillTools) return []

  const lines: string[] = [
    "## Self-Improvement",
  ]
  if (hasMemory) {
    lines.push(
      "- When the user corrects you, save the reusable lesson and its reason as a feedback memory.",
      "- When the user confirms a non-obvious approach, save that too so you do not drift away from it.",
    )
  }
  if (hasSoul) {
    lines.push(
      "- When your understanding of your own identity, style, or boundaries sharpens, update your SOUL with `system_prompt` and tell the user.",
    )
  }
  if (hasSkillTools) {
    lines.push(
      "- When a task recurs with a stable procedure, propose turning it into a skill instead of redoing it from scratch.",
    )
  }
  lines.push("")
  return lines
}

// ─── Pre-LLM Router 集成辅助函数 ─────────────────────────────────────

/** Skill 的匹配键：优先 id，无 id 时 fallback 到 name */
export function skillKey(s: SkillInfo): string {
  return (s.id ?? s.name).trim()
}

/**
 * 按 Router 推荐 ID 过滤技能。
 * 输入空数组时返回空数组（让上层走"无 Skill"分支，而不是 fallback 全量）。
 */
export function filterSkillsByRouter(
  all: readonly SkillInfo[],
  topSkills: ReadonlyArray<{ readonly id: string }>,
): readonly SkillInfo[] {
  if (topSkills.length === 0) return []
  const ids = new Set(topSkills.map((t) => t.id))
  return all.filter((s) => ids.has(skillKey(s)))
}
