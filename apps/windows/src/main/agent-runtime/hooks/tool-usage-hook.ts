/**
 * 工具调用计数 Hook
 *
 * 不设 filter，对所有工具生效：系统工具、MCP 工具（mcp__ 前缀）、技能工具一并计数。
 * afterExecute 与 onError 都记，保证「调用过」这件事不会因为报错而漏掉。
 *
 * 技能维度的命中率另有 skill-hit-rate-hook，这里只做「工具被调了几次」的朴素累加。
 */

import type { ToolHook } from '@mtbot/agent-runtime'
import { recordToolUsage } from '../../tool-usage-store'

export function createToolUsageHook(): ToolHook {
  return {
    name: 'tool-usage-counter',
    afterExecute(ctx) {
      void recordToolUsage(ctx.toolName, ctx.isError)
    },
    onError(ctx) {
      void recordToolUsage(ctx.toolName, true)
    },
  }
}
