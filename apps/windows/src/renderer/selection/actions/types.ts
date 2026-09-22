/**
 * 动作注册表的类型契约。
 *
 * 浮条与右键菜单共用同一份动作定义（见 registry.ts），所以这里描述的是
 * 「一个划词动作长什么样」，而不是某个具体入口的样子。
 */

import type React from 'react'
import type { QuoteInput } from '../quote-bridge'
import type { SelectionSnapshot } from '../snapshot'

export type SelectionSurface = 'bar' | 'menu'

/** 执行档位：决定动作走哪条通道（见设计 §四） */
export type SelectionTier = 'local' | 'single' | 'agent'

export interface SelectionActionApi {
  /**
   * 收起发起本次动作的那个入口。浮条与菜单互斥，所以不需要分成两个方法。
   */
  close: () => void
  copy: (text: string) => void | Promise<void>
  /** 投一条引用；无投递目标（不在对话页）时返回 false */
  appendQuote: (input: QuoteInput) => boolean
}

export interface SelectionAction {
  id: string
  label: string
  icon?: React.ReactNode
  /** 出现在哪个入口 */
  surface: SelectionSurface | 'both'
  /** 浮条上的次序，小的在前。不上浮条的动作不用给 */
  barOrder?: number
  tier: SelectionTier
  isEnabled?: (ctx: SelectionSnapshot) => boolean
  /** isEnabled 为 false 时对用户的说明 */
  disabledReason?: string
  run: (ctx: SelectionSnapshot, api: SelectionActionApi) => void | Promise<void>
}
