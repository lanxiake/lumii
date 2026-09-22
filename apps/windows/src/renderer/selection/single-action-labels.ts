/**
 * L2 动作的展示名。
 *
 * 单独一份是因为气泡头部要复用它 —— 动作定义里的 label 属于浮条/菜单，
 * 气泡不该去注册表里反查一个「可能已经被过滤掉」的动作。
 */

import type { SelectionLlmAction } from '../../shared/selection-llm-types'

export const SINGLE_ACTION_LABELS: Record<SelectionLlmAction, string> = {
  translate: '翻译',
  explain: '解释',
  summarize: '总结',
  polish: '润色',
}
