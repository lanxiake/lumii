/**
 * 任务组状态点：优先级矩阵（等你拍板 > 进行中 > 失败 > 完成）。
 */
import { describe, expect, it } from 'vitest'
import { groupStatusOf } from './status'
import type { ArtifactCardState, CardLifecycle } from '../../../../../shared/card-state'

function card(lifecycle: CardLifecycle): ArtifactCardState {
  return {
    id: `c-${lifecycle}`,
    turnId: 't1',
    timestamp: 1,
    kind: 'doc',
    lifecycle,
  }
}

describe('groupStatusOf', () => {
  it('空数组 = 已完成（历史组）', () => {
    expect(groupStatusOf([])).toBe('done')
  })

  it.each([
    [['ready'], 'done'],
    [['failed'], 'failed'],
    [['cancelled'], 'failed'],
    [['running'], 'running'],
    [['waiting_input'], 'waiting_input'],
    [['running', 'failed'], 'running'],
    [['running', 'waiting_input'], 'waiting_input'],
    [['failed', 'waiting_input'], 'waiting_input'],
  ] as const)('%j → %s', (lifecycles, expected) => {
    expect(groupStatusOf(lifecycles.map(card))).toBe(expected)
  })
})
