/**
 * Agent 命令处理器
 *
 * 包括 agent:definitions、agent:memories、agentInstance、agentDefinition
 * 提取自 agent-runtime-ipc.ts
 */

import { BUILT_IN_AGENTS } from '@mtbot/agent-runtime'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'

const log = {
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

const LOCAL_USER_ID = 'local-user'

// ============================================================
// 命令处理器
// ============================================================

export function handleAgentDefinitionsList(): unknown {
  return BUILT_IN_AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    modelTier: a.modelTier,
    permissionMode: a.permissionMode,
    canSpawnSubAgents: a.canSpawnSubAgents,
    disallowedTools: a.disallowedTools,
    maxTurns: a.maxTurns,
  }))
}

export function handleAgentMemoriesList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:list' }>,
): unknown {
  // 若未指定 sessionKey/agentId，返回该用户所有 Agent 的记忆（记忆管理页全量视图）
  const entries =
    !command.sessionKey && !command.agentId
      ? bridge.memoryManager.listActiveAllAgents(LOCAL_USER_ID)
      : bridge.memoryManager.listActive(
          resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId),
          LOCAL_USER_ID,
        )
  return entries.map((e) => ({
    id: e.id,
    category: e.category,
    content: e.content,
    importance: e.importance,
    createdAt: new Date(e.created_at).getTime(),
    sourceSegmentId: e.source_segment_id,
    palaceDrawerId: e.palace_drawer_id,
    // 归属 Agent 定义 ID。全量视图把多个 Agent 的记忆混在一起返回，
    // 不带这个字段渲染层就无从分辨「这条是谁记的」——记忆管理页的
    // Agent 筛选与来源徽标都读它。
    agentId: e.agent_id,
  }))
}

export function handleAgentMemoriesDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:delete' }>,
): { success: boolean } {
  bridge.memoryManager.deleteMemory(command.memoryId)
  return { success: true }
}

export function handleAgentMemoriesUpdate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:update' }>,
): { success: boolean } {
  bridge.memoryManager.updateMemory(command.memoryId, command.content)
  return { success: true }
}

export function handleAgentMemoriesClear(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:clear' }>,
): { deletedCount: number } {
  const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
  const deletedCount = bridge.memoryManager.clearAllForAgent(agentId, LOCAL_USER_ID)
  return { deletedCount }
}

export function handleAgentMemoriesExport(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:export' }>,
): { json: string } {
  const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
  const entries = bridge.memoryManager.listActive(agentId, LOCAL_USER_ID)
  const json = JSON.stringify(
    entries.map((e) => ({
      id: e.id,
      category: e.category,
      content: e.content,
      importance: e.importance,
      createdAt: e.created_at,
    })),
    null,
    2,
  )
  return { json }
}

export function handleAgentMemoriesProvenance(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:provenance' }>,
): unknown {
  const prov = bridge.memoryManager.getMemoryProvenance(command.memoryId)
  if (!prov) return null
  return {
    memoryId: prov.memoryId,
    sourceSegmentId: prov.sourceSegmentId,
    sourceMessageId: prov.sourceMessageId,
    palaceDrawerId: prov.palaceDrawerId,
    originalText: prov.originalText,
    segment: prov.segment
      ? {
          id: prov.segment.id,
          conversationId: prov.segment.conversationId,
          startMessageId: prov.segment.startMessageId,
          endMessageId: prov.segment.endMessageId,
          createdAt: prov.segment.createdAt,
          turnCount: prov.segment.turnCount,
          charCount: prov.segment.charCount,
        }
      : null,
  }
}

export function handleAgentMemoriesSearch(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:search' }>,
): unknown {
  const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
  const entries = bridge.memoryManager.searchMemories(
    agentId,
    LOCAL_USER_ID,
    command.keyword,
    command.limit,
  )
  return entries.map((e) => ({
    id: e.id,
    category: e.category,
    content: e.content,
    importance: e.importance,
    createdAt: new Date(e.created_at).getTime(),
  }))
}

export function handleAgentMemoriesArchiveCold(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:archiveCold' }>,
): { archivedCount: number } {
  const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
  const archivedCount = bridge.memoryManager.archiveColdMemories(agentId, LOCAL_USER_ID)
  return { archivedCount }
}

export function handleAgentMemoriesUnarchive(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:unarchive' }>,
): { success: boolean } {
  bridge.memoryManager.unarchiveMemory(command.memoryId)
  return { success: true }
}

export function handleAgentMemoriesRebuildIndex(bridge: AgentRuntimeBridge): { rebuiltCount: number } {
  const rebuiltCount = bridge.memoryManager.rebuildMemoryIndex()
  return { rebuiltCount }
}

export function handleAgentMemoriesStats(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agent:memories:stats' }>,
): { hot: number; warm: number; cold: number; total: number } {
  const agentId = resolveAgentIdForMemories(bridge, command.sessionKey, command.agentId)
  const dist = bridge.memoryManager.getTemperatureStats(agentId, LOCAL_USER_ID)
  const total = dist.hot + dist.warm + dist.cold
  return { hot: dist.hot, warm: dist.warm, cold: dist.cold, total }
}

export function handleAgentDefinitionSyncStatus(bridge: AgentRuntimeBridge): unknown {
  return bridge.getDefinitionSyncStatus()
}

export async function handleAgentDefinitionSyncUserAgents(
  bridge: AgentRuntimeBridge,
): Promise<{ ok: boolean; error?: string; synced?: number; failed?: number }> {
  try {
    const result = await bridge.syncUserAgentDefinitions()
    return { ok: true, ...result }
  } catch (err) {
    log.error('agentDefinition:syncUserAgents failed:', err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      synced: 0,
      failed: 0,
    }
  }
}

export async function handleAgentInstancePrompt(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentInstance:prompt' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await bridge.prompt(command.instanceId, command.message)
    return { ok: true }
  } catch (err) {
    log.error('agentInstance:prompt failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function handleAgentInstanceAbort(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentInstance:abort' }>,
): { ok: boolean } {
  bridge.abort(command.instanceId)
  return { ok: true }
}

export function handleAgentInstanceDestroy(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentInstance:destroy' }>,
): { ok: boolean } {
  bridge.destroy(command.instanceId)
  return { ok: true }
}

export function handleAgentInstanceList(bridge: AgentRuntimeBridge): unknown {
  return bridge.getInstances()
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 解析记忆列表/清空所用的 Agent 定义 ID
 */
function resolveAgentIdForMemories(
  bridge: AgentRuntimeBridge,
  sessionKey?: string,
  explicitAgentId?: string,
): string {
  if (explicitAgentId) return explicitAgentId
  if (sessionKey) {
    const fromConv = bridge.conversationRepo.getAgentParticipantId(sessionKey)
    if (fromConv) return fromConv
  }
  return 'assistant'
}
