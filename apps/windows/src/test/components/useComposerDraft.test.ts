/**
 * 对话输入框本地草稿 hook：IME 延迟同步、失焦 flush、切会话写回旧草稿
 */

import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useComposerDraft } from '../../renderer/pages/ChatPage/components/ChatInput/useComposerDraft'

describe('useComposerDraft', () => {
  it('普通输入只更新本地草稿，不立即通知父组件', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useComposerDraft({ value: '', onChange }),
    )

    act(() => {
      result.current.handleDraftChange('hello')
    })

    expect(result.current.innerValue).toBe('hello')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('失焦后把本地草稿一次性同步给父组件', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useComposerDraft({ value: '', onChange }),
    )

    act(() => {
      result.current.handleDraftChange('hello')
    })
    act(() => {
      result.current.handleBlur()
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('hello')
  })

  it('IME 组合期间不把中间拼音同步给父组件', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useComposerDraft({ value: '', onChange }),
    )

    act(() => {
      result.current.handleCompositionStart()
      result.current.handleDraftChange('ni')
      result.current.handleDraftChange('nihao')
    })

    expect(result.current.innerValue).toBe('nihao')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('IME 组合结束后把最终文案一次性同步给父组件', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() =>
      useComposerDraft({ value: '', onChange }),
    )

    act(() => {
      result.current.handleCompositionStart()
      result.current.handleDraftChange('nihao')
    })
    act(() => {
      result.current.handleCompositionEnd('你好')
    })

    expect(result.current.innerValue).toBe('你好')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('你好')
  })

  it('切换会话时把未同步的旧草稿写回对应 session', () => {
    const onChange = vi.fn()
    const onPersistDraft = vi.fn()
    const { result, rerender } = renderHook(
      (props: { sessionKey: string; value: string }) =>
        useComposerDraft({
          value: props.value,
          sessionKey: props.sessionKey,
          onChange,
          onPersistDraft,
        }),
      { initialProps: { sessionKey: 'session-a', value: '' } },
    )

    act(() => {
      result.current.handleDraftChange('draft-a')
    })

    rerender({ sessionKey: 'session-b', value: '' })

    expect(onPersistDraft).toHaveBeenCalledWith('session-a', 'draft-a')
    expect(result.current.innerValue).toBe('')
  })

  it('父组件外部写入（发送成功清空）会覆盖本地草稿', () => {
    const onChange = vi.fn()
    const { result, rerender } = renderHook(
      (props: { value: string }) => useComposerDraft({ value: props.value, onChange }),
      { initialProps: { value: '' } },
    )

    act(() => {
      result.current.handleDraftChange('hello')
      result.current.markFlushed('hello')
    })
    rerender({ value: '' })

    expect(result.current.innerValue).toBe('')
  })
})
