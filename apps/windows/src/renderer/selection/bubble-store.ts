/**
 * bubble-store.ts - 就地气泡的状态
 *
 * 为什么要有这个 store，而不是把气泡状态塞进 SelectionLayer 的 view：
 * **`api.close()` 会卸载整个 surface，而 `view` 里的东西跟着一起没**。任何一次
 * mousedown 都会关浮条（useSelectionWatcher 的既定行为），结果是「点别处 → 结果
 * 消失」，而用户此时正是要看结果。所以气泡的生命周期与浮条完全解耦：
 * 浮条该关就关，气泡自己做主，只有显式关闭或程序化跳转才收。
 *
 * 只有一个槽位：同一时刻只允许一个气泡（设计 §七 R6 的「同一时刻只允许一个
 * 请求在飞」在这里落实 —— 新请求先掐旧的，再顶掉槽位）。
 */

import { useSyncExternalStore } from 'react'
import type { SelectionLlmAction } from '../../shared/selection-llm-types'
import type { SnapshotRect } from './snapshot'
import { abortSelectionAction, runSelectionAction } from './selection-llm-service'

export interface SelectionBubbleState {
  requestId: string
  action: SelectionLlmAction
  /** 被处理的那段文字，气泡里做来源摘要用 */
  text: string
  /** 选中时算好的坐标；气泡定位只认它 */
  anchorRect: SnapshotRect
  status: 'pending' | 'done' | 'error'
  result?: string
  error?: string
}

let state: SelectionBubbleState | null = null
const listeners = new Set<() => void>()

/** 失败的气泡自己走：报错不需要用户手动关，但也不能永远挂着 */
const ERROR_AUTO_CLOSE_MS = 3200
let errorTimer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: SelectionBubbleState | null): void {
  state = next
  emit()
}

function clearErrorTimer(): void {
  if (errorTimer !== null) {
    clearTimeout(errorTimer)
    errorTimer = null
  }
}

/** 发新请求前先掐掉上一个：端点排队是实测瓶颈（设计 §八.1），不并发堆积 */
export function runSingleAction(
  action: SelectionLlmAction,
  text: string,
  anchorRect: SnapshotRect,
): void {
  clearErrorTimer()
  const previous = state
  if (previous && previous.status === 'pending') {
    void abortSelectionAction(previous.requestId)
  }

  const requestId = crypto.randomUUID()
  setState({
    requestId,
    action,
    text,
    anchorRect,
    status: 'pending',
  })

  void runSelectionAction(requestId, action, text).then((result) => {
    // 期间用户可能已经换了选区/关了气泡，那次响应就作废（requestId 不匹配即丢弃）
    if (state?.requestId !== requestId) return
    if (result.ok && typeof result.text === 'string') {
      setState({ ...state, status: 'done', result: result.text })
      return
    }
    setState({ ...state, status: 'error', error: result.error ?? '处理失败' })
    errorTimer = setTimeout(() => {
      // 定时器到点时若已经被顶掉，不动新气泡
      if (state?.requestId === requestId) closeBubble()
    }, ERROR_AUTO_CLOSE_MS)
  })
}

/** 关闭气泡。在飞的请求一并取消（「关闭即 abort」是设计 §5.4 的硬要求） */
export function closeBubble(): void {
  clearErrorTimer()
  const current = state
  if (!current) return
  state = null
  emit()
  if (current.status === 'pending') void abortSelectionAction(current.requestId)
}

export function getBubbleState(): SelectionBubbleState | null {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSelectionBubble(): SelectionBubbleState | null {
  return useSyncExternalStore(subscribe, getBubbleState, getBubbleState)
}
