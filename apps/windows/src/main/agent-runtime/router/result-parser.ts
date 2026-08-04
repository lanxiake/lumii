/**
 * Router 输出解析与校验
 *
 * 容错策略（按顺序尝试）：
 * 1. 直接 JSON.parse
 * 2. 抽取 ```json ... ``` 代码块
 * 3. 抽取首个 { ... } 平衡块
 *
 * 解析后 normalizeResult 把异常字段归一化，validateRouterResult
 * 静默丢弃不存在的 Agent/Skill ID。
 */

import type { RouterCandidate, RouterInput, RouterResult } from "./types"

/**
 * 尝试将 Router LLM 的原始字符串解析为 RouterResult。
 * 解析失败抛出 Error，由 RouterService 捕获并走降级。
 */
export function parseRouterResult(raw: string): RouterResult {
  const candidates = [raw.trim(), extractCodeBlock(raw), extractFirstJsonObject(raw)].filter(
    (s): s is string => Boolean(s),
  )

  let lastErr: unknown
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as unknown
      return normalizeResult(obj)
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`Router parse_error: ${String(lastErr ?? "no JSON candidate")}`)
}

/**
 * 校验 Router 输出的 ID 真实存在于 input 中。
 * 不存在的 ID 静默剔除，避免主 LLM 看到幽灵 Agent/Skill。
 */
export function validateRouterResult(result: RouterResult, input: RouterInput): RouterResult {
  const validAgentIds = new Set(input.availableAgents.map((a) => a.id))
  const validSkillIds = new Set(input.availableSkills.map((s) => s.id))
  return {
    ...result,
    topAgents: result.topAgents.filter((c) => validAgentIds.has(c.id)),
    topSkills: result.topSkills.filter((c) => validSkillIds.has(c.id)),
  }
}

// ─── 内部工具 ────────────────────────────────────────────────────

function extractCodeBlock(s: string): string | undefined {
  const m = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  return m?.[1]?.trim()
}

function extractFirstJsonObject(s: string): string | undefined {
  const start = s.indexOf("{")
  if (start < 0) return undefined
  // 简单平衡括号扫描（忽略字符串内的 {}）
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inStr = !inStr
      continue
    }
    if (inStr) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return undefined
}

function normalizeResult(obj: unknown): RouterResult {
  const o = (obj ?? {}) as Record<string, unknown>
  const topAgents = Array.isArray(o.topAgents)
    ? (o.topAgents as unknown[]).slice(0, 3).map(normalizeCandidate)
    : []
  const topSkills = Array.isArray(o.topSkills)
    ? (o.topSkills as unknown[]).slice(0, 5).map(normalizeCandidate)
    : []
  const clarifyOptions = Array.isArray(o.clarifyOptions)
    ? (o.clarifyOptions as unknown[]).slice(0, 4).map((x) => String(x).slice(0, 40))
    : undefined

  return {
    intent: String(o.intent ?? "unknown").slice(0, 40),
    confidence: clamp01(Number(o.confidence ?? 0)),
    topAgents,
    topSkills,
    needsClarification: Boolean(o.needsClarification),
    clarifyQuestion:
      typeof o.clarifyQuestion === "string" && o.clarifyQuestion.trim()
        ? o.clarifyQuestion.trim().slice(0, 200)
        : undefined,
    clarifyOptions: clarifyOptions && clarifyOptions.length > 0 ? clarifyOptions : undefined,
    durationMs: 0,
    fallback: "none",
  }
}

function normalizeCandidate(x: unknown): RouterCandidate {
  const c = (x ?? {}) as Record<string, unknown>
  return {
    id: String(c.id ?? "").trim(),
    score: clamp01(Number(c.score ?? 0)),
    reason: String(c.reason ?? "").slice(0, 80),
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
