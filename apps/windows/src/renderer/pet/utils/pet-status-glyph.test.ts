/**
 * pet-status-glyph：头顶符号的取值与优先级
 *
 * 锁的是**优先级**——同一时刻只能显示一个符号，而"哪个更该出现"是这里唯一的判断。
 * 另外锁住"没事时返回 null"：常驻一个符号等于没有信号。
 */
import { describe, it, expect } from 'vitest'
import { pickStatusGlyph } from './pet-status-glyph'

const base = { phase: 'idle', idleStage: 'awake', agentActivity: 'idle' }

describe('pickStatusGlyph', () => {
  it('什么都没发生时不出符号（常驻符号等于没有信号）', () => {
    expect(pickStatusGlyph(base)).toBeNull()
  })

  it('发呆、说话、收尾都不出符号——这些是"正常在动"，不需要额外交代', () => {
    for (const phase of ['idle', 'listening', 'recognizing', 'speaking', 'text-reply', 'ending']) {
      expect(pickStatusGlyph({ ...base, phase })).toBeNull()
    }
  })

  it('思考中显示省略号', () => {
    expect(pickStatusGlyph({ ...base, phase: 'thinking' })?.char).toBe('…')
  })

  it('Agent 在想事/干活也显示省略号（文字对话不走语音状态机，只认 phase 会永远不冒）', () => {
    expect(pickStatusGlyph({ ...base, agentActivity: 'thinking' })?.char).toBe('…')
    expect(pickStatusGlyph({ ...base, agentActivity: 'working' })?.char).toBe('…')
    // 说明文案分开，读屏器/悬浮提示能区分
    expect(pickStatusGlyph({ ...base, agentActivity: 'working' })?.label).toBe('正在干活')
  })

  it('Agent 闲着的时候不冒（idle 是常态）', () => {
    expect(pickStatusGlyph({ ...base, agentActivity: 'idle' })).toBeNull()
  })

  it('睡着显示大 Z、打盹显示小 z', () => {
    expect(pickStatusGlyph({ ...base, idleStage: 'asleep' })?.char).toBe('Z')
    expect(pickStatusGlyph({ ...base, idleStage: 'drowsy' })?.char).toBe('z')
  })

  it('Agent 等确认 / 卡住：问号与叹号，且都是 alert', () => {
    const waiting = pickStatusGlyph({ ...base, agentActivity: 'waiting' })
    const blocked = pickStatusGlyph({ ...base, agentActivity: 'blocked' })
    expect(waiting?.char).toBe('?')
    expect(blocked?.char).toBe('!')
    expect(waiting?.tone).toBe('alert')
    expect(blocked?.tone).toBe('alert')
  })

  it('同时有多件事时按「该不该打断用户」排序：等确认 > 卡住 > 思考 > 睡着', () => {
    // Agent 在等确认，同时宠物还睡着（长时间没动）——显示等确认
    expect(
      pickStatusGlyph({ phase: 'idle', idleStage: 'asleep', agentActivity: 'waiting' })?.char,
    ).toBe('?')
    // 卡住 + 睡着 —— 显示卡住
    expect(
      pickStatusGlyph({ phase: 'idle', idleStage: 'asleep', agentActivity: 'blocked' })?.char,
    ).toBe('!')
    // 思考 + 睡着 —— 显示思考
    expect(
      pickStatusGlyph({ phase: 'thinking', idleStage: 'asleep', agentActivity: 'idle' })?.char,
    ).toBe('…')
  })

  it('每个符号都带中文说明（符号本身对读屏器没有语义）', () => {
    const all = [
      pickStatusGlyph({ ...base, agentActivity: 'waiting' }),
      pickStatusGlyph({ ...base, agentActivity: 'blocked' }),
      pickStatusGlyph({ ...base, phase: 'thinking' }),
      pickStatusGlyph({ ...base, idleStage: 'asleep' }),
      pickStatusGlyph({ ...base, idleStage: 'drowsy' }),
    ]
    for (const g of all) {
      expect(g?.label).toBeTruthy()
      expect(g?.char).toHaveLength(1)
    }
  })
})
