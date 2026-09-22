/**
 * SelectionLayer 渲染契约测试
 *
 * 本层挂过两次「只在渲染时才炸、tsc 看不出来」的错：
 * 1. 在定义之前使用某个 useCallback（暂时性死区）—— tsc 当普通变量用，照样通过；
 * 2. 右键菜单里点 L2 动作时，入口的 `close()` 顺手把刚创建的气泡也关了 ——
 *    发出去的请求当场被 abort，表现为「点翻译什么也没发生」。
 *
 * 所以这里**不 mock 任何自己的模块**：真 store、真组件、真事件链。
 * 只在 `window.electronAPI` 这一层拦出站 IPC —— 那是唯一的外部边界。
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { SelectionLayer } from './SelectionLayer'
import { closeBubble, getBubbleState } from './bubble-store'

const runSelection = vi.fn(async () => ({ ok: true, text: '译文结果' }))
const abortSelection = vi.fn(async () => true)

beforeEach(() => {
  vi.clearAllMocks()
  window.electronAPI = {
    selection: { run: runSelection, abort: abortSelection },
  } as unknown as typeof window.electronAPI
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  closeBubble()
})

/** 在 body 里造一段可选中的正文并设上选区 */
function selectSomeText(): void {
  const host = document.createElement('div')
  host.setAttribute('data-lumii-source', 'chat-message')
  host.setAttribute('data-lumii-role', 'assistant')
  const p = document.createElement('p')
  p.textContent = '这是一段足够长的被选中的正文，用来验证划词层。'
  host.appendChild(p)
  document.body.appendChild(host)

  const range = document.createRange()
  range.selectNodeContents(p)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

/**
 * 派发右键。
 *
 * 必须包 act：划词层是在 document 的**原生**监听里 setState 的，
 * 而 React 只对「自己派发的事件」自动批处理刷屏；原生 dispatchEvent 触发的更新
 * 在测试里不会自动提交，不包 act 的话断言时菜单还没画出来（假失败）。
 */
function openMenu(): void {
  act(() => {
    document.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 250 }),
    )
  })
}

/**
 * 菜单里的某一项。
 * 不能用文本查：气泡标题与菜单项会重名（都叫「翻译」），按类名查才不歧义。
 */
function menuItem(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(
      (el) => el.textContent?.trim() === label,
    ) ?? null
  )
}

describe('SelectionLayer 渲染契约', () => {
  it('挂载不抛错（守住「定义前使用」这类只在渲染时炸的问题）', () => {
    expect(() => render(<SelectionLayer />)).not.toThrow()
  })

  it('右键有选区时弹出自绘菜单，六项都在', () => {
    render(<SelectionLayer />)
    selectSomeText()
    openMenu()

    for (const label of ['引用', '复制', '翻译', '解释', '总结', '润色']) {
      expect(menuItem(label)).not.toBeNull()
    }
  })

  it('无选区时右键不弹菜单（让位给主进程的原生菜单）', () => {
    render(<SelectionLayer />)
    openMenu()

    expect(document.querySelector('.context-menu')).toBeNull()
  })

  it('菜单里点「翻译」：请求发出，且入口收起时没有顺手关掉气泡', async () => {
    render(<SelectionLayer />)
    selectSomeText()
    openMenu()

    act(() => menuItem('翻译')!.click())

    // 1. 请求真的发出去了
    await waitFor(() => expect(runSelection).toHaveBeenCalledTimes(1))
    const [request] = runSelection.mock.calls[0] as unknown as [{ action: string; text: string }]
    expect(request.action).toBe('translate')
    expect(request.text).toContain('被选中的正文')

    // 2. 关键判据：气泡被建起来了（曾经这里会被入口的 close 一起关掉）
    expect(getBubbleState()).not.toBeNull()
    // 3. 结果回来落到气泡上
    await waitFor(() => expect(getBubbleState()?.status).toBe('done'))
    expect(getBubbleState()?.result).toBe('译文结果')
    expect(document.querySelector('[data-selection-bubble]')).not.toBeNull()

    // 4. 菜单本身该收起（入口关，气泡留）
    expect(document.querySelector('.context-menu')).toBeNull()
  })
})
