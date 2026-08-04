/**
 * Router 快路径 — 对明确闲聊/寒暄输入跳过 LLM 调用
 *
 * 避免大技能列表 + 短超时导致的路由请求被 abort。
 */

import type { RouterInput, RouterResult } from "./types"

/** 匹配纯寒暄/打招呼（无需 LLM 路由） */
const CHITCHAT_PATTERN =
  /^(你好|您好|嗨|hi|hello|hey|在吗|在不在|早上好|晚上好|下午好|早安|晚安)([!！?？。.~…\s]*)?$/i

/**
 * 尝试快路径路由：命中则直接返回结果，不调用 LLM。
 */
export function tryRouterFastPath(input: RouterInput): RouterResult | null {
  const text = input.userInput.trim()
  if (!CHITCHAT_PATTERN.test(text)) return null

  const assistant = input.availableAgents.find((a) => a.id === "assistant")

  return {
    intent: "chitchat",
    confidence: 0.95,
    topAgents: assistant
      ? [{ id: assistant.id, score: 0.95, reason: "日常寒暄，走通用入口 Agent" }]
      : [],
    topSkills: [],
    needsClarification: false,
    durationMs: 0,
    fallback: "none",
  }
}
