import { describe, expect, it } from 'vitest'
import { buildTurnProgress, type ProgressMessageLike } from './progress'

function assistant(parts: ProgressMessageLike['parts'], isStreaming = true): ProgressMessageLike {
  return { role: 'assistant', isStreaming, timestamp: 1000, parts }
}

describe('buildTurnProgress', () => {
  it('运行中的工具来自 parts（toolCalls 此时还是空的）', () => {
    const progress = buildTurnProgress([
      { role: 'user', isStreaming: false, timestamp: 900, parts: [] },
      assistant([
        { type: 'text', status: 'done' },
        { type: 'tool', name: 'bash', status: 'done' },
        { type: 'tool', name: 'image_generate', status: 'running' },
      ]),
    ])
    expect(progress).toEqual({
      toolName: 'image_generate',
      done: 1,
      total: 2,
      startedAt: 1000,
    })
  })

  it('没有工具但仍在流式 → 阶段未知，也不编分母', () => {
    const progress = buildTurnProgress([assistant([{ type: 'text', status: 'streaming' }])])
    expect(progress).toEqual({ done: 0, total: 0, startedAt: 1000 })
    expect(progress?.toolName).toBeUndefined()
  })

  it('回合已结束 → null', () => {
    expect(
      buildTurnProgress([assistant([{ type: 'tool', name: 'bash', status: 'done' }], false)]),
    ).toBeNull()
  })
})
