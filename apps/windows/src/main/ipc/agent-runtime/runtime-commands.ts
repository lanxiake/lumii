/**
 * Runtime 命令处理器（runtime:*）
 *
 * 运行时状态：ping、featureFlags、enabled、modelCatalog
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'

export function handleRuntimePing(): { ok: boolean } {
  return { ok: true }
}

export function handleRuntimeFeatureFlagsGet(bridge: AgentRuntimeBridge): unknown {
  return bridge.getFeatureFlags()
}

export function handleRuntimeFeatureFlagsSet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'runtime:featureFlags:set' }>,
): unknown {
  bridge.setFeatureFlags(command.flags)
  return bridge.getFeatureFlags()
}

export function handleRuntimeEnabled(bridge: AgentRuntimeBridge): boolean {
  return bridge.isEnabled
}

export function handleRuntimeModelCatalogSet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'runtime:modelCatalog:set' }>,
): { ok: boolean } {
  bridge.setModelCatalogFromApi(command.entries)
  return { ok: true }
}
