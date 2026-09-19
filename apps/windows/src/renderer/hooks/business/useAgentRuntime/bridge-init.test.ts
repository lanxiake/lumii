/**
 * toRuntimeMsg：DB 内容 → 渲染层消息（历史回放的映射）
 *
 * 覆盖 2026-09-20「LLM 错误落盘」的回读端：落库内容里的 llmError 必须映射到消息上，
 * 否则重开会话后，失败的子 Agent 运行块又会退回「已完成」，原因只剩正文里一段散文。
 */
import { describe, expect, it } from 'vitest'
import { toRuntimeMsg } from './bridge-init'
import type { DbMessage } from './useAgentRuntime.types'

function dbMsg(contentJson: unknown, overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: [],
    timestamp: Date.parse('2026-09-20T00:10:00Z'),
    contentJson: JSON.stringify(contentJson),
    ...overrides,
  }
}

const LLM_ERROR = { code: 'insufficient_credits', message: '账户余额不足', retryable: false }

describe('toRuntimeMsg 的 llmError 回读', () => {
  it('落库内容带 llmError → 映射到消息上（历史回放显示失败态的依据）', () => {
    const msg = toRuntimeMsg(
      dbMsg({
        type: 'assistant_parts',
        parts: [{ type: 'text', id: 't1', text: '本轮失败了', status: 'done' }],
        sourceAgent: { instanceId: 'inst-a', label: '子 Agent' },
        llmError: LLM_ERROR,
      }),
    )

    expect(msg.llmError).toEqual(LLM_ERROR)
    expect(msg.sourceAgent).toEqual({ instanceId: 'inst-a', label: '子 Agent' })
  })

  it('旧数据没有该字段 → 不凭空捏造（照常显示完成态）', () => {
    const msg = toRuntimeMsg(
      dbMsg({
        type: 'assistant_parts',
        parts: [{ type: 'text', id: 't1', text: '一切正常', status: 'done' }],
      }),
    )

    expect(msg.llmError).toBeUndefined()
  })
})
