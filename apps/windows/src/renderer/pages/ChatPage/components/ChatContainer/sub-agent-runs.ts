/**
 * 子 Agent 消息归属（纯函数）
 *
 * 背景（2026-09-14，见 docs/plans/专项Agent/08-委托可见性.md §4）：
 * 子 Agent 与父实例共享同一个 `conversationId`（orchestrator.ts:439 有意为之），
 * 因此父会话的消息流里混着子 Agent 的 assistant 消息。渲染层此前把子消息的 `parts`
 * **纯拼接进父消息**（ChatContainer 的 mergeAssistantParts），代价是：
 * - 父气泡的「执行过程」被子的思考/工具污染；
 * - 父消息 `isStreaming` 被置 true 后，`ThinkingBlock` 的 `isLive` 让**所有**思考块同时变活
 *   ——用户看到「两个思考中都在输出」；
 * - 子 Agent 的身份（名字、状态）在气泡里彻底消失。
 *
 * 本模块只做一件事：把子消息按 `instanceId` 归到**前一条主 Agent 消息**名下，
 * 交给渲染层作为该消息的「子运行」呈现。不改动任何父消息的 `parts`。
 */

import type { AssistantPart, FileChangeEntry } from '@mtbot/agent-runtime/browser'

/** 一次子 Agent 运行（同一实例的多条消息合并为一段轨迹） */
export interface SubAgentRun {
  readonly instanceId: string
  /** 显示名（P1 之后来自定义侧的真实名） */
  readonly label: string
  /** 该运行是否仍在流式输出（同一实例后续消息到达时会被抬升） */
  isStreaming: boolean
  /** 轨迹内容（按消息顺序拼接） */
  parts: readonly AssistantPart[]
  fileChanges?: readonly FileChangeEntry[]
  /** 该运行首条消息的时间 */
  readonly timestamp: Date
}

/** 归组输入所需的最小消息结构（MessageItem 满足此形状） */
export interface GroupableMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  timestamp: Date
  isStreaming?: boolean
  sourceAgent?: { instanceId: string; label: string }
  parts?: readonly AssistantPart[]
  fileChanges?: readonly FileChangeEntry[]
}

export interface SubAgentRunGrouping {
  /** 父消息 id → 挂在其下的子运行（按出现顺序；同一实例的多条消息已合并） */
  runsByParent: Map<string, SubAgentRun[]>
  /** 已被归组的子消息 id：不再作为独立时间线单元渲染 */
  attachedMessageIds: Set<string>
}

/**
 * 把带 `sourceAgent` 的消息归到前一条**主 Agent**（无 sourceAgent 的 assistant）消息下。
 *
 * 规则与既有行为保持一致，只把「合并 parts」换成「独立成组」：
 * - 只有 assistant 且无 sourceAgent 的消息才是父候选（与旧实现同一个回溯条件）；
 * - 找不到父的子消息**保留为独立单元**（旧实现在 `continue` 里把它整条丢掉了）；
 * - 子消息不得成为父（否则链式嵌套会吞掉整棵树）。
 *
 * 输入顺序即时间线顺序；函数内部按 timestamp 稳定排序，调用方不必先排。
 */
export function groupSubAgentRuns(messages: readonly GroupableMessage[]): SubAgentRunGrouping {
  const sorted = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

  const runsByParent = new Map<string, SubAgentRun[]>()
  const attachedMessageIds = new Set<string>()
  let currentParentId: string | null = null

  for (const msg of sorted) {
    const instanceId = msg.sourceAgent?.instanceId
    if (instanceId) {
      // 无父可挂：留给调用方作为独立单元渲染（不丢内容）
      if (!currentParentId) continue

      const runs = runsByParent.get(currentParentId) ?? []
      const existing = runs.find((run) => run.instanceId === instanceId)
      if (existing) {
        // 就地追加：同一实例可能有几十条消息，反复展开新数组是 O(n²)
        ;(existing.parts as AssistantPart[]).push(...(msg.parts ?? []))
        existing.isStreaming = existing.isStreaming || Boolean(msg.isStreaming)
        const merged = mergeFileChanges(existing.fileChanges, msg.fileChanges)
        if (merged.length > 0) existing.fileChanges = merged
      } else {
        runs.push({
          instanceId,
          label: msg.sourceAgent?.label ?? '子 Agent',
          isStreaming: Boolean(msg.isStreaming),
          parts: [...(msg.parts ?? [])],
          ...(msg.fileChanges && msg.fileChanges.length > 0 ? { fileChanges: msg.fileChanges } : {}),
          timestamp: msg.timestamp,
        })
      }
      runsByParent.set(currentParentId, runs)
      attachedMessageIds.add(msg.id)
      continue
    }

    if (msg.role === 'assistant') currentParentId = msg.id
  }

  return { runsByParent, attachedMessageIds }
}

/** 按 path 去重合并文件变更（子条目覆盖同路径父条目），与 mergeFileChanges 语义一致 */
function mergeFileChanges(
  a: readonly FileChangeEntry[] | undefined,
  b: readonly FileChangeEntry[] | undefined,
): FileChangeEntry[] {
  const seen = new Map<string, FileChangeEntry>()
  for (const entry of [...(a ?? []), ...(b ?? [])]) seen.set(entry.path, entry)
  return [...seen.values()]
}
