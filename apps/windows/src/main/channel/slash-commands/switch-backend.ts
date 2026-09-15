/**
 * /claude、/codex、/opencode、/cursor、/lumii —— 切换本会话的编码后端。
 *
 * 一次切换写三处（各自解决一个不同的问题）：
 *   1. **会话级 dev-context**（10-S3b 起）——「本会话用哪个工具」，按会话 id 索引，
 *      用户换渠道续聊时跟着走；`resolveDevContext` 优先取它；
 *   2. **peer 级 backend-selection** ——「该渠道用户的默认」，供 adapter 的兜底解析；
 *   3. **user-global + 推事件** —— 让客户端输入框标签与实际路由一致（见下）。
 *
 * 注册范围：**仅微信与飞书**（QQ / 企微未接 ACP 分流）。
 */
import type { CommandHandler, CommandContext } from '../types'
import type { CodingDevBackendId } from '../../coding-dev-backends-stub/contracts.js'
import {
  CODING_DEV_BACKEND_LABELS,
  isImplementedCodingDevBackendId,
  DEFAULT_CODING_DEV_BACKEND_ID,
} from '../../coding-dev-backends-stub/contracts.js'
import { pushAgentRuntimeEvent, LOCAL_USER_ID } from '../../ipc/agent-runtime-ipc.js'
import { setDevContext } from '../../coding-dev-dev-context.js'

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

      // 会话级选择写进 dev-context（按**会话**索引，10-S3b）：这样用户转到别的渠道
      // 继续聊时工具选择跟着走。peer 级那份保留，作为「该渠道用户的默认」兜底。
      setDevContext(sessionKey, { backendId }, channelUserId)
      await acpBackendManager.setBackend(backendId, 'peer', channelUserId, sessionKey)
      await syncBackendToClient(acpBackendManager, backendId)
      const label = CODING_DEV_BACKEND_LABELS[backendId]
      await adapter.sendTextReply(session, `✅ 已切换后端：${label}\n后续消息将通过 ${label} 处理。`)
    },
  }
}

/**
 * /lumii — 切回灵栖主代理。
 * 微信单聊：写入主代理 ID 覆盖用户级全局轻量后端。
 */
export const lumiiCommand: CommandHandler = {
  description: '切回灵栖主代理',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, acpBackendManager } = ctx
    const { channelUserId, sessionKey } = session

    // 先尝试清除 peer 级选择，再写入主代理 ID 确保覆盖用户级全局
    await acpBackendManager.clearBackend('peer', channelUserId, sessionKey)
    await acpBackendManager.setBackend(DEFAULT_CODING_DEV_BACKEND_ID, 'peer', channelUserId, sessionKey)
    // 会话级同样显式写回主代理（dev-context 的会话覆盖优先级最高，不写会继续走 CLI）
    setDevContext(sessionKey, { backendId: DEFAULT_CODING_DEV_BACKEND_ID }, channelUserId)
    await syncBackendToClient(acpBackendManager, DEFAULT_CODING_DEV_BACKEND_ID)

    await adapter.sendTextReply(
      session,
      `✅ 已切回灵栖主代理（${CODING_DEV_BACKEND_LABELS[DEFAULT_CODING_DEV_BACKEND_ID]}）\n后续消息将由灵栖内置 Agent 处理。`,
    )
  },
}
