import type { CommandHandler, CommandContext } from '../types'
import type { CodingDevBackendId } from '../../coding-dev-backends-stub/contracts.js'
import {
  CODING_DEV_BACKEND_LABELS,
  isImplementedCodingDevBackendId,
  DEFAULT_CODING_DEV_BACKEND_ID,
} from '../../coding-dev-backends-stub/contracts.js'
import { pushAgentRuntimeEvent, LOCAL_USER_ID } from '../../ipc/agent-runtime-ipc.js'

/**
 * 把渠道侧的后端切换同步到客户端。
 *
 * 客户端对话按 user-global（accountId=local-user）解析后端，渠道写的是
 * peer 级（accountId=channelUserId），两边 key 不同 —— 只推事件的话输入框
 * 标签变了但实际路由没变。所以这里既写 user-global 又推事件。
 */
async function syncBackendToClient(
  acpBackendManager: CommandContext['acpBackendManager'],
  backendId: CodingDevBackendId,
): Promise<void> {
  await acpBackendManager.setBackend(backendId, 'user-global', LOCAL_USER_ID)
  pushAgentRuntimeEvent({ type: 'settings:backend-changed', backendId })
}

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
      await syncBackendToClient(acpBackendManager, backendId)
      const label = CODING_DEV_BACKEND_LABELS[backendId]
      await adapter.sendTextReply(session, `✅ 已切换后端：${label}\n后续消息将通过 ${label} 处理。`)
    },
  }
}

/**
 * /lumii — 切回灵栖主代理（openclaw）。
 * 微信单聊：写入 openclaw 覆盖用户级全局轻量后端。
 */
export const lumiiCommand: CommandHandler = {
  description: '切回灵栖主代理',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, acpBackendManager } = ctx
    const { channelUserId, sessionKey } = session

    // 先尝试清除 peer 级选择，再写入 openclaw 确保覆盖用户级全局
    await acpBackendManager.clearBackend('peer', channelUserId, sessionKey)
    await acpBackendManager.setBackend(DEFAULT_CODING_DEV_BACKEND_ID, 'peer', channelUserId, sessionKey)
    await syncBackendToClient(acpBackendManager, DEFAULT_CODING_DEV_BACKEND_ID)

    await adapter.sendTextReply(
      session,
      `✅ 已切回灵栖主代理（${CODING_DEV_BACKEND_LABELS[DEFAULT_CODING_DEV_BACKEND_ID]}）\n后续消息将由灵栖内置 Agent 处理。`,
    )
  },
}
