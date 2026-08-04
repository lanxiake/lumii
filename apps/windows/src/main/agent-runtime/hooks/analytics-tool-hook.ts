/**
 * Analytics 工具埋点 Hook — 与旧版 tool:start / tool:end 中通用 tool_call 上报对齐
 */

import type { ToolHook } from '@mtbot/agent-runtime'
import type { ToolCallEndPayload, ToolCallStartPayload } from '../analytics-reporter'

/** 与 AnalyticsReporter 上报方法兼容的最小接口 */
export interface AnalyticsToolReporter {
  reportToolCallStart(payload: ToolCallStartPayload): void
  reportToolCallEnd(payload: ToolCallEndPayload): void
}

/**
 * 为一次 Agent 运行创建通用工具调用 analytics hook
 *
 * 注意：runId 必须以 getter 形式传入并在每次工具调用时动态读取。
 * RunContext.runId 会在每个 agent:start 被重新赋值（见 event-converter），
 * 若在创建 hook 时快照 runId，则同一实例后续所有工具调用都会被错误归到首个 run，
 * 导致时间线串台、海量事件挂到同一个 run_id。
 *
 * @param reporter - 事件上报器
 * @param run - 运行上下文访问器；runId 为 getter，agentId/sessionKey 实例级稳定
 */
export function createAnalyticsToolHook(
  reporter: AnalyticsToolReporter,
  run: { getRunId: () => string; agentId?: string; sessionKey?: string },
): ToolHook {
  return {
    name: 'analytics',
    beforeExecute(ctx) {
      reporter.reportToolCallStart({
        runId: run.getRunId(),
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        toolName: ctx.toolName,
        toolParams: ctx.params,
      })
    },
    afterExecute(ctx) {
      reporter.reportToolCallEnd({
        runId: run.getRunId(),
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        toolName: ctx.toolName,
        toolResult: ctx.result,
        durationMs: ctx.durationMs,
        success: !ctx.isError,
      })
    },
    onError(ctx) {
      reporter.reportToolCallEnd({
        runId: run.getRunId(),
        agentId: run.agentId,
        sessionKey: run.sessionKey,
        toolName: ctx.toolName,
        durationMs: ctx.durationMs,
        success: false,
        errorMessage: ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
      })
    },
  }
}
