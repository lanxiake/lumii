/**
 * 回合 → Git 快照索引（P2 T3）
 *
 * VCS 自动快照会在 `.mtbot-vcs/turn-index.jsonl` 追加「这条 assistant 消息
 * 落库后对应的 commit」。快照排队时会合并，因此多个 messageId 可能指向
 * 同一个 oid；`coalesced > 0` 说明该提交可能包含紧随其后的改动，UI 要标近似。
 *
 * 纯解析/解析函数放 shared，插件写、主进程读，避免两边各写一套。
 */

export interface TurnIndexEntry {
  messageId: string
  conversationId?: string
  runId?: string
  /** null = 该回合没有产生新快照（无文本变更） */
  oid: string | null
  /** epoch ms（快照完成时间） */
  at: number
  coalesced?: number
}

export interface ResolvedTurnOid {
  oid: string
  entry: TurnIndexEntry
  /** 提交可能包含后续回合的改动（合并提交）或缺少该消息的精确索引 */
  approximate: boolean
}

export function parseTurnIndex(text: string): TurnIndexEntry[] {
  const out: TurnIndexEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed) as Partial<TurnIndexEntry>
      if (typeof raw.messageId !== 'string' || !raw.messageId) continue
      if (raw.oid !== null && typeof raw.oid !== 'string') continue
      if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) continue
      out.push({
        messageId: raw.messageId,
        oid: raw.oid ?? null,
        at: raw.at,
        ...(typeof raw.conversationId === 'string'
          ? { conversationId: raw.conversationId }
          : {}),
        ...(typeof raw.runId === 'string' ? { runId: raw.runId } : {}),
        ...(typeof raw.coalesced === 'number' ? { coalesced: raw.coalesced } : {}),
      })
    } catch {
      // 坏行跳过：索引是增量文件，半截写入不能让它整体失效
    }
  }
  return out
}

/**
 * 找某条消息对应的文本快照：
 * - 该消息自己非空 → 用它（coalesced>0 标近似）；
 * - 该消息为空（无变更）→ 用之前最近一个非空快照（状态未变，精确）；
 * - 索引里没有该消息但有 timestamp → 用之前最近一个非空快照（近似）。
 */
export function resolveTurnOid(
  entries: readonly TurnIndexEntry[],
  messageId: string,
  timestamp?: number,
): ResolvedTurnOid | null {
  const sorted = [...entries].sort((a, b) => a.at - b.at)
  let target: TurnIndexEntry | undefined
  for (const entry of sorted) {
    if (entry.messageId === messageId) target = entry
  }

  if (target) {
    if (target.oid) {
      return {
        oid: target.oid,
        entry: target,
        approximate: (target.coalesced ?? 0) > 0,
      }
    }
    const previous = lastNonNullBefore(sorted, target.at)
    if (!previous) return null
    return { oid: previous.oid!, entry: previous, approximate: false }
  }

  if (timestamp === undefined) return null
  const previous = lastNonNullBefore(sorted, timestamp)
  if (!previous) return null
  return { oid: previous.oid!, entry: previous, approximate: true }
}

function lastNonNullBefore(
  sorted: readonly TurnIndexEntry[],
  at: number,
): TurnIndexEntry | null {
  let found: TurnIndexEntry | null = null
  for (const entry of sorted) {
    if (entry.at > at) break
    if (entry.oid) found = entry
  }
  return found
}
