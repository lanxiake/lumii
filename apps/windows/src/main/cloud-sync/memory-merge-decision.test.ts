/**
 * 记忆行合并判定（P0-2 · 跨设备删除传播）
 *
 * 动因：`deleted_at` 自 V38 就有，但既无生产者（本地删除走硬删），传播规则也只覆盖
 * 「时间戳相同」这一种情况（原情况 4）。而**删除本身不改活动时间**——对端只要注入过一次，
 * 它的 `last_injected_at` 就更大，于是走"远端更新"分支把本地墓碑覆盖回 NULL，已删记忆复活。
 *
 * 本用例锁住的核心规则：**墓碑取胜，不论时间戳谁更新**。
 */
import { describe, expect, it } from 'vitest'
import { decideMemoryMerge, type MemoryMergeInput } from './memory-merge-decision'

const BASE: MemoryMergeInput = {
  localExists: true,
  remoteTs: '2026-09-10T00:00:00.000Z',
  localTs: '2026-09-10T00:00:00.000Z',
  remoteDeletedAt: null,
  localDeletedAt: null,
}

const decide = (over: Partial<MemoryMergeInput>) => decideMemoryMerge({ ...BASE, ...over })

describe('decideMemoryMerge', () => {
  it('本地没有该行 → insert', () => {
    expect(decide({ localExists: false })).toBe('insert')
  })

  it('两侧都活着：时间戳大的取胜', () => {
    expect(decide({ remoteTs: '2026-09-11T00:00:00.000Z' })).toBe('take_remote')
    expect(decide({ localTs: '2026-09-11T00:00:00.000Z' })).toBe('keep_local')
    expect(decide({})).toBe('keep_local') // 相同 → 保持本地
  })

  it('远端已删、本地还活着 → 落墓碑（即使远端时间戳更旧）', () => {
    expect(
      decide({
        remoteDeletedAt: '2026-09-12T00:00:00.000Z',
        remoteTs: '2026-09-01T00:00:00.000Z', // 比本地旧
        localTs: '2026-09-15T00:00:00.000Z',
      }),
    ).toBe('apply_remote_tombstone')
  })

  it('本地已删、远端还活着 → 保住本地墓碑（即使远端时间戳更新）', () => {
    // 这就是修复前的复活路径：远端注入过 → 时间戳更大 → 原来会整行覆盖、删掉的记忆回来
    expect(
      decide({
        localDeletedAt: '2026-09-12T00:00:00.000Z',
        remoteTs: '2026-09-15T00:00:00.000Z',
      }),
    ).toBe('keep_local_tombstone')
  })

  it('两侧都删了 → 取更早的删除时间为准，不复活', () => {
    expect(
      decide({ remoteDeletedAt: '2026-09-01T00:00:00.000Z', localDeletedAt: '2026-09-12T00:00:00.000Z' }),
    ).toBe('apply_remote_tombstone')
    expect(
      decide({ remoteDeletedAt: '2026-09-20T00:00:00.000Z', localDeletedAt: '2026-09-12T00:00:00.000Z' }),
    ).toBe('keep_local')
  })

  it('删除优先于时间戳：任何"时间戳更新"的组合都不能让墓碑失效', () => {
    for (const ts of ['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      expect(decide({ localDeletedAt: '2026-09-12T00:00:00.000Z', remoteTs: ts })).not.toBe(
        'take_remote',
      )
      expect(decide({ remoteDeletedAt: '2026-09-12T00:00:00.000Z', localTs: ts })).not.toBe(
        'take_remote',
      )
    }
  })
})
