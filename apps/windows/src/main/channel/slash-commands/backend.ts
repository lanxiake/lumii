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
      `当前后端：${CODING_DEV_BACKEND_LABELS[current] ?? current}\n\n可用后端：\n${lines.join('\n')}\n\n使用 /claude、/codex、/mtbot 等命令切换。`,
    )
  },
}
