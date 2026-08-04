import type { CommandHandler, CommandContext } from '../types'

export const resumeCommand: CommandHandler = {
  description: '列出最近会话 (/resume) 或恢复指定会话 (/resume <序号>)',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge } = ctx
    const { args } = ctx

    const recent = bridge.listRecentConversations(10)

    // /resume（无参数）：列出最近会话
    if (!args) {
      if (recent.length === 0) {
        await adapter.sendTextReply(session, '暂无历史会话可恢复。')
        return
      }
      const lines = recent.map((c, i) => {
        const date = new Date(c.updatedAt).toLocaleString('zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
        const shortId = c.id.slice(-6)
        return `${i + 1}. [${date}] ${c.title} (${shortId})`
      })
      await adapter.sendTextReply(
        session,
        `最近 ${recent.length} 个会话：\n${lines.join('\n')}\n\n回复 /resume <序号> 恢复指定会话，例如：/resume 2`,
      )
      return
    }

    // /resume <序号>：恢复指定会话
    const idx = parseInt(args, 10) - 1
    if (isNaN(idx) || idx < 0) {
      await adapter.sendTextReply(session, '请输入有效序号，例如：/resume 2')
      return
    }
    const target = recent[idx]
    if (!target) {
      await adapter.sendTextReply(session, `序号 ${idx + 1} 不存在，请用 /resume 查看列表。`)
      return
    }

    // 销毁旧实例
    if (session.instanceId) {
      try { bridge.destroy(session.instanceId) } catch { /* ignore */ }
    }

    const resumedSession = { ...session, sessionKey: target.id, instanceId: null }
    // 持久化切换，使后续消息路由到恢复的会话
    adapter.setActiveSessionKey?.(session.channelUserId, target.id)
    bridge.notifyNavigateToSession(target.id, target.title)
    await adapter.sendTextReply(resumedSession, `✅ 已切换到会话：${target.title}\n发消息继续对话。`)
  },
}
