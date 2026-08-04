import type { CommandHandler, CommandContext, IChannelAdapter } from '../types'
import type { SlashCommandRegistry } from '../slash-command-registry'

/**
 * 创建 /help 命令处理器（需要注入 registry 以获取命令列表）
 */
export function createHelpCommand(registry: SlashCommandRegistry): CommandHandler {
  return {
    description: '显示所有可用命令',
    async execute(ctx: CommandContext): Promise<void> {
      const { session, adapter } = ctx
      const cmds = registry.listCommands()
      const lines = cmds.map((c) => `${c.cmd} — ${c.description}`)
      await adapter.sendTextReply(session, `可用命令：\n${lines.join('\n')}`)
    },
  }
}
