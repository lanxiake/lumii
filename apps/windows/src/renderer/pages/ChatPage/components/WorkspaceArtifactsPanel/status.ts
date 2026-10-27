/**
 * 任务组状态点（纯函数）
 *
 * 只描述**当前这一轮**：历史轮次的状态已经从消息里回放完，不需要再猜。
 * 优先级（设计 §4.5）：等你拍板 > 进行中 > 失败 > 完成——
 * 「等你拍板」是最需要人介入的状态，不能被同回合别的失败盖掉。
 */

import type { ArtifactCardState, CardLifecycle } from '../../../../../shared/card-state'

export type GroupStatus = 'waiting_input' | 'running' | 'failed' | 'done'

export const GROUP_STATUS_LABEL: Record<GroupStatus, string> = {
  waiting_input: '等你拍板',
  running: '进行中',
  failed: '有失败',
  done: '已完成',
}

function toGroupStatus(lifecycle: CardLifecycle): GroupStatus {
  if (lifecycle === 'waiting_input') return 'waiting_input'
  if (lifecycle === 'running') return 'running'
  if (lifecycle === 'failed' || lifecycle === 'cancelled') return 'failed'
  return 'done'
}

/** 一组卡片合成一个状态；空数组=完成（历史组） */
export function groupStatusOf(cards: readonly ArtifactCardState[]): GroupStatus {
  let best: GroupStatus = 'done'
  const rank: Record<GroupStatus, number> = { waiting_input: 4, running: 3, failed: 2, done: 1 }
  for (const card of cards) {
    const status = toGroupStatus(card.lifecycle)
    if (rank[status] > rank[best]) best = status
  }
  return best
}
