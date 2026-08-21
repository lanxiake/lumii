/**
 * BridgeContextCompactor.callLLM：无 Agent 实例时须能走 fallback stream。
 * 覆盖定时任务 / companion workflow 在无人会话打开时仍需单次 LLM 的场景。
 *
 * compactContextAsync：手动压缩无论消息多少都应发出 LLM 摘要请求并真正压缩。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import { BridgeContextCompactor } from './bridge-context-compactor'

/** 构造最小 deps，默认全部 stream getter 返回空 */
function makeDeps(overrides: Partial<ConstructorParameters<typeof BridgeContextCompactor>[0]> = {}) {
  return {
    getConversationRepo: () => null,
    getInstanceStream: () => undefined,
    getMainInnerStream: () => null,
    getMainModel: () => null,
    getDb: () =>
      ({
        prepare: () => ({ all: () => [], run: () => undefined }),
        exec: () => undefined,
      }) as never,
    ipcChannel: { forwardIpcEvent: vi.fn() } as never,
    restoreHistoryForInstance: vi.fn(),
    createSummaryGenerator: vi.fn(),
    ...overrides,
  }
}

describe('BridgeContextCompactor.callLLM', () => {
  it('无任何 Agent 实例 stream 时抛出明确错误', async () => {
    const compactor = new BridgeContextCompactor(makeDeps())
    await expect(compactor.callLLM('写综述', undefined, 'news_digest')).rejects.toThrow(
      /没有可用的 Agent 实例 stream/,
    )
  })

  it('无实例时走 getFallbackStream，仍可完成单次 LLM 调用', async () => {
    // 标注入参：否则 mock.calls 元素为空元组 []，断言 calls[0]?.[2] 会报 TS2493
    const fallbackStream = vi.fn(async (_model?: unknown, _ctx?: unknown, _opts?: unknown) => {
      return (async function* () {
        yield { type: 'text_delta' as const, delta: '趋势是本地优先。' }
      })()
    })
    const model = { id: 'deepseek-v4-flash', api: 'openai' } as never

    const compactor = new BridgeContextCompactor(
      makeDeps({
        getFallbackStream: () => ({ innerStream: fallbackStream as never, model }),
      }),
    )

    const text = await compactor.callLLM('写综述', undefined, 'news_digest')
    expect(text).toBe('趋势是本地优先。')
    expect(fallbackStream).toHaveBeenCalledOnce()
    expect(fallbackStream.mock.calls[0]?.[2]).toMatchObject({ purpose: 'news_digest' })
  })

  it('有主实例 stream 时优先用主实例，不调用 fallback', async () => {
    const mainStream = vi.fn(async () => {
      return (async function* () {
        yield { type: 'text_delta' as const, delta: '来自主实例' }
      })()
    })
    const fallbackStream = vi.fn()

    const compactor = new BridgeContextCompactor(
      makeDeps({
        getMainInnerStream: () => mainStream as never,
        getMainModel: () => ({ id: 'main-model', api: 'openai' }) as never,
        getFallbackStream: () => ({
          innerStream: fallbackStream as never,
          model: { id: 'fb', api: 'openai' } as never,
        }),
      }),
    )

    await expect(compactor.callLLM('hi')).resolves.toBe('来自主实例')
    expect(fallbackStream).not.toHaveBeenCalled()
  })
})

/** 构造 n 条 user/assistant 交替的 Pi 消息 */
function makePiMessages(n: number): AgentMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `msg-${i}`,
    timestamp: Date.now(),
  })) as AgentMessage[]
}

/**
 * 构造 compactContext / compactContextAsync 所需的最小 DB + repo + stream。
 *
 * `compacted` 记录被移出上下文的消息 id：压缩只做标记，行本身不应从 DB 消失。
 */
