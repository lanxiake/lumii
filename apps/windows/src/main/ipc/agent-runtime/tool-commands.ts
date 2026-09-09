/**
 * Tool 命令处理器（tool-evolution:*）
 *
 * bash 命令工具进化的设置页管理：列表、审批、启用/禁用、删除
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'

const log = {
  info: (...args: unknown[]) => console.log('[agent-runtime-ipc/tool-evolution]', ...args),
  error: (...args: unknown[]) => console.error('[agent-runtime-ipc/tool-evolution]', ...args),
}

function getEngine(bridge: AgentRuntimeBridge) {
  const engine = bridge.getToolEvolutionEngine()
  if (!engine) throw new Error('ToolEvolutionEngine 未初始化')
  return engine
}

export function handleToolEvolutionList(
  bridge: AgentRuntimeBridge,
  _command: Extract<AgentRuntimeCommand, { type: 'tool-evolution:list' }>,
): {
  ok: boolean
  tools: Array<{
    name: string
    description: string
    commandTemplate: string
    isReadOnly: boolean
    enabled: boolean
    sampleCount: number
    approvedAt: string
  }>
  pending: Array<{
    name: string
    description: string
    pattern: string
    commandTemplate: string
    createdAt: string
  }>
  error?: string
} {
  try {
    return { ok: true, ...getEngine(bridge).listEvolvedTools() }
  } catch (err) {
    log.error('[tool-evolution:list] 失败:', err)
    return {
      ok: false,
      tools: [],
      pending: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function handleToolEvolutionConfirm(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tool-evolution:confirm' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const engine = getEngine(bridge)
    const done = await engine.consumePending(command.toolName, true)
    if (!done) throw new Error(`候选不存在: ${command.toolName}`)
    log.info(`[tool-evolution:confirm] 已确认: ${command.toolName}`)
    return { ok: true }
  } catch (err) {
    log.error('[tool-evolution:confirm] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleToolEvolutionReject(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tool-evolution:reject' }>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const engine = getEngine(bridge)
    const done = await engine.consumePending(command.toolName, false)
    if (!done) throw new Error(`候选不存在: ${command.toolName}`)
    log.info(`[tool-evolution:reject] 已拒绝: ${command.toolName}`)
    return { ok: true }
  } catch (err) {
    log.error('[tool-evolution:reject] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function handleToolEvolutionSetEnabled(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tool-evolution:set-enabled' }>,
): { ok: boolean; error?: string } {
  try {
    const done = getEngine(bridge).setToolEnabled(command.toolName, command.enabled)
    if (!done) throw new Error(`工具不存在: ${command.toolName}`)
    log.info(`[tool-evolution:set-enabled] ${command.toolName} -> ${command.enabled}`)
    return { ok: true }
  } catch (err) {
    log.error('[tool-evolution:set-enabled] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function handleToolEvolutionRemove(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tool-evolution:remove' }>,
): { ok: boolean; error?: string } {
  try {
    const done = getEngine(bridge).removeTool(command.toolName)
    if (!done) throw new Error(`工具不存在: ${command.toolName}`)
    log.info(`[tool-evolution:remove] 已删除: ${command.toolName}`)
    return { ok: true }
  } catch (err) {
    log.error('[tool-evolution:remove] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** CLI 模拟数据的 agentId 标记（deleteByAgent 可整批清理） */
export const SIMULATED_AGENT_ID = 'cli-simulator'

export function handleToolEvolutionSimulate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'tool-evolution:simulate' }>,
): { ok: boolean; written?: number; removed?: number; error?: string } {
  try {
    const repo = bridge.bashCommandRepo
    if (!repo) throw new Error('bash 命令仓库未就绪')

    let removed = 0
    if (command.cleanup) {
      removed = repo.deleteByAgent(SIMULATED_AGENT_ID)
    }
    if (!Array.isArray(command.commands) || command.commands.length === 0) {
      // 仅清理模式（commands 为空 + cleanup）：不写数据
      if (command.cleanup) {
        log.info(`[tool-evolution:simulate] 清理模拟数据 ${removed} 条`)
        return { ok: true, written: 0, removed }
      }
      throw new Error('commands 不能为空')
    }
    for (const cmd of command.commands) {
      if (typeof cmd !== 'string' || cmd.trim().length === 0) continue
      repo.log({
        agentId: SIMULATED_AGENT_ID,
        toolCallId: `cli-sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        command: cmd.trim(),
        isError: false,
        durationMs: 200 + Math.floor(Math.random() * 1800),
      })
    }
    log.info(`[tool-evolution:simulate] 写入 ${command.commands.length} 条模拟命令${removed > 0 ? `，清理旧数据 ${removed} 条` : ''}`)
    return { ok: true, written: command.commands.length, removed }
  } catch (err) {
    log.error('[tool-evolution:simulate] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleToolEvolutionMine(
  bridge: AgentRuntimeBridge,
): Promise<{ ok: boolean; summary?: unknown; error?: string }> {
  try {
    const summary = await getEngine(bridge).runMiningCycle()
    log.info(`[tool-evolution:mine] 挖掘完成:`, summary)
    return { ok: true, summary }
  } catch (err) {
    log.error('[tool-evolution:mine] 失败:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
