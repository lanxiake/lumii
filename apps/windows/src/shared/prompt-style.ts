/**
 * 系统提示词风格取值与归一化（main / preload / renderer 共用一份）
 *
 * 三态：detailed（详细）/ terse（简要）/ minimal（极简）。
 * 存储分散在多处（渲染进程 localStorage、主进程缓存、IPC 载荷），
 * 归一化规则与默认值只在这里维护，避免各处 fallback 漂移。
 *
 * 默认 **terse**（简要）：系统初始化即启用精简档；极简档需用户显式选择。
 */

import type { PromptStyle } from '@mtbot/agent-runtime'

/** 三态风格值（与 @mtbot/agent-runtime 的 PromptStyle 同源，避免两处漂移） */
export type PromptStyleValue = PromptStyle

export const DEFAULT_PROMPT_STYLE: PromptStyleValue = 'terse'

/** 任意输入（存储值 / IPC 载荷 / undefined）归一化为合法风格值 */
export function normalizePromptStyle(value: unknown): PromptStyleValue {
  if (value === 'detailed' || value === 'terse' || value === 'minimal') return value
  return DEFAULT_PROMPT_STYLE
}
