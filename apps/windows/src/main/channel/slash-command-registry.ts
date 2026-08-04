/**
 * 斜杠命令注册表
 *
 * 统一管理所有通道（微信、IPC）的斜杠命令，支持别名注册。
 */

import type { CommandContext, CommandHandler } from './types'

const log = {
  info: (...args: unknown[]) => console.log('[SlashCommandRegistry]', ...args),
  warn: (...args: unknown[]) => console.warn('[SlashCommandRegistry]', ...args),
  error: (...args: unknown[]) => console.error('[SlashCommandRegistry]', ...args),
  debug: (...args: unknown[]) => console.debug('[SlashCommandRegistry]', ...args),
}

export class SlashCommandRegistry {
  /** 主命令名 → handler */
  private readonly handlers = new Map<string, CommandHandler>()
  /** 别名 → 主命令名 */
  private readonly aliases = new Map<string, string>()

  /**
   * 注册命令（含可选别名）。
   * @param cmd      主命令名，不含 `/`（如 `'clear'`）
   * @param handler  命令处理器
   * @param aliases  别名列表，不含 `/`（如 `['cls']`）
   */
  register(cmd: string, handler: CommandHandler, aliases: string[] = []): void {
    this.handlers.set(cmd, handler)
    for (const alias of aliases) {
      this.aliases.set(alias, cmd)
    }
    log.info(`[register] 注册命令: /${cmd}${aliases.length ? ` (别名: ${aliases.map((a) => `/${a}`).join(', ')})` : ''}`)
  }

  /** 判断文本是否为已注册的斜杠命令 */
  canHandle(text: string): boolean {
    if (!text.startsWith('/')) return false
    const name = this.parseName(text)
    return this.handlers.has(name) || this.aliases.has(name)
  }

  /**
   * 执行斜杠命令。
   * @returns true 表示命令已处理，false 表示未匹配（调用方可继续处理）
   */
  async execute(ctx: CommandContext, text: string): Promise<boolean> {
    if (!text.startsWith('/')) return false
    const name = this.parseName(text)
    const resolvedName = this.aliases.get(name) ?? name
    const handler = this.handlers.get(resolvedName)
    if (!handler) return false

    log.info(`[execute] 执行命令: /${resolvedName} args="${ctx.args}" channelUserId=${ctx.session.channelUserId}`)
    await handler.execute(ctx)
    return true
  }

  /** 列出所有已注册命令（用于 /help） */
  listCommands(): Array<{ cmd: string; description: string }> {
    return Array.from(this.handlers.entries()).map(([cmd, h]) => ({
      cmd: `/${cmd}`,
      description: h.description,
    }))
  }

  /** 从命令文本中解析命令名（不含 `/`，不含参数） */
  private parseName(text: string): string {
    return text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
  }

  /**
   * 从完整命令文本中提取参数部分（去掉 `/cmd` 后的剩余文本）。
   * 供外部在构建 CommandContext 时使用。
   */
  static parseArgs(text: string): string {
    const parts = text.trim().split(/\s+/)
    return parts.slice(1).join(' ')
  }
}
