/**
 * Router Prompt 模板
 *
 * 生成给路由 LLM 的完整 prompt。
 * 详见 .qoder/design/Agent-Skill编排优化/02-技术设计.md §2.4
 */

import type { RouterAgentInfo, RouterInput, RouterSkillInfo, TurnSummary } from "./types"

/** 单个 Agent 在 prompt 中的最大字符数（防止描述膨胀） */
const MAX_AGENT_BLOCK_CHARS = 400
/** 单个 Skill 在 prompt 中的最大字符数 */
const MAX_SKILL_LINE_CHARS = 200
/** 单条对话摘要的最大字符数 */
const MAX_TURN_CHARS = 200
/** Router prompt 中最多列出的技能数（防止 prompt 过大导致超时） */
const MAX_SKILLS_IN_PROMPT = 48

/**
 * 构造完整的 Router prompt。
 */
export function buildRouterPrompt(input: RouterInput): string {
  return [
    SYSTEM_HEADER,
    JSON_SCHEMA_HINT,
    RULES_BLOCK,
    "## Recent conversation context",
    "",
    formatRecentTurns(input.recentTurns ?? []),
    "",
    "## Available Agents",
    "",
    formatAgents(input.availableAgents),
    "",
    "## Available Skills",
    "",
    formatSkills(input.availableSkills),
    "",
    "## User message (route this)",
    "",
    input.userInput,
    "",
    "## Output JSON now (no markdown fence, no commentary):",
  ].join("\n")
}

const SYSTEM_HEADER = `You are a routing assistant. Given the user's message, decide which Agents and Skills are most relevant for handling it. Output STRICT JSON only.`

const JSON_SCHEMA_HINT = `
## Output schema (strict JSON)

{
  "intent": "<short label like 'code_review' / 'translate' / 'chitchat'>",
  "confidence": <number 0..1, how clear the user's intent is>,
  "topAgents": [
    { "id": "<agent_id>", "score": <0..1>, "reason": "<≤30 字解释>" }
  ],
  "topSkills": [
    { "id": "<skill_id>", "score": <0..1>, "reason": "<≤30 字解释>" }
  ],
  "needsClarification": <true if confidence < 0.6 OR multiple plausible interpretations>,
  "clarifyQuestion": "<反问用户的简短问题, only if needsClarification=true>",
  "clarifyOptions": ["<选项1>", "<选项2>"]
}
`

const RULES_BLOCK = `
## Rules

1. topAgents: at most 3, descending by score; if none clearly fit, return empty array.
2. topSkills: at most 5, descending by score; if none clearly fit, return empty array.
3. If user mentions "/name" or "@name" explicitly, give that Agent/Skill score=1.0.
4. If user input is short/ambiguous ("帮我看看", "试一下", "搞一下"), set needsClarification=true with 2-4 clarifyOptions (中文，每条 ≤ 20 字).
5. reason field is shown to the end-user; write 中文短句, ≤ 30 字, no markdown.
6. Use the same id strings exactly as declared in the Agents/Skills sections below.
7. Confidence guidance:
   - 0.9+: 用户意图清晰、明确指向某个 Agent/Skill
   - 0.6-0.9: 有合理推断但不绝对
   - <0.6: 模糊，必须澄清
`

function formatAgents(agents: readonly RouterAgentInfo[]): string {
  if (agents.length === 0) return "(none available)"
  return agents.map(formatOneAgent).join("\n\n")
}

function formatOneAgent(a: RouterAgentInfo): string {
  const lines: string[] = []
  lines.push(`### ${a.emoji ?? "🤖"} ${a.name} (id: \`${a.id}\`)`)
  if (a.description) lines.push(`Description: ${truncate(a.description, 150)}`)
  if (a.whenToUse) lines.push(`Use when: ${truncate(a.whenToUse, 100)}`)
  if (a.triggerExamples?.length) {
    const examples = a.triggerExamples
      .slice(0, 3)
      .map((e) => `"${truncate(e, 30)}"`)
      .join(", ")
    lines.push(`Examples: ${examples}`)
  }
  const block = lines.join("\n")
  return block.length > MAX_AGENT_BLOCK_CHARS ? block.slice(0, MAX_AGENT_BLOCK_CHARS - 1) + "…" : block
}

function formatSkills(skills: readonly RouterSkillInfo[]): string {
  if (skills.length === 0) return "(none available)"
  const shown = skills.slice(0, MAX_SKILLS_IN_PROMPT)
  const lines = shown.map(formatOneSkill).join("\n")
  if (skills.length > MAX_SKILLS_IN_PROMPT) {
    return (
      lines +
      `\n- …(另有 ${skills.length - MAX_SKILLS_IN_PROMPT} 个技能未列出；闲聊/通用场景通常无需匹配技能)`
    )
  }
  return lines
}

function formatOneSkill(s: RouterSkillInfo): string {
  const useWhen = s.whenToUse ? ` — use when: ${truncate(s.whenToUse, 60)}` : ""
  const line = `- **${s.name}** (id: \`${s.id}\`): ${truncate(s.description, 80)}${useWhen}`
  return line.length > MAX_SKILL_LINE_CHARS ? line.slice(0, MAX_SKILL_LINE_CHARS - 1) + "…" : line
}

function formatRecentTurns(turns: readonly TurnSummary[]): string {
  if (turns.length === 0) return "(none, this is the first turn)"
  return turns
    .slice(-3)
    .map((t) => `${t.role}: ${truncate(t.content, MAX_TURN_CHARS)}`)
    .join("\n")
}

function truncate(s: string, max: number): string {
  if (!s) return ""
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}
