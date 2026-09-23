import { describe, expect, it, vi } from 'vitest'
import {
  handleMessageEditAndResend,
  setMiscDependencies,
  handleSessionPreferredModelPrime,
  handleSessionPreferredModelSet,
} from './misc-commands'

describe('session preferred model commands', () => {
  it('persists an explicit model selection', () => {
    const bridge = {
      setSessionPreferredModel: vi.fn(),
      primeSessionModelCompaction: vi.fn(),
      getSessionContextUsage: vi.fn(() => ({
        usedTokens: 0,
        contextWindow: 200_000,
        triggerThreshold: 0.8,
      })),
    }

    handleSessionPreferredModelSet(bridge as never, {
      type: 'session:preferredModel:set',
      sessionKey: 'cron:seed-focus-check',
      modelId: 'gpt-5.6-luna',
    })

    expect(bridge.setSessionPreferredModel).toHaveBeenCalledWith(
      'cron:seed-focus-check',
      'gpt-5.6-luna',
    )
    expect(bridge.primeSessionModelCompaction).not.toHaveBeenCalled()
  })

  it('primes a session without changing its saved model selection', () => {
    const bridge = {
      setSessionPreferredModel: vi.fn(),
      primeSessionModelCompaction: vi.fn(),
      getSessionContextUsage: vi.fn(() => ({
        usedTokens: 0,
        contextWindow: 200_000,
        triggerThreshold: 0.8,
      })),
    }

    handleSessionPreferredModelPrime(bridge as never, {
      type: 'session:preferredModel:prime',
      sessionKey: 'conversation-1',
      modelId: 'gpt-5.6-luna',
    })

    expect(bridge.primeSessionModelCompaction).toHaveBeenCalledWith(
      'conversation-1',
      'gpt-5.6-luna',
    )
    expect(bridge.setSessionPreferredModel).not.toHaveBeenCalled()
  })
})

// ============================================================
// message:edit-and-resend —— 目标消息存在性校验
//
// 缺这道校验的后果不是"编辑没生效"，而是**幽灵消息**：updateMessageContent 命中 0 行时
// 静默通过，而 sendPrompt 是无条件的——新文本进了模型上下文与 Agent 内存历史，却从未落库。
// 2026-09-23 实测现场：渲染层持有已删除会话的陈旧条目，点「编辑并重发」即复现，
// 模型于是引用了一条库里根本不存在的用户消息。
// ============================================================
describe('message:edit-and-resend 的存在性校验', () => {
  const makeHarness = (opts: { exists: boolean; updated: number }) => {
    const sendPrompt = vi.fn(async () => undefined)
    const deleteMessagesAfter = vi.fn(() => 2)
    const updateMessageContent = vi.fn(() => opts.updated)
    const messageExists = vi.fn(() => opts.exists)
    const bridge = {
      conversationRepo: { messageExists, deleteMessagesAfter, updateMessageContent },
    }
    setMiscDependencies({
      getInstanceForSession: vi.fn(async () => 'inst-1'),
      // 非 StatefulContextStrategy —— 跳过 markForceResync 分支
      getIpcChannelAdapter: vi.fn(() => ({ sendPrompt, getContextStrategy: () => ({}) })),
      handleMessageDelete: vi.fn(),
      handleMessageEdit: vi.fn(),
      handleImageRecognize: vi.fn(),
      handleImageGenerate: vi.fn(),
      handleImageProcess: vi.fn(),
    } as never)
    return { bridge, sendPrompt, deleteMessagesAfter, updateMessageContent, messageExists }
  }

  const COMMAND = {
    type: 'message:edit-and-resend',
    sessionKey: 'conv-1',
    messageId: 'ghost-msg',
    newContent: '改过的内容',
  } as never

  it('目标消息不存在 → 拒绝重发，且不触碰会话、不触发模型', async () => {
    const h = makeHarness({ exists: false, updated: 0 })

    const result = await handleMessageEditAndResend(h.bridge as never, COMMAND)

    expect(result).toEqual({ success: false, error: expect.stringContaining('不存在') })
    // 关键：文本绝不能被送进模型上下文
    expect(h.sendPrompt).not.toHaveBeenCalled()
    // 也顺手不改库（已无消息可改，且不该删任何东西）
    expect(h.deleteMessagesAfter).not.toHaveBeenCalled()
    expect(h.updateMessageContent).not.toHaveBeenCalled()
  })

  it('目标消息存在 → 正常重发（防止把这条例行路径一并堵死）', async () => {
    const h = makeHarness({ exists: true, updated: 1 })

    const result = await handleMessageEditAndResend(h.bridge as never, COMMAND)

    expect(result).toEqual({ success: true, messagesRemoved: 2 })
    expect(h.sendPrompt).toHaveBeenCalledOnce()
  })

  it('竞态：存在性检查通过但更新命中 0 行 → 同样拒绝，不触发模型', async () => {
    const h = makeHarness({ exists: true, updated: 0 })

    const result = await handleMessageEditAndResend(h.bridge as never, COMMAND)

    expect(result).toEqual({ success: false, error: expect.stringContaining('已不存在') })
    expect(h.sendPrompt).not.toHaveBeenCalled()
  })
})
