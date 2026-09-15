/**
 * /backend — 查看当前 ACP 后端与可用后端列表。
 *
 * 注册范围：**仅微信与飞书**（QQ / 企微的 adapter 未接 ACP 分流，故未注册本命令）。
 * 会话级选择以 dev-context 为准（10-S3b：`/claude` 等同时写会话级 dev-context），
 * 这里的 peer 级值是「该渠道用户的默认」兜底。
 */
import type { CommandHandler, CommandContext } from '../types'
import { CODING_DEV_BACKEND_LABELS } from '../../coding-dev-backends-stub/contracts.js'

export const backendCommand: CommandHandler = {
  description: '查看当前 ACP 后端及可用后端列表',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, acpBackendManager } = ctx
    const { channelUserId, sessionKey } = session

    const current = acpBackendManager.getBackend(channelUserId, sessionKey)
    const all = acpBackendManager.listBackends()
    const lines = all.map((id) => {
      const label = CODING_DEV_BACKEND_LABELS[id] ?? id
      return id === current ? `▶ ${label}（当前）` : `  ${label}`
    })

    await adapter.sendTextReply(
      session,
      `当前后端：${CODING_DEV_BACKEND_LABELS[current] ?? current}\n\n可用后端：\n${lines.join('\n')}\n\n使用 /claude、/codex、/lumii 等命令切换。`,
    )
  },
}
