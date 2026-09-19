/**
 * useWikiPage loading 并发计数
 *
 * 回归：进页时并发多个 wiki 命令，任一请求先返回不得提前收起加载态，
 * 否则 WikiTab 的 Loading 会反复显隐（用户反馈的「资料库页多次闪烁」）。
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWikiPage } from '../../renderer/hooks/business/useWikiPage'

describe('useWikiPage loading 并发计数', () => {
  let pending: Array<{ resolve: (value: unknown) => void }>
  let sendCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pending = []
    sendCommand = vi.fn(
      () =>
        new Promise((resolve) => {
          pending.push({ resolve })
        }),
    )
    ;(window as any).electronAPI = { agentRuntime: { sendCommand } }
  })

  it('先返回的请求不提前收起加载态，全部结束才关闭', async () => {
    const { result } = renderHook(() => useWikiPage())

    let inboxDone: Promise<unknown> | undefined
    let sourcesDone: Promise<unknown> | undefined
    act(() => {
      inboxDone = result.current.listInbox('pending')
      sourcesDone = result.current.listSources()
    })
    expect(sendCommand).toHaveBeenCalledTimes(2)
    expect(result.current.loading).toBe(true)

    await act(async () => {
      pending[0].resolve([])
      await inboxDone
    })
    // 仍有请求在飞：加载态必须保持
    expect(result.current.loading).toBe(true)

    await act(async () => {
      pending[1].resolve({ sources: [] })
      await sourcesDone
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('withLoading 包住的整段操作共享一次加载态', async () => {
    const { result } = renderHook(() => useWikiPage())

    let wrapped: Promise<unknown> | undefined
    act(() => {
      wrapped = result.current.withLoading(async () => {
        await result.current.listSources()
        await result.current.listSources()
      })
    })
    expect(result.current.loading).toBe(true)

    // 第一段 listSources 完成：外层仍持有加载态
    await act(async () => {
      pending[0].resolve({ sources: [] })
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(true)

    await act(async () => {
      pending[1].resolve({ sources: [] })
      await wrapped
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })
})
