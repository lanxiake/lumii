import type { CommandHandler, CommandContext } from '../types'
import { resolveChannelIdentity } from '../channel-identity'

/** 每条列表项：会话 + 来源渠道标签 */
interface ResumeEntry {
  id: string
  title: string
  updatedAt: string
  channelLabel: string
  isCurrent: boolean
}

/** 分组展示顺序（与客户端侧栏一致）；未列出的渠道排在末尾 */
const GROUP_ORDER = ['客户端', '微信', '飞书', '企业微信', 'QQ']

/** 每组最多列几条：渠道是纯文本，全量 dump 会超长被截断，序号也就跟着失效 */
const MAX_PER_GROUP = 10

/** 拉取窗口：底层是「置顶优先」排序，取太少会让渠道自己的会话被挤出列表 */
const LOOKUP_LIMIT = 100

/**
 * 组装会话列表：按来源渠道分组、组内按时间倒序、序号跨组连续。
 *
 * 排除 cron / evolution 这类非用户会话；微信 `/link` 绑定过的客户端会话
 * 补标「微信」（光看 id 前缀认不出来）。
 */
export function buildResumeEntries(params: {
  recent: readonly { id: string; title: string; updatedAt: string; channelType?: string | null }[]
  currentSessionKey: string
  weixinBoundIds: ReadonlySet<string>
}): ResumeEntry[] {
  const { recent, currentSessionKey, weixinBoundIds } = params

  const entries: ResumeEntry[] = []
  const seen = new Set<string>()
  for (const conv of recent) {
    if (seen.has(conv.id)) continue
    const { label } = resolveChannelIdentity(conv.id, conv.channelType)
    const boundLabel = weixinBoundIds.has(conv.id) ? '微信' : ''
    const channelLabel = boundLabel || label
    // 空标签 = 定时任务/自主进化会话，不是给用户恢复的
    if (!channelLabel) continue
    seen.add(conv.id)
    entries.push({
      id: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      channelLabel,
      isCurrent: conv.id === currentSessionKey,
    })
  }

  const rank = (label: string): number => {
    const idx = GROUP_ORDER.indexOf(label)
    return idx >= 0 ? idx : GROUP_ORDER.length
  }
  entries.sort((a, b) => {
    const byChannel = rank(a.channelLabel) - rank(b.channelLabel)
    if (byChannel !== 0) return byChannel
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
  return entries
}

/** 分组渲染，每组截断到 MAX_PER_GROUP；返回文本与「可被 /resume <序号> 引用的条目」 */
export function formatResumeList(entries: readonly ResumeEntry[]): {
  text: string
  selectable: ResumeEntry[]
} {
  const perGroup = new Map<string, number>()
  const selectable: ResumeEntry[] = []
  const lines: string[] = []
  let lastLabel = ''

  for (const entry of entries) {
    const used = perGroup.get(entry.channelLabel) ?? 0
    if (used >= MAX_PER_GROUP) continue
    perGroup.set(entry.channelLabel, used + 1)
    if (entry.channelLabel !== lastLabel) {
      if (lines.length > 0) lines.push('')
      lines.push(`【${entry.channelLabel}】`)
      lastLabel = entry.channelLabel
    }
    selectable.push(entry)
    const date = new Date(entry.updatedAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    const suffix = entry.isCurrent ? ' ← 当前' : ''
    lines.push(`${selectable.length}. [${date}] ${entry.title}${suffix}`)
  }

  const hidden = entries.length - selectable.length
  const tail = hidden > 0 ? `\n（另有 ${hidden} 个较旧的会话未列出）` : ''
  return {
    text: `${lines.join('\n')}${tail}\n\n回复 /resume <序号> 切换会话。`,
    selectable,
  }
}

export const resumeCommand: CommandHandler = {
  description: '列出各渠道的最近会话 (/resume) 或切换指定会话 (/resume <序号>)',
  async execute(ctx: CommandContext): Promise<void> {
    const { session, adapter, bridge, bindingManager, sessionManager } = ctx
    const { args } = ctx

    // 微信有 /link 绑定层：被绑定的客户端会话要标成「微信」，否则用户认不出自己那条
    const weixinBoundIds = new Set(
      (bindingManager?.listBindings() ?? []).map((b) => b.conversationId),
    )

    // 列表与序号都按「本次现查」的结果算：会话随时在变，缓存一份只会让 /resume <序号> 指得更偏
    const entries = buildResumeEntries({
      recent: bridge.listRecentConversations(LOOKUP_LIMIT),
      currentSessionKey: session.sessionKey,
      weixinBoundIds,
    })

    // /resume（无参数）：列出最近会话
    if (!args) {
      if (entries.length === 0) {
        await adapter.sendTextReply(session, '暂无历史会话可恢复。')
        return
      }
      const { text } = formatResumeList(entries)
      await adapter.sendTextReply(session, `最近会话：\n${text}`)
      return
    }

    // /resume <序号>：切换指定会话
    const idx = parseInt(args, 10) - 1
    if (isNaN(idx) || idx < 0) {
      await adapter.sendTextReply(session, '请输入有效序号，例如：/resume 2')
      return
    }
    const { selectable } = formatResumeList(entries)
    const target = selectable[idx]
    if (!target) {
      await adapter.sendTextReply(session, `序号 ${idx + 1} 不存在，请用 /resume 查看列表。`)
      return
    }

    // 销毁旧实例
    if (session.instanceId) {
      try { bridge.destroy(session.instanceId) } catch { /* ignore */ }
    }
    // 清旧会话的 prompt 锁，避免上一轮把新会话的 prompt 堵在后面
    sessionManager?.clearLock(session.sessionKey)

    const resumedSession = { ...session, sessionKey: target.id, instanceId: null }
    // 持久化切换，使后续消息路由到恢复的会话（重启后仍生效）
    adapter.setActiveSessionKey?.(session.channelUserId, target.id)
    bridge.notifyNavigateToSession(target.id, target.title)
    await adapter.sendTextReply(
      resumedSession,
      `✅ 已切换到会话：${target.title}（${target.channelLabel}）\n发消息继续对话。`,
    )
  },
}
