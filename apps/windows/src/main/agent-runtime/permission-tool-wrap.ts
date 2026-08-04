/**
 * 工具超大结果落盘预览替换 — 由原 wrapAgentToolsForPermissionGate 后半段迁移为 Hook
 *
 * 权限闸门逻辑已上移至 host-kit（@mtbot/agent-runtime 的 createPermissionGateHook），
 * 经 PermissionProvider 注入，由 assembleAgent → assembleTools 内部装配。
 */

import type {
  AgentDefinition,
  AgentToolResult,
  PermissionMemory,
  ToolHook,
} from '@mtbot/agent-runtime'
import { WRITE_TOOL_NAMES } from '@mtbot/agent-runtime'
import type { RunContext } from './event-converter'
import {
  maybePersistLargeToolResult,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
} from './tool-result-storage'

/** 权限闸门依赖（由 AgentRuntimeBridge 注入） */
export interface PermissionToolGateDeps {
  readonly definition: AgentDefinition
  readonly runContext: RunContext
  readonly instanceId: string
  readonly permissionMemory: PermissionMemory
  readonly logToolAudit: (row: {
    readonly toolName: string
    readonly resultSummary: string
    readonly isError: boolean
  }) => void
  readonly requestUserPermission: (input: {
    readonly requestId: string
    readonly runId: string
    readonly sessionKey: string
    readonly rootSessionKey: string
    readonly instanceId: string
    readonly toolName: string
    readonly toolArgs: Record<string, unknown>
    readonly description: string
  }) => Promise<'allow-once' | 'allow-always' | 'deny'>
  readonly setCurrentToolExecutorInstanceId: (instanceId: string | undefined) => void
  readonly getCwd?: () => string
  readonly getConversationId?: () => string | undefined
}

/**
 * 判断工具是否属于写/高危操作（用于 IPC 风险等级）
 */
export function riskLevelForTool(toolName: string): 'low' | 'medium' | 'high' {
  return WRITE_TOOL_NAMES.has(toolName) ? 'high' : 'medium'
}

/**
 * 超大工具结果写入磁盘并以预览文本替换 — 作为 afterExecute hook 注册（应在 cache hook 之前）
 */
export function createLargeToolResultHook(deps: Pick<
  PermissionToolGateDeps,
  'getCwd' | 'getConversationId'
>): ToolHook {
  return {
    name: 'large-tool-result',
    async afterExecute(ctx) {
      return maybeReplaceOversizedResult(ctx.result, ctx.toolName, ctx.toolCallId, deps)
    },
  }
}

/**
 * 对工具执行结果做落盘预览替换（如果超过阈值）
 */
function maybeReplaceOversizedResult(
  result: AgentToolResult<unknown>,
  toolName: string,
  toolCallId: string,
  deps: Pick<PermissionToolGateDeps, 'getCwd' | 'getConversationId'>,
): AgentToolResult<unknown> {
  const content = result.content
  if (!content || !Array.isArray(content)) return result

  const cwd = deps.getCwd?.() ?? ''
  const conversationId = deps.getConversationId?.()

  let changed = false
  const newContent = content.map((block: { type?: string; text?: string }) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    if (block.text.length <= DEFAULT_MAX_RESULT_SIZE_CHARS) return block

    const replaced = maybePersistLargeToolResult(
      { toolCallId, toolName, content: block.text, charCount: block.text.length },
      cwd,
      conversationId,
    )
    if (replaced === block.text) return block
    changed = true
    return { ...block, text: replaced }
  })

  if (!changed) return result
  return {
    ...result,
    content: newContent as AgentToolResult<unknown>["content"],
  }
}
