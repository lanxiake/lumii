/**
 * 开发任务转交提案存储（F2：桌面一键转交）
 *
 * 流程：主助手经 propose_dev_handoff 工具提出转交提案 → 用户点击消息卡片确认 →
 * handoff:confirm 命令取出提案并执行（新开/复用灵栖开发会话并发起 run）。
 *
 * 内存级存储：应用重启后提案失效（重启后点击会提示重新发起）——
 * 确认动作应即时，不做持久化（避免「陈旧提案被误确认」）。
 */

import { randomUUID } from 'node:crypto'

export interface PendingHandoff {
  readonly id: string
  readonly createdAt: number
  /** 提案来源会话（主助手会话），供渲染与诊断 */
  readonly originSessionKey: string
  /** 发给开发 CLI 的完整任务描述（背景包） */
  readonly task: string
  /** 给用户确认时看的一句话摘要 */
  readonly summary: string
  /** 会话选择：new=新开；recent=复用灵栖开发最近的会话（由主助手按上下文判断） */
  readonly sessionMode: 'new' | 'recent'
}

const pending = new Map<string, PendingHandoff>()

/** 简单上限，防止长驻进程内存无界增长（超出时淘汰最旧提案） */
const MAX_PENDING = 50

export function proposeHandoff(input: Omit<PendingHandoff, 'id' | 'createdAt'>): PendingHandoff {
  const handoff: PendingHandoff = { ...input, id: randomUUID(), createdAt: Date.now() }
  pending.set(handoff.id, handoff)
  if (pending.size > MAX_PENDING) {
    const oldest = [...pending.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
    if (oldest) pending.delete(oldest.id)
  }
  return handoff
}

/** 取出并移除（确认动作一次性；不存在返回 undefined） */
export function consumeHandoff(id: string): PendingHandoff | undefined {
  const handoff = pending.get(id)
  if (handoff) pending.delete(id)
  return handoff
}

/**
 * 渠道确认词（F3）：保守集合，避免误伤正常聊天。
 * 主助手的提案文案固定引导「回复 1 确认」，桌面点卡片走 handoff:confirm。
 */
const HANDOFF_CONFIRM_WORDS = new Set(['1', '确认', 'ok', 'y', 'yes'])

export function isHandoffConfirmText(text: string): boolean {
  return HANDOFF_CONFIRM_WORDS.has(text.trim().toLowerCase())
}

/**
 * 渠道会话判定（F3）：qbot/feishu/weixin/wecom 前缀 = 渠道（无卡片按钮，确认走「回复 1」）；
 * 桌面会话为 uuid（无匹配）。
 */
const CHANNEL_SESSION_PREFIX = /^(qbot|feishu|weixin|wecom):/i

export function isChannelSession(sessionKey: string): boolean {
  return CHANNEL_SESSION_PREFIX.test(sessionKey)
}

/**
 * 找某会话最新一条未消费的转交提案（createdAt 距现在 withinMs 内）。
 * 供渠道确认使用：用户回复确认词时按会话定位提案。
 */
export function findLatestHandoffFor(
  sessionKey: string,
  withinMs: number,
): PendingHandoff | undefined {
  const now = Date.now()
  let latest: PendingHandoff | undefined
  for (const handoff of pending.values()) {
    if (handoff.originSessionKey !== sessionKey) continue
    if (now - handoff.createdAt > withinMs) continue
    if (!latest || handoff.createdAt >= latest.createdAt) latest = handoff
  }
  return latest
}

/** 仅供单测：清空全部提案 */
export function __clearHandoffsForTest(): void {
  pending.clear()
}
