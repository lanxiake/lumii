import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react'

export interface UseComposerDraftOptions {
  /** 父组件持有的当前会话草稿（外部写入：切会话、建议点击、发送成功清空） */
  value: string
  /** 当前会话 key；切换时把未 flush 的本地草稿写回旧会话 */
  sessionKey?: string | null
  /** 把当前会话草稿同步给父组件（失焦 / 组合结束 / 发送前） */
  onChange: (value: string) => void
  /** 按指定 sessionKey 写回草稿，避免切会话后写到新会话 */
  onPersistDraft?: (sessionKey: string | null, value: string) => void
}

export interface UseComposerDraftResult {
  /** 输入框立即展示的本地草稿 */
  innerValue: string
  innerValueRef: MutableRefObject<string>
  isComposingRef: MutableRefObject<boolean>
  /** 只更新本地草稿，不通知父组件 */
  setDraft: (next: string) => void
  /** 将本地草稿同步给当前会话的父状态（已同步则跳过） */
  flushDraft: (next: string) => void
  /** 标记已与父状态对齐（发送前调用，避免失败回写被清空） */
  markFlushed: (next: string) => void
  /** 按键输入：更新本地；IME 组合期间不 flush */
  handleDraftChange: (nextValue: string) => void
  handleCompositionStart: () => void
  /** 组合结束：写入最终文案并一次性 flush */
  handleCompositionEnd: (nextValue: string) => void
  /** 失焦时把未同步草稿交给父组件 */
  handleBlur: () => void
}

/**
 * 对话输入框本地草稿：打字只改本地 state，避免每个按键触发 ChatPage 重渲染。
 * IME 组合期间不把中间拼音同步给父组件，选词完成后再一次性 flush。
 */
export function useComposerDraft({
  value,
  sessionKey,
  onChange,
  onPersistDraft,
}: UseComposerDraftOptions): UseComposerDraftResult {
  const [innerValue, setInnerValue] = useState(value)
  const innerValueRef = useRef(value)
  const lastFlushedRef = useRef(value)
  const isComposingRef = useRef(false)
  const prevSessionKeyRef = useRef(sessionKey)
  const onChangeRef = useRef(onChange)
  const onPersistDraftRef = useRef(onPersistDraft)
  onChangeRef.current = onChange
  onPersistDraftRef.current = onPersistDraft
  innerValueRef.current = innerValue

  /**
   * 将草稿同步到父组件当前会话；值未变则跳过，避免无意义 setState。
   */
  const flushDraft = useCallback((next: string) => {
    if (next === lastFlushedRef.current) return
    lastFlushedRef.current = next
    onChangeRef.current(next)
  }, [])

  /**
   * 只更新本地展示草稿（不触发父组件渲染）。
   */
  const setDraft = useCallback((next: string) => {
    innerValueRef.current = next
    setInnerValue(next)
  }, [])

  /**
   * 标记本地与父草稿已对齐，但不调用 onChange。
   */
  const markFlushed = useCallback((next: string) => {
    lastFlushedRef.current = next
    if (value !== next && !isComposingRef.current) {
      innerValueRef.current = value
      setInnerValue(value)
      lastFlushedRef.current = value
    }
  }, [value])

  useLayoutEffect(() => {
    const prevKey = prevSessionKeyRef.current
    if (prevKey !== sessionKey) {
      const latest = innerValueRef.current
      if (latest !== lastFlushedRef.current) {
        onPersistDraftRef.current?.(prevKey ?? null, latest)
      }
      prevSessionKeyRef.current = sessionKey
      setInnerValue(value)
      innerValueRef.current = value
      lastFlushedRef.current = value
      return
    }
    if (isComposingRef.current) return
    if (value === lastFlushedRef.current) return
    setInnerValue(value)
    innerValueRef.current = value
    lastFlushedRef.current = value
  }, [sessionKey, value])

  // 卸载时把未 flush 草稿写回，避免切走页面丢失
  useEffect(() => {
    return () => {
      const latest = innerValueRef.current
      if (latest === lastFlushedRef.current) return
      const key = prevSessionKeyRef.current ?? null
      if (onPersistDraftRef.current) {
        onPersistDraftRef.current(key, latest)
      } else {
        onChangeRef.current(latest)
      }
    }
  }, [])

  /**
   * 输入变化：始终更新本地；组合态下延迟到 compositionend 再 flush。
   */
  const handleDraftChange = useCallback((nextValue: string) => {
    setDraft(nextValue)
  }, [setDraft])

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback((nextValue: string) => {
    isComposingRef.current = false
    setDraft(nextValue)
    flushDraft(nextValue)
  }, [setDraft, flushDraft])

  const handleBlur = useCallback(() => {
    if (isComposingRef.current) return
    flushDraft(innerValueRef.current)
  }, [flushDraft])

  return {
    innerValue,
    innerValueRef,
    isComposingRef,
    setDraft,
    flushDraft,
    markFlushed,
    handleDraftChange,
    handleCompositionStart,
    handleCompositionEnd,
    handleBlur,
  }
}
