import type React from 'react'

/** 一个 slot 条目：谁提供的、放在哪个槽位、渲染成什么 */
export interface SlotEntry<P = unknown> {
  id: string
  component: React.ComponentType<P>
  /** 排序权重，小的在前；相同则按注册顺序 */
  order?: number
  /** 提供者标识（内置写 'builtin'，插件写插件 id），用于诊断与卸载 */
  owner?: string
}

/** 存储形态：组件类型在这里被擦除，读取方（SlotHost）再按 context 重新收窄 */
interface StoredEntry {
  id: string
  component: React.ComponentType<any>
  order?: number
  owner?: string
  seq: number
}

const slots = new Map<string, StoredEntry[]>()
const listeners = new Set<() => void>()
let seq = 0

/**
 * 快照缓存： 要求同一状态返回**同一引用**，
 * 否则每次渲染都判定为变化 → 无限循环（真机实测：Maximum update depth exceeded）。
 * 任何增删都清空缓存并通知。
 */
const snapshots = new Map<string, SlotEntry[]>()

function notify(): void {
  snapshots.clear()
  for (const l of listeners) l()
}

/**
 * 注册一个 slot 条目，返回注销函数。
 *
 * 约定：
 * - `id` 在**同一 slot 内**唯一，重复注册抛错（后者静默覆盖会让「谁生效」取决于加载顺序）；
 * - 注销只移除自己那一条，不影响后来注册的同名条目（热重载场景）；
 * - 每次变更都会通知订阅者（`useSyncExternalStore` 依赖它）。
 */
export function registerSlot<P>(slot: string, entry: SlotEntry<P>): () => void {
  const list = slots.get(slot) ?? []
  if (list.some((e) => e.id === entry.id)) {
    throw new Error(`slot "${slot}" 里已存在 id "${entry.id}"`)
  }
  const stored: StoredEntry = { ...entry, seq: seq++ }
  slots.set(slot, [...list, stored])
  notify()

  return () => {
    const current = slots.get(slot) ?? []
    const next = current.filter((e) => e !== stored)
    if (next.length === current.length) return
    if (next.length === 0) slots.delete(slot)
    else slots.set(slot, next)
    notify()
  }
}

/** 取某个 slot 的条目（按 order、再按注册顺序）。函数引用稳定，供 useSyncExternalStore 用。 */
export function getSlotEntries(slot: string): SlotEntry[] {
  const cached = snapshots.get(slot)
  if (cached) return cached

  const list = slots.get(slot)
  const snapshot = !list || list.length === 0
    ? EMPTY
    : [...list]
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.seq - b.seq)
        .map(({ seq: _seq, ...entry }) => entry)
  snapshots.set(slot, snapshot)
  return snapshot
}

const EMPTY: SlotEntry[] = []

export function subscribeSlots(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 诊断：当前所有 slot 及其条目 id */
export function listSlots(): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [slot, list] of slots) out[slot] = getSlotEntries(slot).map((e) => e.id)
  return out
}

/** 仅测试用 */
export function __resetSlotsForTest(): void {
  slots.clear()
  snapshots.clear()
  listeners.clear()
  seq = 0
}
