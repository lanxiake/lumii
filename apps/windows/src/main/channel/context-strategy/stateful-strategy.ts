/**
 * StatefulContextStrategy — 有状态上下文策略（IPC/Windows 通道）
 *
 * - beforePrompt：增量同步 DB 新消息到 Agent 内存（仅当 DB 有新消息时才同步）
 * - afterPrompt：无操作（内存保持，下次增量同步）
 *
 * 增量同步逻辑：
 * 记录每个 sessionKey 上次同步时的 DB 消息数，beforePrompt 时查询当前 DB 消息数，
 * 若有新增则调用 restoreHistoryForInstance 重新注入（全量替换，保持简单）。
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import type { ContextStrategy } from '../types'

const log = {
  info: (...args: unknown[]) => console.log('[StatefulContextStrategy]', ...args),
  debug: (...args: unknown[]) => console.debug('[StatefulContextStrategy]', ...args),
}

export class StatefulContextStrategy implements ContextStrategy {
  /** sessionKey → 上次同步时的 DB 消息数 */
  private readonly lastSyncedCount = new Map<string, number>()

  constructor(private readonly bridge: AgentRuntimeBridge) {}

  async beforePrompt(instanceId: string, sessionKey: string, pendingUserMsgId?: string): Promise<void> {
    const currentCount = this.bridge.getDbMessageCount(sessionKey)
    const lastCount = this.lastSyncedCount.get(sessionKey) ?? -1
    const memoryEmpty = this.bridge.hasEmptyInstanceMemory(instanceId)

    if (currentCount === lastCount && !memoryEmpty) {
      log.debug(`[beforePrompt] DB 无新消息，跳过同步: sessionKey=${sessionKey} count=${currentCount}`)
      return
    }

    if (!memoryEmpty && this.bridge.isInstanceMemoryRicherThanDb(instanceId, sessionKey, pendingUserMsgId)) {
      log.info(
        `[beforePrompt] 实例内存比 DB 更完整，跳过同步以免丢失上下文: sessionKey=${sessionKey}`,
      )
      this.lastSyncedCount.set(sessionKey, currentCount)
      return
    }

    log.info(`[beforePrompt] 增量同步: sessionKey=${sessionKey} lastCount=${lastCount} currentCount=${currentCount}`)
    this.bridge.restoreHistoryForInstance(instanceId, sessionKey, undefined, pendingUserMsgId)
    this.lastSyncedCount.set(sessionKey, currentCount)
  }

  async afterPrompt(instanceId: string, sessionKey: string): Promise<void> {
    // 有状态策略：保留内存，不清空
    // afterPrompt 后更新同步计数（Agent 可能写入了新消息）
    const currentCount = this.bridge.getDbMessageCount(sessionKey)
    this.lastSyncedCount.set(sessionKey, currentCount)
    log.debug(`[afterPrompt] 更新同步计数: sessionKey=${sessionKey} count=${currentCount}`)
  }

  /** 清除指定 sessionKey 的同步状态（切换会话时调用） */
  clearSyncState(sessionKey: string): void {
    this.lastSyncedCount.delete(sessionKey)
    log.debug(`[clearSyncState] 已清除: sessionKey=${sessionKey}`)
  }
}
