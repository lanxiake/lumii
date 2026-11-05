/**
 * 对话内搜索状态（Ctrl+F）。
 *
 * 与侧栏搜索分工：侧栏搜**所有会话**（跨会话找「哪句话在哪儿」）；
 * 这里只搜当前对话，纯内存、逐字响应，命中后按 Enter 在消息之间跳。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { findChatSearchHits, stepHitIndex } from '../utils/chat-search'

/** 参与搜索的消息：只需要 id 与可搜文本 */
export interface ChatSearchMessage {
  readonly id: string
  readonly text: string
}

export interface ChatSearchState {
  open: boolean
  query: string
  /** 每条消息的命中（按会话顺序）；用于计数与上下跳 */
  hits: readonly { messageId: string; count: number }[]
  /** 当前命中的下标（0-based）；-1 = 没有结果 */
  activeIndex: number
  /** 当前要滚动到并高亮的消息 id */
  focusMessageId: string | null
  /**
   * 要在气泡里标出关键词的那条消息（life-cycle 比 focusMessageId 长：
   * 定位是一次性的，高亮要挂到用户换词/关搜索为止）
   */
  keywordHighlight: { messageId: string; keyword: string } | null
  setQuery: (value: string) => void
  step: (direction: 1 | -1) => void
  close: () => void
}

/**
 * @param messages 当前会话的消息（含可搜文本）
 * @param externalFocus 外部（侧栏命中）塞进来的「定位到这条 + 标这个词」
 */
export function useChatSearch(
  messages: readonly ChatSearchMessage[],
  externalFocus: { messageId: string; keyword: string } | null,
): ChatSearchState {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const hits = useMemo(() => findChatSearchHits(messages, query), [messages, query])

  // 查询变化：重新从第一条开始。不这么做的话，改一个字母后 index 可能指到越界处
  useEffect(() => {
    setActiveIndex(hits.length > 0 ? 0 : -1)
  }, [query, hits.length])

  const step = useCallback(
    (direction: 1 | -1) => {
      setActiveIndex((previous) => stepHitIndex(previous, hits.length, direction))
    },
    [hits.length],
  )

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  // Ctrl/Cmd+F 打开（对话页内生效）；输入框里按 Esc 由搜索条自己处理
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setOpen(true)
        return
      }
      if (event.key === 'Escape' && open) {
        // 捕获阶段先吃掉：否则工作台的 Esc 会顺手把整个面板关掉
        event.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close])

  const internalFocusId =
    open && activeIndex >= 0 && activeIndex < hits.length
      ? hits[activeIndex]!.messageId
      : null

  /**
   * 高亮目标：外部定位优先，其次对话内搜索的当前命中。
   *
   * 关键点是它**不跟着 focusMessageId 一起清空**——ChatContainer 定位成功后会调
   * onFocusHandled 把 focusMessageId 置空，若高亮共用那个状态，用户看到的就是
   * 「跳到了但字没标出来」（2026-11-05 实测过）。
   */
  const keywordHighlight = externalFocus
    ? { messageId: externalFocus.messageId, keyword: externalFocus.keyword }
    : open && internalFocusId
      ? { messageId: internalFocusId, keyword: query.trim() }
      : null

  return {
    open,
    query,
    hits,
    activeIndex,
    // 外部定位优先：用户是从侧栏点进来的，刚落点就别被对话内搜索的旧状态盖掉
    focusMessageId: externalFocus?.messageId ?? internalFocusId,
    keywordHighlight,
    setQuery,
    step,
    close,
  }
}
