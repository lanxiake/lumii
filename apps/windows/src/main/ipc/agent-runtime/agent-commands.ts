/**
 * Agent 命令处理器
 *
 * 包括 agent:definitions、agent:memories、agentInstance、agentDefinition
 * 提取自 agent-runtime-ipc.ts
 */

import { BUILT_IN_AGENTS, type AgentDefinition } from '@mtbot/agent-runtime'
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

export async function handleAgentInstanceCreate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentInstance:create' }>,
): Promise<{ ok: boolean; instanceId?: string; error?: string }> {
  try {
    const instanceId = await bridge.createInstance(command.agentDef as AgentDefinition | undefined)
    return { ok: true, instanceId }
  } catch (err) {
    log.error('agentInstance:create failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleAgentInstanceCreateById(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentInstance:createById' }>,
): Promise<{ ok: boolean; instanceId?: string; error?: string }> {
  try {
    const instanceId = await bridge.createInstanceById(command.agentId)
    return { ok: true, instanceId }
  } catch (err) {
    log.error('agentInstance:createById failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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

export function handleAgentDefinitionCacheList(bridge: AgentRuntimeBridge): unknown {
  return bridge.listCachedAgentDefinitions()
}

export function handleAgentDefinitionCacheRemove(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentDefinition:cacheRemove' }>,
): unknown {
  return bridge.removeCachedAgentDefinition(command.agentId)
}

export function handleAgentDefinitionCacheClearOlder(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentDefinition:cacheClearOlder' }>,
): unknown {
  return bridge.clearCachedAgentsOlderThan(command.cutoffIso)
}

export function handleAgentDefinitionCacheClearAll(bridge: AgentRuntimeBridge): { ok: boolean } {
  bridge.clearAllCachedAgentDefinitions()
  return { ok: true }
}

export async function handleAgentDefinitionCacheRefresh(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentDefinition:cacheRefresh' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await bridge.refreshCachedAgentDefinition(command.agentId)
    return { ok: true }
  } catch (err) {
    log.error('agentDefinition:cacheRefresh failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
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

export function handleAgentInstanceLifecycleSnapshot(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'agentInstance:lifecycleSnapshot' }>,
): unknown {
  return bridge.getLifecycleSnapshot(String(command.definitionId ?? ''))
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