function makeCompactHarness(
  messageCount: number,
  summaryText: string | null = '结构化摘要',
  preparedSqlSink?: string[],
) {
  const rows = Array.from({ length: messageCount }, (_, i) => ({
    id: `m${i + 1}`,
    timestamp: `2026-08-13T12:00:0${i}.000Z`,
  }))
  let remaining = [...rows]
  const compacted: string[] = []
  const saved: Array<{
    role: string
    contentJson: { type?: string; text?: string; parts?: Array<{ text?: string }> }
    timestamp?: string
  }> = []
  // 标注入参：否则 mock.calls 元素为空元组 []，断言 calls[0]?.[1] 会报 TS2493
  const generator = vi.fn(async (_a?: unknown, _b?: unknown) => summaryText)
  const restoreHistoryForInstance = vi.fn()
  const forwardIpcEvent = vi.fn()

  const execSink: string[] = []
  const db = {
    prepare: (sql: string) => {
      preparedSqlSink?.push(sql)
      // 只应查询未压缩的活跃消息
      if (sql.includes('FROM messages') && sql.includes('SELECT id')) {
        expect(sql).toContain('compacted_at IS NULL')
        return { all: () => remaining }
      }
      return { all: () => [], run: () => undefined }
    },
    exec: (sql: string) => {
      execSink.push(sql)
    },
  }

  const repo = {
    loadMessagesAsPiFormat: vi.fn(() => makePiMessages(remaining.length + saved.length)),
    markMessagesCompacted: vi.fn((_conversationId: string, ids: readonly string[]) => {
      const marked = new Set(ids)
      remaining = remaining.filter((row) => !marked.has(row.id))
      compacted.push(...ids)
      return ids.length
    }),
    saveMessage: vi.fn(
      (msg: {
        role: string
        contentJson: { type?: string; text?: string; parts?: Array<{ text?: string }> }
        timestamp?: string
      }) => {
        saved.push(msg)
      },
    ),
  }

  const innerStream = vi.fn()
  const model = { id: 'm', api: 'openai' }
  const onSessionContextTokensUpdated = vi.fn()
  const getSessionContextUsage = vi.fn(() => ({
    usedTokens: 212_000,
    contextWindow: 1_000_000,
    triggerThreshold: 0.8,
    breakdown: [
      { category: 'mcp' as const, tokens: 93_300 },
      { category: 'conversation' as const, tokens: 100_000 },
      { category: 'tools' as const, tokens: 9_200 },
    ],
  }))
  const compactor = new BridgeContextCompactor(
    makeDeps({
      getConversationRepo: () => repo as never,
      getDb: () => db as never,
      getInstanceStream: () => ({ innerStream: innerStream as never, model: model as never }),
      getMainInnerStream: () => innerStream as never,
      getMainModel: () => model as never,
      createSummaryGenerator: () => generator,
      restoreHistoryForInstance,
      ipcChannel: { forwardIpcEvent } as never,
      getSessionContextUsage,
      onSessionContextTokensUpdated,
    }),
  )

  return {
    compactor,
    generator,
    compacted,
    saved,
    restoreHistoryForInstance,
    forwardIpcEvent,
    onSessionContextTokensUpdated,
    execSink,
    repo,
  }
}

