/**
 * /project — 查看 / 切换本会话的开发项目（会话级）。
 *
 * 项目来自 app.json codingDevProjects（客户端「设置 → 开发类 AI 工具」注册）。
 * 切换写入**会话级** dev-context（10-S3b 起按会话 id 索引，用户换渠道续聊时项目跟着走）；
 * 下一条 ACP 消息即以该项目目录为 cwd。编码工具切换见 /claude、/codex、/opencode、/cursor、/lumii。
 *
 * 注册范围：**仅微信与飞书**——QQ 与企业微信的 adapter 没有接 ACP 分流
 * （见各 adapter 的 buildRegistry），因此未注册本命令；在那两个渠道发 /project 只会得到「未知命令」。
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
    const current = getDevContext(sessionKey)?.projectName

    if (!args) {
      await adapter.sendTextReply(session, `📁 开发项目：\n${renderProjectList(current)}`)
      return
    }

    if (args === 'off') {
      setDevContext(sessionKey, { projectName: null }, channelUserId)
      await adapter.sendTextReply(session, '✅ 已清除本会话项目，后续按全局活动项目执行。')
      return
    }

    const target = (getCodingDevConfig().codingDevProjects ?? []).find((p) => p.name === args)
    if (!target) {
      await adapter.sendTextReply(session, `❌ 项目「${args}」未注册。\n${renderProjectList(current)}`)
      return
    }

    setDevContext(sessionKey, { projectName: target.name }, channelUserId)
    await adapter.sendTextReply(
      session,
      `✅ 本会话开发项目：${target.name}\n目录：${target.realPath}\n（切换编码工具用 /claude、/codex 等）`,
    )
  },
}
