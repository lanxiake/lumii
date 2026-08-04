import type { CommandHandler, CommandContext } from '../types'
import type { CodingDevBackendId } from '../../coding-dev-backends-stub/contracts.js'
import {
  CODING_DEV_BACKEND_LABELS,
  isImplementedCodingDevBackendId,
  DEFAULT_CODING_DEV_BACKEND_ID,
} from '../../coding-dev-backends-stub/contracts.js'

/**
 * 创建后端切换命令处理器。
 * @param backendId 目标后端 ID（如 'claude'、'codex'）
 */
export function createSwitchBackendCommand(backendId: CodingDevBackendId): CommandHandler {
  return {
    description: `切换到 ${CODING_DEV_BACKEND_LABELS[backendId]}`,
    async execute(ctx: CommandContext): Promise<void> {
      const { session, adapter, acpBackendManager } = ctx
      const { channelUserId, sessionKey } = session

      if (!isImplementedCodingDevBackendId(backendId)) {
        await adapter.sendTextReply(session, `❌ ${CODING_DEV_BACKEND_LABELS[backendId]} 尚未接入。`)
        return
      }

      await acpBackendManager.setBackend(backendId, 'peer', channelUserId, sessionKey)
      const label = CODING_DEV_BACKEND_LABELS[backendId]
      await adapter.sendTextReply(session, `✅ 已切换后端：${label}\n后续消息将通过 ${label} 处理。`)
    },
  }
}

/**
 * /mtbot — 切回 MtBot 主代理（openclaw）。
 * 微信单聊：写入 openclaw 覆盖用户级全局轻量后端。
 */
export const mtbotCommand: CommandHandler = {
  description: '切回 MtBot 主代理',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, acpBackendManager } = ctx
    const { channelUserId, sessionKey } = session

    // 先尝试清除 peer 级选择，再写入 openclaw 确保覆盖用户级全局
    await acpBackendManager.clearBackend('peer', channelUserId, sessionKey)
    await acpBackendManager.setBackend(DEFAULT_CODING_DEV_BACKEND_ID, 'peer', channelUserId, sessionKey)

    await adapter.sendTextReply(
      session,
      `✅ 已切回 MtBot 主代理（${CODING_DEV_BACKEND_LABELS[DEFAULT_CODING_DEV_BACKEND_ID]}）\n后续消息将由 MtBot 内置 Agent 处理。`,
    )
  },
}
