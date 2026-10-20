// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getSlotEntries,
  listSlots,
  registerSlot,
  subscribeSlots,
  __resetSlotsForTest,
} from './slot-registry'

const A = vi.fn() as never
const B = vi.fn() as never
const C = vi.fn() as never

describe('slot-registry', () => {
  beforeEach(() => {
    __resetSlotsForTest()
  })

  it('按 order 排序，相同 order 保持注册顺序', () => {
    registerSlot('s', { id: 'b', component: B, order: 20 })
    registerSlot('s', { id: 'a', component: A, order: 10 })
    registerSlot('s', { id: 'c', component: C, order: 20 })

    expect(getSlotEntries('s').map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('同一 slot 内 id 重复抛错', () => {
    registerSlot('s', { id: 'dup', component: A })

    expect(() => registerSlot('s', { id: 'dup', component: B })).toThrow(/已存在 id/)
  })

  it('不同 slot 可以用相同 id', () => {
    registerSlot('s1', { id: 'same', component: A })
    expect(() => registerSlot('s2', { id: 'same', component: B })).not.toThrow()
  })

  it('注销只移除自己那一条', () => {
    const off = registerSlot('s', { id: 'a', component: A })
    registerSlot('s', { id: 'b', component: B })

    off()

    expect(getSlotEntries('s').map((e) => e.id)).toEqual(['b'])
  })

  it('注销会通知订阅者；重复注销不重复通知', () => {
    const listener = vi.fn()
    subscribeSlots(listener)
    const off = registerSlot('s', { id: 'a', component: A })
    expect(listener).toHaveBeenCalledTimes(1)

    off()
    off() // 第二次已无条目可删，不应再通知
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('空 slot 返回稳定引用（useSyncExternalStore 要求快照稳定）', () => {
    expect(getSlotEntries('nope')).toBe(getSlotEntries('nope'))
  })

  it('listSlots 反映当前注册情况', () => {
    registerSlot('dashboard.main', { id: 'x', component: A })
    registerSlot('dashboard.grid', { id: 'y', component: B })

    expect(listSlots()).toEqual({ 'dashboard.main': ['x'], 'dashboard.grid': ['y'] })
  })
})
