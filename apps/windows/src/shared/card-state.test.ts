import { describe, expect, it } from 'vitest'
import {
  actionsForCard,
  buildCardStates,
  summarizeToolError,
  type CardMessageLike,
} from './card-state'

function assistant(
  parts: CardMessageLike['parts'],
  isStreaming = true,
  id = 'm1',
): CardMessageLike {
  return { id, role: 'assistant', timestamp: 1000, isStreaming, parts }
}

describe('buildCardStates', () => {
  it('运行中的生图工具 → running 占位卡（带 prompt）', () => {
    const cards = buildCardStates([
      assistant([
        {
          type: 'tool',
          id: 't1',
          name: 'image_generate',
          status: 'running',
          args: { prompt: '一只兔子', filename: 'rabbit.png' },
        },
      ]),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: 'tool:t1',
      kind: 'image',
      lifecycle: 'running',
      title: 'rabbit.png',
      placeholder: { prompt: '一只兔子', fileName: 'rabbit.png' },
    })
  })

  it('失败 → failed + 可读原因 + 重试（只带 prompt）', () => {
    const cards = buildCardStates([
      assistant(
        [
          {
            type: 'tool',
            id: 't2',
            name: 'image_generate',
            status: 'error',
            isError: true,
            args: { prompt: '一只猫' },
            result: { content: [{ type: 'text', text: '模型超时' }] },
          },
        ],
        false,
      ),
    ])
    expect(cards[0]).toMatchObject({
      lifecycle: 'failed',
      error: '模型超时',
      retry: { toolName: 'image_generate', prompt: '一只猫' },
    })
    expect(actionsForCard(cards[0]!)).toEqual(['retry', 'locate'])
  })

  it('interrupted → cancelled；流式已停止但 status 仍 running 也按 cancelled', () => {
    const cards = buildCardStates([
      assistant(
        [
          { type: 'tool', id: 'a', name: 'image_generate', status: 'interrupted' },
          { type: 'tool', id: 'b', name: 'image_generate', status: 'running' },
        ],
        false,
      ),
    ])
    expect(cards.map((card) => card.lifecycle)).toEqual(['cancelled', 'cancelled'])
  })

  it('未知工具 / 已完成的工具不造卡（ready 交给台账）', () => {
    const cards = buildCardStates([
      assistant([
        { type: 'tool', id: 'x', name: 'bash', status: 'running', args: { command: 'ls' } },
        { type: 'tool', id: 'y', name: 'image_generate', status: 'done' },
      ]),
    ])
    expect(cards).toEqual([])
  })

  it('后台化/非工作区产出工具不造 running 卡（避免闪一下就消失）', () => {
    const cards = buildCardStates([
      assistant([
        { type: 'tool', id: 'a', name: 'mcp__comfyui__enqueue_workflow', status: 'running' },
        { type: 'tool', id: 'b', name: 'screen_record_start', status: 'running' },
      ]),
    ])
    expect(cards).toEqual([])
  })

  it('只看最后一条 assistant 消息；同一消息对象命中缓存', () => {
    const messages: CardMessageLike[] = [
      assistant([{ type: 'tool', id: 'old', name: 'image_generate', status: 'error' }], false, 'm0'),
      assistant([{ type: 'tool', id: 'new', name: 'image_generate', status: 'running' }], true, 'm1'),
    ]
    const first = buildCardStates(messages)
    expect(first.map((card) => card.toolCallId)).toEqual(['new'])
    expect(buildCardStates(messages)).toBe(first)
  })
})

describe('actionsForCard', () => {
  it('按生命周期给一级动作，不出现不可用项', () => {
    expect(
      actionsForCard({ id: 'x', turnId: 't', timestamp: 0, kind: 'image', lifecycle: 'running' }),
    ).toEqual(['abort'])
    expect(
      actionsForCard({ id: 'x', turnId: 't', timestamp: 0, kind: 'image', lifecycle: 'waiting_input' }),
    ).toEqual(['allow-once', 'allow-always', 'deny'])
    expect(
      actionsForCard({ id: 'x', turnId: 't', timestamp: 0, kind: 'image', lifecycle: 'ready' }),
    ).toEqual(['open', 'export', 'locate', 'compare'])
    expect(
      actionsForCard({ id: 'x', turnId: 't', timestamp: 0, kind: 'image', lifecycle: 'failed' }),
    ).toEqual(['locate'])
  })
})

describe('summarizeToolError', () => {
  it('从 message/content/string 提取并截断', () => {
    expect(summarizeToolError({ type: 'tool', id: '1', result: { message: ' nope ' } })).toBe('nope')
    expect(summarizeToolError({ type: 'tool', id: '1', result: '失败' })).toBe('失败')
    expect(summarizeToolError({ type: 'tool', id: '1' })).toBe('工具执行失败')
    expect(summarizeToolError({ type: 'tool', id: '1', result: { message: 'x'.repeat(300) } })).toHaveLength(160)
  })
})
