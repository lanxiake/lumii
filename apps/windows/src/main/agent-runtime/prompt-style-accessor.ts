import { DEFAULT_PROMPT_STYLE, type PromptStyleValue } from '../../shared/prompt-style'
import { defineServiceAccessor } from '../../plugins/api'

/**
 * 提示词风格的**核心侧入口**（消费点：`bridge-prompt-dispatcher` 每轮、
 * `bridge-instance-factory` 建实例时）。
 *
 * 插件停用 → 服务消失 → 回落到默认档 `terse`。这正是「禁用即功能消失」的实现。
 */
export interface PromptStyleService {
  get(): Promise<{ style: PromptStyleValue }>
}

const accessor = defineServiceAccessor<PromptStyleService>('promptStyle')

export function setPromptStyleAccessor(fn: (() => PromptStyleService | null) | null): void {
  accessor.setResolver(fn)
}

export async function getPromptStyleSettings(): Promise<{ style: PromptStyleValue }> {
  return (await accessor.get()?.get()) ?? { style: DEFAULT_PROMPT_STYLE }
}
