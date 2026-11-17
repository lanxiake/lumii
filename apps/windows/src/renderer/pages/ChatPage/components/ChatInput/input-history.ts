/**
 * 输入框历史输入（上下方向键取）。
 *
 * 纯模块 + localStorage：历史跨会话共用（用户想复用的是「我上回怎么问的」，
 * 不是某次会话的草稿），重启后仍在。上限 50 条，去重时旧的那条被顶到最新。
 */

const STORAGE_KEY = 'mtbot:input-history'
const MAX_ENTRIES = 50

/** 读历史（最新在前）。坏数据一律当空，历史不值得为它炸掉输入框。 */
export function readInputHistory(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

/** 记一条输入。空白不记；与最新一条相同则不重复记。 */
export function recordInputHistory(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const previous = readInputHistory()
  if (previous[0] === trimmed) return
  const next = [trimmed, ...previous.filter((item) => item !== trimmed)].slice(0, MAX_ENTRIES)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存不下（配额）不影响本次输入
  }
}
