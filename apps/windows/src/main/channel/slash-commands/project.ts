/**
 * /project — 查看 / 切换本会话的开发项目（对话级）。
 *
 * 项目来自 app.json codingDevProjects（客户端「设置 → 开发类 AI 工具」注册）。
 * 切换写入 peer 级 dev-context；下一条 ACP 消息即以该项目目录为 cwd。
 * 编码工具切换见 /claude、/codex、/opencode、/cursor、/lumii。
 */
import type { CommandHandler, CommandContext } from '../types'
import { getCodingDevConfig } from '../../coding-dev-env.js'
import { getDevContext, setDevContext } from '../../coding-dev-dev-context.js'

function renderProjectList(currentProject?: string): string {
  const projects = getCodingDevConfig().codingDevProjects ?? []
  if (projects.length === 0) {
    return '还没有注册项目——请在客户端「设置 → 开发类 AI 工具」里打开已有项目。'
  }
  const lines = projects.map(
    (p) => `${p.name === currentProject ? '→' : '  '} ${p.name}${p.isExternal ? '（外部）' : ''}`,
  )
  lines.push('')
  lines.push('用法：/project <项目名> 切换本会话项目；/project off 清除。')
  return lines.join('\n')
}

export const projectCommand: CommandHandler = {
  description: '查看 / 切换本会话的开发项目',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter } = ctx
    const { channelUserId, sessionKey } = session
    const args = ctx.args.trim()
    const current = getDevContext(channelUserId, sessionKey)?.projectName

    if (!args) {
      await adapter.sendTextReply(session, `📁 开发项目：\n${renderProjectList(current)}`)
      return
    }

    if (args === 'off') {
      setDevContext(channelUserId, sessionKey, { projectName: null })
      await adapter.sendTextReply(session, '✅ 已清除本会话项目，后续按全局活动项目执行。')
      return
    }

    const target = (getCodingDevConfig().codingDevProjects ?? []).find((p) => p.name === args)
    if (!target) {
      await adapter.sendTextReply(session, `❌ 项目「${args}」未注册。\n${renderProjectList(current)}`)
      return
    }

    setDevContext(channelUserId, sessionKey, { projectName: target.name })
    await adapter.sendTextReply(
      session,
      `✅ 本会话开发项目：${target.name}\n目录：${target.realPath}\n（切换编码工具用 /claude、/codex 等）`,
    )
  },
}
