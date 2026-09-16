import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ToolHookContext, ToolHookErrorContext, ToolHookResultContext } from '@mtbot/agent-runtime'

const recordToolUsageMock = vi.fn(async () => {})
vi.mock('../../tool-usage-store', () => ({ recordToolUsage: recordToolUsageMock }))

const { createToolUsageHook, FAILURE_SUMMARY_MAX_CHARS } = await import('./tool-usage-hook')

function baseCtx(toolName: string): ToolHookContext {
  return {
    toolCallId: 'tc',
    toolName,
    category: 'web',
    isReadOnly: true,
    needsPermission: false,
    params: Object.freeze({}),
    context: { instanceId: 'inst-1' } as never,
    startTime: Date.now(),
    meta: {},
  }
}

function resultCtx(toolName: string, resultText: string, isError: boolean): ToolHookResultContext {
  return {
    ...baseCtx(toolName),
    result: { content: [{ type: 'text', text: resultText }], details: undefined },
    isError,
    durationMs: 3,
  }
}

function errorCtx(toolName: string, error: unknown): ToolHookErrorContext {
  return { ...baseCtx(toolName), error, durationMs: 3 }
}

beforeEach(() => {
  recordToolUsageMock.mockClear()
})

describe('tool-usage hook', () => {
  it('成功时只计数，不写审计', async () => {
    const audit = vi.fn()
    const hook = createToolUsageHook({ logToolAudit: audit })

    await hook.afterExecute!(resultCtx('web_search', '搜索"x"，共 8 条结果', false))

    expect(recordToolUsageMock).toHaveBeenCalledWith('web_search', false)
    expect(audit).not.toHaveBeenCalled()
  })

  it('工具返回失败结果时，用结果正文当审计摘要', async () => {
    const audit = vi.fn()
    const hook = createToolUsageHook({ logToolAudit: audit })

    await hook.afterExecute!(resultCtx('web_fetch', 'HTTP 404: Failed to fetch https://x/y', true))

    expect(recordToolUsageMock).toHaveBeenCalledWith('web_fetch', true)
    expect(audit).toHaveBeenCalledWith({
      toolName: 'web_fetch',
      resultSummary: 'HTTP 404: Failed to fetch https://x/y',
      isError: true,
    })
  })

  it('工具抛错时，用异常消息当审计摘要', async () => {
    const audit = vi.fn()
    const hook = createToolUsageHook({ logToolAudit: audit })

    await hook.onError!(errorCtx('web_fetch', new Error('HTTP 0: Failed to fetch https://a/b')))

    expect(recordToolUsageMock).toHaveBeenCalledWith('web_fetch', true)
    expect(audit).toHaveBeenCalledWith({
      toolName: 'web_fetch',
      resultSummary: 'HTTP 0: Failed to fetch https://a/b',
      isError: true,
    })
  })

  it('非 Error 抛出物也能归因', async () => {
    const audit = vi.fn()
    const hook = createToolUsageHook({ logToolAudit: audit })

    await hook.onError!(errorCtx('bash', 'boom'))

    expect(audit.mock.calls[0][0].resultSummary).toBe('boom')
  })

  it('摘要压成单行并截断到上限', async () => {
    const audit = vi.fn()
    const hook = createToolUsageHook({ logToolAudit: audit })

    await hook.onError!(errorCtx('web_search', new Error(`第一行\n第二行\n${'长'.repeat(500)}`)))

    const summary = audit.mock.calls[0][0].resultSummary as string
    expect(summary).not.toContain('\n')
    expect(summary.startsWith('第一行 第二行')).toBe(true)
    // 截断后长度 = 上限 + 省略号
    expect(summary.length).toBe(FAILURE_SUMMARY_MAX_CHARS + 1)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('结果没有正文时给可辨认的兜底摘要，而不是空串', async () => {
    const audit = vi.fn()
    const hook = createToolUsageHook({ logToolAudit: audit })

    await hook.afterExecute!({
      ...baseCtx('mcp__x__y'),
      result: { content: [], details: undefined },
      isError: true,
      durationMs: 1,
    })

    expect(audit.mock.calls[0][0].resultSummary).toBe('工具返回失败结果（无正文）')
  })

  it('未注入审计出口时静默降级，不影响计数', async () => {
    const hook = createToolUsageHook()

    expect(() => hook.onError!(errorCtx('bash', new Error('x')))).not.toThrow()
    expect(recordToolUsageMock).toHaveBeenCalledWith('bash', true)
  })
})
