/**
 * 记忆宫殿展示层的中文化。
 *
 * 宫殿存的是原始坐标：`wing`/`room` 是内容寻址的一部分（改了就换 id），`agent_id` 是
 * 定义 id。这些值对用户没有意义——「conversations / qbot:964A4769… / chronicler」
 * 一屏全是机器标识。这里只做**展示转换**，不动存储值。
 */

/** Agent 定义 id → 用户看得懂的名字 */
const AGENT_LABELS: Record<string, string> = {
  assistant: '主助手',
  'code-dev': '开发助手',
  chronicler: '灵栖记事',
  'info-curator': '情报官',
  'system-keeper': '系统管家',
}

export function agentLabel(agentId: string): string {
  return AGENT_LABELS[agentId] ?? agentId
}

/** 渠道类型 → 中文名 */
const CHANNEL_LABELS: Record<string, string> = {
  local: '桌面端',
  feishu: '飞书',
  weixin: '微信',
  wecom: '企业微信',
  qbot: 'QQ',
  cron: '定时任务',
}

/**
 * 从会话 id 前缀推断渠道。
 *
 * 会话 id 的形态是 `${channel}:${peerId}`（如 `qbot:964A4769…`），`channel_type` 为空
 * 时靠前缀仍能判出来。`local-xxx` / 纯 hex 是桌面端自建会话。
 */
export function channelFromConversationId(conversationId: string): string | null {
  const prefix = conversationId.split(':')[0]
  if (prefix && CHANNEL_LABELS[prefix]) return prefix
  if (conversationId.startsWith('cron')) return 'cron'
  return null
}

export function channelLabel(channelType: string | null | undefined): string | null {
  if (!channelType) return null
  return CHANNEL_LABELS[channelType] ?? channelType
}

/**
 * wing 的中文化。
 *
 * 线上有两种坐标（都是有意的，见 `palace-backfill-messages.mjs` 的说明）：
 * - `conversations`：每轮助手回复的即时归档
 * - `${agentId}:${userId}`：段管线归档（agent 作用域靠 wing 承载）
 * 旧 Python 宫殿还留下变形形态（`assistant_local-user` 用下划线）。
 */
export function wingLabel(wing: string): string {
  if (wing === 'conversations') return '逐轮对话'
  const [agentPart, userPart] = wing.split(':')
  if (agentPart && userPart) return `${agentLabel(agentPart)}（${userPart}）`
  const underscoreIdx = wing.indexOf('_')
  if (underscoreIdx > 0 && wing.endsWith('_local-user')) {
    return `${agentLabel(wing.slice(0, underscoreIdx))}（历史）`
  }
  return wing
}

/**
 * 归档条目的主标题 —— 用户最先该看到的那句话。
 *
 * 优先级：会话标题 → 渠道名 → wing 中文名。会话标题是最有用的（"帮我解读这条内容…"
 * 一看就知道在聊什么），而原始 room 只是一串机器 id。
 */
export function drawerTitle(item: {
  conversationTitle?: string
  conversation_id?: string | null
  room: string
  wing: string
}): string {
  const title = item.conversationTitle?.trim()
  if (title) return title
  // 没有标题时退回渠道名（room 就是 conversationId 的场景）
  const convId = item.conversation_id ?? item.room
  const channel = channelFromConversationId(convId)
  if (channel) return `${channelLabel(channel) ?? channel} 对话`
  return wingLabel(item.wing)
}

/**
 * 归档条目的副标题 —— 来源与归属，供需要时展开看。
 *
 * `agent_id` 可选：检索结果（`PalaceSearchItem`）不返回它，只有列表项有。
 */
export function drawerSubtitle(item: {
  conversationTitle?: string
  conversation_id?: string | null
  room: string
  wing: string
  agent_id?: string
  channelType?: string | null
  char_count: number
}): string {
  const parts: string[] = []
  const channel =
    channelLabel(item.channelType) ??
    channelLabel(channelFromConversationId(item.conversation_id ?? item.room))
  if (channel) parts.push(channel)
  if (item.agent_id) parts.push(agentLabel(item.agent_id))
  parts.push(`${item.char_count} 字`)
  return parts.join(' · ')
}
