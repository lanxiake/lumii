/**
 * 打断三档迁移（P0-3 剩余部分）。
 *
 * 老配置只有布尔 `autoMuteMicWhileSpeaking`，新版是 `interruptMode` 三档。
 * 这条用例锁的是**迁移语义**：显式存过 true 的用户当初就在「完全闭麦」，
 * 不能被静默改回两段式——那是替用户改行为，比不做迁移更糟。
 */
import { describe, it, expect } from 'vitest'
import { resolveInterruptMode } from './voice-config-store'

describe('resolveInterruptMode — 旧布尔字段迁移', () => {
  it('老配置 true → mute（保留用户原本的闭麦行为）', () => {
    expect(resolveInterruptMode({ autoMuteMicWhileSpeaking: true })).toBe('mute')
  })

  it('老配置 false → 新默认（两段式），不变更行为', () => {
    expect(resolveInterruptMode({ autoMuteMicWhileSpeaking: false })).toBe('two-stage')
  })

  it('新字段优先于旧字段', () => {
    expect(
      resolveInterruptMode({ interruptMode: 'direct', autoMuteMicWhileSpeaking: true }),
    ).toBe('direct')
  })

  it('都没存 → 默认两段式', () => {
    expect(resolveInterruptMode({})).toBe('two-stage')
  })

  it('脏值（非法字符串）不被当成有效档位', () => {
    expect(
      resolveInterruptMode({ interruptMode: 'bogus' as never, autoMuteMicWhileSpeaking: true }),
    ).toBe('mute')
  })
})
