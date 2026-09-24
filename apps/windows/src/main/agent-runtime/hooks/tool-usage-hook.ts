/**
 * 工具调用计数 + 失败审计 Hook
 *
 * 不设 filter，对所有工具生效：系统工具、MCP 工具（mcp__ 前缀）、技能工具一并计数。
 * afterExecute 与 onError 都记，保证「调用过」这件事不会因为报错而漏掉。
 *
 * 失败审计（2026-09-16 补）：计数只回答「失败了几次」，答不了「为什么失败」。
 * 本机历史上 web_search 攒了 181 次失败却归不了因，就是因为错误文本从不落地
 * （失败是 throw，而 logging-hook 只在 afterExecute 记，抛错路径整条不可见）。
 * 因此失败时额外写一条 tool_audit_log（is_error=1 + 错误文本前 300 字）。
 *
 * 放在这个 hook 而不是各个工具内部：它是所有工具的统一出口，一处接线全工具受益。
 * 只记失败、不记成功——成功没有归因价值，全量落库只会把审计表淹掉。
 *
 * ⚠️ `tool_audit_log` 有三个写入点，本 hook 只是其中之一（source='tool'）：
 * permission-gate（'permission'，记的是权限决策）与 bridge 的 LLM 请求审计（'llm'）。
 * 按 `COUNT(*)` 读这张表会把三种语义混在一起——先按 source 过滤。
 *
 * 技能维度的命中率另有 skill-hit-rate-hook，这里只做「工具被调了几次」的朴素累加。
 */

import type {
  ToolHook,
  ToolHookErrorContext,
  ToolHookResultContext,
} from '@mtbot/agent-runtime'
import { recordToolUsage } from '../../tool-usage-store'

/** 审计摘要截断长度：够看清归因，又不至于把审计表撑大 */
export const FAILURE_SUMMARY_MAX_CHARS = 300

/** 失败审计落库出口（由 bridge 注入；未注入时静默降级，只计数） */
type ToolFailureAudit = (row: {
  readonly toolName: string
  readonly resultSummary: string
  readonly isError: boolean
  /** 执行耗时（ms）。`ctx.durationMs` 一直是现成的，此前只是没往审计里传 */
  readonly durationMs?: number
}) => void

export interface ToolUsageHookDeps {
  /**
   * 记到哪个 Agent 名下——**定义 id**（`system-keeper`），不是实例 id。
   * 刻意做成必填：漏传会让所有调用静默落进 'unknown'，
   * 而那正是 V44 之前「查不出谁在用」的老毛病，不该有第二次机会。
   */
  readonly agentId: string
  readonly logToolAudit?: ToolFailureAudit
}

/**
 * 压成单行再截断。
 * 压单行不只是省空间：归因要按错误文本 GROUP BY，多行文本会让同一种failure分裂成多组。
 */
function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= FAILURE_SUMMARY_MAX_CHARS
    ? flat
    : `${flat.slice(0, FAILURE_SUMMARY_MAX_CHARS)}…`
}

/** 工具「返回」失败结果（而非抛错）时，从结果正文取原因 */
function summaryFromResult(ctx: ToolHookResultContext): string {
  const blocks = ctx.result?.content
  const block = Array.isArray(blocks) ? blocks.find((c) => c.type === 'text') : undefined
  const text = block && 'text' in block ? String(block.text) : ''
  return truncate(text || '工具返回失败结果（无正文）')
}

/** 工具抛错时，从异常取原因 */
function summaryFromError(ctx: ToolHookErrorContext): string {
  const err = ctx.error
  const message = err instanceof Error ? err.message : String(err)
  return truncate(message || '工具抛错（无消息）')
}

export function createToolUsageHook(deps: ToolUsageHookDeps): ToolHook {
  const { agentId } = deps
  return {
    name: 'tool-usage-and-failure-audit',
    afterExecute(ctx) {
      void recordToolUsage(agentId, ctx.toolName, ctx.isError)
      if (ctx.isError) {
        deps.logToolAudit?.({
          toolName: ctx.toolName,
          resultSummary: summaryFromResult(ctx),
          isError: true,
          durationMs: ctx.durationMs,
        })
      }
    },
    onError(ctx) {
      void recordToolUsage(agentId, ctx.toolName, true)
      deps.logToolAudit?.({
        toolName: ctx.toolName,
        resultSummary: summaryFromError(ctx),
        isError: true,
        durationMs: ctx.durationMs,
      })
    },
  }
}
