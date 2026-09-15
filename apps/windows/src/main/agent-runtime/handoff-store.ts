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
  /**
   * 目标项目名（本机 `codingDevProjects` 中的 registered 项目）。
   *
   * 执行时写入**开发会话**的 dev-context，使 `resolveDevContext` 命中 `source: 'session'`
   * 并把 cwd 解析到项目目录——这是「转交后项目不丢」的唯一通道
   * （`codingDevProjects` 本身不参与解析，只认 dev-context 与 Agent 绑定）。
   */
  readonly projectName?: string
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

/** 仅供单测：清空全部提案 */
export function __clearHandoffsForTest(): void {
  pending.clear()
}
