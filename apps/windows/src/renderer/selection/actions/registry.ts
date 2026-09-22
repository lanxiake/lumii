/**
 * 动作注册表 —— 浮条与右键菜单的唯一定义处。
 *
 * 两个入口共用一份定义，是为了避免「两处各写一遍」导致行为漂移：
 * 同一个动作在浮条上能用、在菜单里却不可用这类问题，只要定义分家就迟早出现。
 */

import { localActions } from './local-actions'
import type { SelectionAction, SelectionSurface } from './types'

/** P1 的 singleActions、P3 的 agentActions 按同样的方式并进来 */
const ALL_ACTIONS: readonly SelectionAction[] = [...localActions]

export function getActionsFor(surface: SelectionSurface): SelectionAction[] {
  const list = ALL_ACTIONS.filter((a) => a.surface === 'both' || a.surface === surface)

  if (surface === 'bar') {
    // 未标 barOrder 的排到最后；Array.sort 稳定，同序号保持声明顺序
    return [...list].sort(
      (a, b) => (a.barOrder ?? Number.MAX_SAFE_INTEGER) - (b.barOrder ?? Number.MAX_SAFE_INTEGER),
    )
  }

  // 菜单暂时按声明顺序；分区与分隔线留给步骤 5（届时按 tier 分组）
  return list
}
