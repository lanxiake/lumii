/**
 * StatelessContextStrategy — 无状态上下文策略（微信通道）
 *
 * - beforePrompt：从 DB 恢复历史到 Agent 内存
 * - afterPrompt：清空 Agent 内存（避免 compaction summary 污染下一轮）
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { ContextStrategy } from '../types'

const log = {
  info: (...args: unknown[]) => console.log('[StatelessContextStrategy]', ...args),
  debug: (...args: unknown[]) => console.debug('[StatelessContextStrategy]', ...args),
}

export class StatelessContextStrategy implements ContextStrategy {
  constructor(private readonly bridge: AgentRuntimeBridge) {}

  async beforePrompt(instanceId: string, sessionKey: string, pendingUserMsgId?: string): Promise<void> {
    log.info(`[beforePrompt] 从 DB 恢复历史: instanceId=${instanceId} sessionKey=${sessionKey}`)
    this.bridge.restoreHistoryForInstance(instanceId, sessionKey, undefined, pendingUserMsgId)
  }

  async afterPrompt(instanceId: string, sessionKey: string): Promise<void> {
    log.info(`[afterPrompt] 清空实例内存历史: instanceId=${instanceId} sessionKey=${sessionKey}`)
    this.bridge.clearInstanceMemory(instanceId)
  }
}