describe('BridgeContextCompactor.compactContextAsync — 短对话也真正压缩', () => {
  it('4 条消息（少于默认 12 条）仍调用 LLM 并标记旧段、写入摘要', async () => {
    const { compactor, generator, compacted, saved, restoreHistoryForInstance, forwardIpcEvent } =
      makeCompactHarness(4)

    const result = await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(generator).toHaveBeenCalledOnce()
    expect(String(generator.mock.calls[0]?.[1])).toContain('Do NOT call any tools')
    expect(String(generator.mock.calls[0]?.[1])).toContain('Primary Request and Intent')
    expect(result.hadSummary).toBe(true)
    expect(result.messagesRemoved).toBe(2)
    expect(result.previousMessageCount).toBe(4)
    expect(compacted).toEqual(['m1', 'm2'])
    expect(saved).toHaveLength(1)
    expect(saved[0]?.contentJson.type).toBe('assistant_parts')
    expect(saved[0]?.contentJson.parts?.[0]?.text).toContain('结构化摘要')
    expect(saved[0]?.timestamp).toBeDefined()
    expect(Date.parse(saved[0]!.timestamp!)).toBeLessThan(Date.parse('2026-08-13T12:00:02.000Z'))
    expect(restoreHistoryForInstance).toHaveBeenCalledOnce()
    expect(forwardIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'agent:context:compacted', messagesRemoved: 2 }),
    )
  })

  it('压缩卡片用整窗占用，只扣对话差值，MCP 行不变，并带上摘要正文', async () => {
    const { compactor, forwardIpcEvent, onSessionContextTokensUpdated } = makeCompactHarness(4)

    await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    const compacted = forwardIpcEvent.mock.calls
      .map((call) => call[0] as { type?: string; previousTokenCount?: number; newTokenCount?: number; summaryText?: string; breakdown?: Array<{ category: string; tokens: number }> })
      .find((event) => event.type === 'agent:context:compacted')
    expect(compacted?.previousTokenCount).toBe(212_000)
    expect(compacted?.newTokenCount).toBeLessThan(212_000)
    expect(compacted?.newTokenCount).toBeGreaterThan(100_000)
    expect(compacted?.summaryText).toBe('结构化摘要')
    expect(compacted?.breakdown?.find((e) => e.category === 'mcp')?.tokens).toBe(93_300)
    expect(onSessionContextTokensUpdated).toHaveBeenCalledWith('sess-1', compacted?.newTokenCount)

    expect(forwardIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent:context:usage',
        usedTokens: compacted?.newTokenCount,
      }),
    )
  })

  it('1 条消息也会发出摘要请求，并用摘要替换上下文中的原文', async () => {
    const { compactor, generator, compacted, saved } = makeCompactHarness(1)

    const result = await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(generator).toHaveBeenCalledOnce()
    expect(result.hadSummary).toBe(true)
    expect(result.messagesRemoved).toBe(1)
    expect(compacted).toEqual(['m1'])
    expect(saved).toHaveLength(1)
  })

  it('写入用 BEGIN IMMEDIATE 事务包裹，成功时 COMMIT', async () => {
    const { compactor, execSink } = makeCompactHarness(4)

    await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(execSink).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
  })

  it('摘要写入失败时 ROLLBACK，不留下「已移出但无摘要」的半写状态', async () => {
    const { compactor, execSink, repo, saved } = makeCompactHarness(4)
    repo.saveMessage.mockImplementation(() => {
      throw new Error('disk full')
    })

    const result = await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(execSink).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK'])
    expect(result.success).toBe(false)
    expect(result.messagesRemoved).toBe(0)
    expect(result.newMessageCount).toBe(result.previousMessageCount)
    expect(saved).toHaveLength(0)
  })

  it('空会话不调用 LLM', async () => {
    const { compactor, generator } = makeCompactHarness(0)

    const result = await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(generator).not.toHaveBeenCalled()
    expect(result.messagesRemoved).toBe(0)
    expect(result.hadSummary).toBe(false)
  })

  it('摘要失败且仅 1 条消息时不清空上下文', async () => {
    const { compactor, compacted, saved } = makeCompactHarness(1, null)

    const result = await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(result.messagesRemoved).toBe(0)
    expect(result.hadSummary).toBe(false)
    expect(compacted).toEqual([])
    expect(saved).toHaveLength(0)
  })

  it('压缩只标记不删除：不应发出任何 DELETE 语句', async () => {
    const prepared: string[] = []
    const { compactor } = makeCompactHarness(4, '结构化摘要', prepared)

    await compactor.compactContextAsync('inst-1', 'sess-1', 6)

    expect(prepared.some((sql) => sql.includes('DELETE'))).toBe(false)
  })
})

describe('BridgeContextCompactor.compactContext — 同步短对话仍可裁剪', () => {
  it('4 条消息时把一半移出上下文，不再因不足 12 条而跳过', () => {
    const { compactor, compacted } = makeCompactHarness(4)
    const result = compactor.compactContext('sess-1', 6)
    expect(result.messagesRemoved).toBe(2)
    expect(compacted).toEqual(['m1', 'm2'])
  })
})
